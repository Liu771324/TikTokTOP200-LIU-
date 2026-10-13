'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function fail(code, message) { return Object.assign(new Error(message), { code }); }

function readState(context) {
  if (!fs.existsSync(context.statePath)) return null;
  try {
    const envelope = JSON.parse(fs.readFileSync(context.statePath, 'utf8'));
    if (envelope.formatVersion !== 1 || envelope.toolId !== context.toolId || envelope.taskId !== context.taskId
        || !Number.isInteger(envelope.attempt) || envelope.attempt < 1 || envelope.attempt > context.attempt || !envelope.state || typeof envelope.state !== 'object' || Array.isArray(envelope.state)) throw new Error();
    return envelope.state;
  } catch { throw fail('STATE_CORRUPT', '任务检查点损坏，请保留结果并新建任务。'); }
}

function paginate(items, parameters) {
  const offset = parameters.offset ?? 0, limit = parameters.limit ?? 50;
  if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 200) throw fail('INVALID_PARAMETERS', '结果分页参数无效。');
  return { items: items.slice(offset, offset + limit), total: items.length };
}

async function ensureReady(page, engine, api, canWait = true) {
  let issue = await engine.blockingIssue(page);
  while (issue) {
    if (!canWait) throw fail(/验证/.test(issue) ? 'VERIFICATION_REQUIRED' : 'LOGIN_REQUIRED', issue);
    await api.waitForUser(issue);
    issue = await engine.blockingIssue(page);
  }
}

async function candidateFromPlayer(page, player, context, engine, api) {
  fs.mkdirSync(context.artifactStagingRoot, { recursive: true });
  fs.mkdirSync(context.scratchRoot, { recursive: true });
  const work = fs.mkdtempSync(path.join(context.scratchRoot, 'compass-'));
  const target = path.join(context.artifactStagingRoot, `${crypto.randomUUID()}.mp4`);
  let produced = false;
  try {
    const video = path.join(work, 'video.part'), audio = path.join(work, 'audio.part');
    await engine.downloadMedia(page, player.videoUrl, video, 'video/');
    await api.boundary();
    if (player.audioUrl) {
      await engine.downloadMedia(page, player.audioUrl, audio, 'audio/');
      await engine.runFfmpeg(['-i', video, '-i', audio, '-map', '0:v:0', '-map', '1:a:0'], target, '合并');
    } else if (engine.isMp4(video)) {
      fs.copyFileSync(video, target, fs.constants.COPYFILE_EXCL);
    } else {
      await engine.runFfmpeg(['-i', video], target, '封装');
    }
    produced = true;
    await api.boundary();
    return target;
  } catch (error) {
    if (produced) fs.rmSync(target, { force: true });
    throw error;
  } finally { fs.rmSync(work, { recursive: true, force: true }); }
}

function candidatePath(context, file) {
  const relative = path.relative(context.dataRoot, file);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw fail('INVALID_PARAMETERS', '候选文件不属于当前数据目录。');
  return relative.split(path.sep).join('/');
}

module.exports = { fail, readState, paginate, ensureReady, candidateFromPlayer, candidatePath };
