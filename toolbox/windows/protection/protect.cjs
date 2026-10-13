'use strict';
const fs = require('node:fs');
const path = require('node:path');
const JavaScriptObfuscator = require('javascript-obfuscator');
const [root, listFile] = process.argv.slice(2);
const files = JSON.parse(fs.readFileSync(listFile, 'utf8'));
for (const relative of files) {
  const file = path.resolve(root, relative);
  if (!file.startsWith(path.resolve(root) + path.sep)) throw Error('Build input escaped staging directory');
  const code = fs.readFileSync(file, 'utf8');
  const result = JavaScriptObfuscator.obfuscate(code, {
    target: relative.startsWith('toolbox/web/') ? 'browser-no-eval' : 'node',
    compact: true, identifierNamesGenerator: 'hexadecimal', seed: 42,
    renameGlobals: false, renameProperties: false, stringArray: false,
    controlFlowFlattening: false, deadCodeInjection: false, debugProtection: false,
    selfDefending: false, unicodeEscapeSequence: false, splitStrings: false,
    transformObjectKeys: false, numbersToExpressions: false, simplify: false,
    disableConsoleOutput: false, sourceMap: false,
  }).getObfuscatedCode();
  // Syntax checking is followed by adapter/browser-boundary regression before release.
  new (require('node:vm').Script)(result, { filename: relative });
  fs.writeFileSync(file, result, 'utf8');
}
process.stdout.write(JSON.stringify({processed: files.length, protection: 'basic-local-identifiers'}));
