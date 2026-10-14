'use strict';

function accepts(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'www.douyin.com'
      && /^\/(?:$|video\/\d+\/?$|user\/|search(?:\/|$)|discover(?:\/|$)|jingxuan(?:\/|$))/.test(url.pathname);
  } catch { return false; }
}

async function captureItems(page) {
  return page.evaluate(() => {
    const clean = value => String(value || '').replace(/\s+/g, ' ').trim();
    const visible = node => node && node.getClientRects().length && getComputedStyle(node).visibility !== 'hidden';
    const found = new Map();
    const sourcePage = location.origin + location.pathname;
    const sourceLabel = location.pathname.startsWith('/user/') ? '抖音作者主页'
      : location.pathname.startsWith('/search') ? '抖音搜索' : location.pathname.startsWith('/video/') ? '抖音视频详情' : '抖音推荐';
    const text = (node, selector) => clean(node.querySelector(selector)?.textContent);
    function add(id, node) {
      if (!/^\d{10,30}$/.test(id || '') || found.has(id) || !visible(node)) return;
      const image = node.querySelector('[data-e2e*=cover] img') || Array.from(node.querySelectorAll('img'))
        .find(image => !image.closest('[data-e2e*=avatar], [class*=avatar], [class*=Avatar]'));
      const video = node.querySelector('video');
      const poster = node.querySelector('xg-poster, .xgplayer-poster');
      const background = poster && getComputedStyle(poster).backgroundImage.match(/^url\(["']?(.*?)["']?\)$/)?.[1];
      let title = text(node, '[data-e2e*=desc], [data-e2e*=caption], [data-e2e=video-title]')
        || clean(node.getAttribute('title') || image?.alt || node.querySelector('a[title]')?.title);
      if (title === '视频' || title === '播放') title = '';
      const authorName = (text(node, '[data-e2e*=author-name], [data-e2e=feed-video-nickname]')
        || text(node, 'a[href*="/user/"]')).replace(/^@/, '');
      const coverUrl = video?.poster || background || image?.currentSrc || image?.src || '';
      found.set(id, { sourceKey: `public:https://www.douyin.com/video/${id}`, sourceKind: 'public', sourcePage,
        providerId: id, title: title.slice(0, 2000) || `抖音视频 ${id}`, publicUrl: `https://www.douyin.com/video/${id}`,
        locator: { videoId: id }, details: { authorName: authorName.slice(0, 200), coverUrl, sourceLabel,
          titleKnown: Boolean(title), videoIndex: found.size + 1,
          duration: Number.isFinite(video?.duration) ? `${Math.floor(video.duration / 60)}:${String(Math.floor(video.duration % 60)).padStart(2, '0')}` : '' } });
    }
    for (const node of document.querySelectorAll('[data-e2e-vid], [data-video-id], [data-aweme-id]')) {
      if (node.querySelector('video') || node.matches('[data-e2e=feed-active-video]')) {
        add(node.getAttribute('data-e2e-vid') || node.getAttribute('data-video-id') || node.getAttribute('data-aweme-id'), node);
      }
    }
    for (const anchor of document.querySelectorAll('a[href*="/video/"]')) {
      let url;
      try { url = new URL(anchor.href); } catch { continue; }
      if (url.hostname !== 'www.douyin.com') continue;
      const id = url.pathname.match(/^\/video\/(\d+)\/?$/)?.[1];
      const node = anchor.closest('li, [data-e2e=search-card], [data-e2e=user-post-list-item]') || anchor;
      add(id, node);
    }
    const currentId = location.pathname.match(/^\/video\/(\d+)/)?.[1] || new URL(location.href).searchParams.get('modal_id');
    if (currentId && !found.has(currentId)) {
      const videos = Array.from(document.querySelectorAll('video')).filter(visible);
      if (videos.length === 1) add(currentId, videos[0].closest('[data-e2e-vid], [data-e2e=feed-active-video], [role=dialog]') || videos[0].parentElement.parentElement);
    }
    return Array.from(found.values());
  });
}

module.exports = { accepts, captureItems };
