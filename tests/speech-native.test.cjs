'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { mkdtempSync, rmSync } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
test('native delayed configuration and stale generation callbacks preserve current recording', { skip: process.platform !== 'darwin' || Number(os.release().split('.')[0]) < 25 }, () => {
  const root = path.resolve(__dirname, '..');
  const output = mkdtempSync(path.join(os.tmpdir(), 'labmate-native-speech-tests-'));
  try {
    const sdk = execFileSync('xcrun', ['--sdk', 'macosx', '--show-sdk-path'], { encoding: 'utf8' }).trim();
    const binary = path.join(output, 'speech-tests');
    execFileSync('xcrun', ['swiftc', '-parse-as-library', '-swift-version', '5', '-D', 'SPEECH_NATIVE_TESTS', '-module-cache-path', path.join(root, 'artifacts', 'swift-module-cache'), '-target', 'arm64-apple-macosx26.0', '-sdk', sdk, path.join(root, 'native/speech/main.swift'), path.join(root, 'native/speech/tests.swift'), '-o', binary], { timeout: 120000, stdio: 'pipe' });
    assert.match(execFileSync(binary, { encoding: 'utf8', timeout: 10000 }), /PASS native configuration and generation lifecycle/);
  } finally { rmSync(output, { recursive: true, force: true }); }
});
