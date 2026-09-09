'use strict';
// Opt-in real SpeechAnalyzer integration against locally synthesized audio. Never opens a microphone.
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const output = mkdtempSync(path.join(os.tmpdir(), 'labmate-speech-audio-'));
try {
  const sdk = execFileSync('xcrun', ['--sdk', 'macosx', '--show-sdk-path'], { encoding: 'utf8' }).trim();
  const binary = path.join(output, 'speech-audio-tests');
  execFileSync('xcrun', ['swiftc', '-parse-as-library', '-swift-version', '5', '-D', 'SPEECH_NATIVE_TESTS', '-module-cache-path', path.join(root, 'artifacts', 'swift-module-cache'), '-target', 'arm64-apple-macosx26.0', '-sdk', sdk, path.join(root, 'native/speech/main.swift'), path.join(root, 'native/speech/tests.swift'), '-o', binary], { timeout: 120000, stdio: 'pipe' });
  const file = path.join(output, 'synthetic.aiff');
  const sentence = 'The reaction produced seventy five percent yield. The sample is ready for analysis.';
  execFileSync('/usr/bin/say', ['-v', 'Samantha', '-r', '145', '-o', file, sentence], { timeout: 30000 });
  const transcript = execFileSync(binary, ['--transcribe-file', file], { encoding: 'utf8', timeout: 60000 });
  assert.match(transcript, /reaction/i);
  assert.match(transcript, /yield/i);
  assert.match(transcript, /sample.*ready.*analysis/i);
  const artifact = path.join(root, 'artifacts', 'dictation');
  mkdirSync(artifact, { recursive: true });
  writeFileSync(path.join(artifact, 'native-synthetic-audio.json'), JSON.stringify({ checkedAt: new Date().toISOString(), source: 'Local macOS text to speech; synthetic fixture', microphone: 'Not accessed', expected: sentence, transcript: transcript.trim(), result: 'pass' }, null, 2));
  console.log(transcript.trim());
  console.log('PASS real on-device recognition of synthetic audio; microphone not accessed');
} finally { rmSync(output, { recursive: true, force: true }); }
