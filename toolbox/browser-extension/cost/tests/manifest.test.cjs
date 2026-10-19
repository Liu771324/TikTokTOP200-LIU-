const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));

function extensionIdFromKey(key) {
  const digest = crypto.createHash("sha256").update(Buffer.from(key, "base64")).digest().subarray(0, 16);
  const alphabet = "abcdefghijklmnop";
  let result = "";
  for (const byte of digest) result += alphabet[byte >> 4] + alphabet[byte & 15];
  return result;
}

test("manifest uses the expected stable extension ID", () => {
  assert.equal(extensionIdFromKey(manifest.key), "kbdiohjlofljeafaddehaeciappaefka");
});

test("manifest permissions are limited to local storage and the local read-only API", () => {
  assert.deepEqual(manifest.permissions, ["storage"]);
  assert.deepEqual(manifest.host_permissions, ["http://127.0.0.1:8765/*"]);
  assert.equal(manifest.permissions.includes("cookies"), false);
  assert.equal(manifest.permissions.includes("downloads"), false);
  assert.equal(manifest.host_permissions.includes("<all_urls>"), false);
});

test("content scripts run on the activity-detail path family and verified edit path", () => {
  assert.deepEqual(manifest.content_scripts[0].matches, [
    "https://fxg.jinritemai.com/ffa/merchant/*-campaign-detail*",
    "https://fxg.jinritemai.com/ffa/g/create*"
  ]);
});

test("legacy management console and browser launcher are absent", () => {
  assert.equal(Object.hasOwn(manifest, "action"), false);
  assert.equal(Object.hasOwn(manifest, "options_ui"), false);
  for (const file of ["admin_core.js", "options.css", "options.html", "options.js"]) {
    assert.equal(fs.existsSync(path.join(root, file)), false, `${file} should be removed`);
  }
  const backgroundSource = fs.readFileSync(path.join(root, "background.js"), "utf8");
  assert.doesNotMatch(backgroundSource, /openOptionsPage|sendNativeMessage|nativeMessaging/i);
});

test("read-only extension source contains no platform write requests or credential access", () => {
  const runtimeSource = ["background.js", "content.js", "core.js", "panel.js"]
    .map((file) => fs.readFileSync(path.join(root, file), "utf8"))
    .join("\n");
  assert.doesNotMatch(runtimeSource, /document\.cookie|chrome\.cookies|localStorage|sessionStorage/);
  assert.doesNotMatch(runtimeSource, /method\s*:\s*["'](?:POST|PUT|PATCH|DELETE)["']/i);
  assert.doesNotMatch(runtimeSource, /\/api\/v1\/admin\//);
  assert.doesNotMatch(runtimeSource, /app_secret|access_token|refresh_token/i);
});
