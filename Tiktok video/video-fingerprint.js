'use strict';

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('playwright-core');
const { findEdgePath } = require('./edge');
const { VIDEO_DIR } = require('./task-store');

const SAMPLE_INTERVAL_SECONDS = 1;
const FRAME_DISTANCE_LIMIT = 12;
const OPENING_FRAME_DISTANCE_LIMIT = 16;
const OPENING_SAMPLE_COUNT = 5;
const MIN_SAMPLES = 12;
const BIT_COUNTS = [0, 1, 1, 2, 1, 2, 2, 3, 1, 2, 2, 3, 2, 3, 3, 4];

function fileFromVideoDirectory(relativePath) {
  if (typeof relativePath !== 'string' || !relativePath) return null;
  const root = path.resolve(VIDEO_DIR);
  const file = path.resolve(root, relativePath);
  return file.startsWith(`${root}${path.sep}`) ? file : null;
}

function startMediaServer() {
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    if (url.pathname === '/') {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      response.end('<!doctype html><meta charset="utf-8"><title>Video fingerprint</title>');
      return;
    }
    if (!['GET', 'HEAD'].includes(request.method) || url.pathname !== '/video') {
      response.writeHead(404).end();
      return;
    }
    const file = fileFromVideoDirectory(url.searchParams.get('path'));
    if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      response.writeHead(404).end();
      return;
    }
    const size = fs.statSync(file).size;
    let start = 0;
    let end = size - 1;
    let statusCode = 200;
    const range = request.headers.range?.match(/^bytes=(\d*)-(\d*)$/);
    if (range) {
      if (!range[1] && !range[2]) {
        response.writeHead(416, { 'Content-Range': `bytes */${size}` }).end();
        return;
      }
      if (!range[1]) {
        const suffix = Number(range[2]);
        start = Math.max(0, size - suffix);
      } else {
        start = Number(range[1]);
        end = range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
      }
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= size || end < start) {
        response.writeHead(416, { 'Content-Range': `bytes */${size}` }).end();
        return;
      }
      statusCode = 206;
    }
    const headers = {
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-store',
      'Content-Length': end - start + 1,
      'Content-Type': 'video/mp4',
    };
    if (statusCode === 206) headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
    response.writeHead(statusCode, headers);
    if (request.method === 'HEAD') {
      response.end();
      return;
    }
    const stream = fs.createReadStream(file, { start, end });
    response.once('close', () => stream.destroy());
    stream.once('error', () => response.destroy());
    stream.pipe(response);
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve({ server, origin: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

async function createVideoFingerprinter() {
  const { server, origin } = await startMediaServer();
  let browser;
  try {
    const edgePath = findEdgePath();
    if (!edgePath) throw new Error('找不到 Microsoft Edge，无法进行视觉去重');
    browser = await chromium.launch({ headless: true, executablePath: edgePath });
    const page = await browser.newPage();
    await page.goto(origin, { waitUntil: 'load', timeout: 10000 });
    return {
      async fingerprintFile(file) {
        const relativePath = path.relative(VIDEO_DIR, file);
        const url = `${origin}/video?path=${encodeURIComponent(relativePath)}`;
        return page.evaluate(async ({ videoUrl, sampleInterval }) => {
          const video = document.createElement('video');
          video.muted = true;
          video.preload = 'auto';
          video.playsInline = true;
          const metadata = new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('读取视频时长超时')), 20000);
            video.addEventListener('loadedmetadata', () => { clearTimeout(timer); resolve(); }, { once: true });
            video.addEventListener('error', () => { clearTimeout(timer); reject(new Error('浏览器无法解码此 MP4')); }, { once: true });
          });
          video.src = videoUrl;
          video.load();
          try {
            await metadata;
            if (!Number.isFinite(video.duration) || video.duration <= 0) throw new Error('视频时长无效');
            const canvas = document.createElement('canvas');
            canvas.width = 9;
            canvas.height = 8;
            const context = canvas.getContext('2d', { willReadFrequently: true });
            const frames = [];
            for (let time = 0.5; time < video.duration; time += sampleInterval) {
              await new Promise((resolve, reject) => {
                const timer = setTimeout(() => reject(new Error(`定位视频 ${time.toFixed(1)} 秒超时`)), 5000);
                video.addEventListener('seeked', () => { clearTimeout(timer); resolve(); }, { once: true });
                video.currentTime = time;
              });
              context.drawImage(video, 0, 0, canvas.width, canvas.height);
              const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
              let hash = 0n;
              for (let y = 0; y < canvas.height; y += 1) {
                for (let x = 0; x < canvas.width - 1; x += 1) {
                  const left = (y * canvas.width + x) * 4;
                  const right = left + 4;
                  const leftGray = pixels[left] * 0.299 + pixels[left + 1] * 0.587 + pixels[left + 2] * 0.114;
                  const rightGray = pixels[right] * 0.299 + pixels[right + 1] * 0.587 + pixels[right + 2] * 0.114;
                  hash = (hash << 1n) | BigInt(leftGray > rightGray ? 1 : 0);
                }
              }
              frames.push(hash.toString(16).padStart(16, '0'));
            }
            return { duration: video.duration, frames };
          } finally {
            video.pause();
            video.removeAttribute('src');
            video.load();
          }
        }, { videoUrl: url, sampleInterval: SAMPLE_INTERVAL_SECONDS });
      },
      async close() {
        await browser.close().catch(() => {});
        await new Promise((resolve) => server.close(resolve));
      },
    };
  } catch (error) {
    await browser?.close().catch(() => {});
    await new Promise((resolve) => server.close(resolve));
    throw error;
  }
}

function frameDistance(left, right, limit = FRAME_DISTANCE_LIMIT) {
  let count = 0;
  for (let index = 0; index < 16; index += 1) {
    count += BIT_COUNTS[parseInt(left[index], 16) ^ parseInt(right[index], 16)];
    if (count > limit) return count;
  }
  return count;
}

function visualOverlapPercent(left, right) {
  if (!Array.isArray(left?.frames) || !Array.isArray(right?.frames)) return 0;
  const leftFrames = left.frames;
  const rightFrames = right.frames;
  const longest = Math.max(leftFrames.length, rightFrames.length);
  if (longest < MIN_SAMPLES) return 0;
  let previous = new Uint16Array(rightFrames.length + 1);
  for (let leftIndex = 1; leftIndex <= leftFrames.length; leftIndex += 1) {
    const current = new Uint16Array(rightFrames.length + 1);
    let diagonal = 0;
    for (let rightIndex = 1; rightIndex <= rightFrames.length; rightIndex += 1) {
      const above = previous[rightIndex];
      if (frameDistance(leftFrames[leftIndex - 1], rightFrames[rightIndex - 1]) <= FRAME_DISTANCE_LIMIT) {
        current[rightIndex] = diagonal + 1;
      } else {
        current[rightIndex] = Math.max(above, current[rightIndex - 1]);
      }
      diagonal = above;
    }
    previous = current;
  }
  return Math.round((previous[rightFrames.length] / Math.min(leftFrames.length, rightFrames.length)) * 100);
}

function openingSubjectOverlapPercent(left, right) {
  if (!Array.isArray(left?.frames) || !Array.isArray(right?.frames)) return 0;
  const leftFrames = left.frames.slice(0, OPENING_SAMPLE_COUNT);
  const rightFrames = right.frames.slice(0, OPENING_SAMPLE_COUNT);
  if (!leftFrames.length || !rightFrames.length) return 0;
  let previous = new Uint8Array(rightFrames.length + 1);
  for (let leftIndex = 1; leftIndex <= leftFrames.length; leftIndex += 1) {
    const current = new Uint8Array(rightFrames.length + 1);
    let diagonal = 0;
    for (let rightIndex = 1; rightIndex <= rightFrames.length; rightIndex += 1) {
      const above = previous[rightIndex];
      if (frameDistance(leftFrames[leftIndex - 1], rightFrames[rightIndex - 1], OPENING_FRAME_DISTANCE_LIMIT) <= OPENING_FRAME_DISTANCE_LIMIT) {
        current[rightIndex] = diagonal + 1;
      } else {
        current[rightIndex] = Math.max(above, current[rightIndex - 1]);
      }
      diagonal = above;
    }
    previous = current;
  }
  return Math.round((previous[rightFrames.length] / Math.min(leftFrames.length, rightFrames.length)) * 100);
}

module.exports = { createVideoFingerprinter, visualOverlapPercent, openingSubjectOverlapPercent };
