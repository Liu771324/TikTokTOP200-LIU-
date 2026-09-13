const fs = require('node:fs');

function stopRequested(stopFile) {
  return !!stopFile && fs.existsSync(stopFile);
}

async function waitWhilePaused({ pauseFile, stopFile, wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }) {
  while (fs.existsSync(pauseFile)) {
    if (stopRequested(stopFile)) return true;
    await wait(1000);
  }
  return stopRequested(stopFile);
}

module.exports = { stopRequested, waitWhilePaused };
