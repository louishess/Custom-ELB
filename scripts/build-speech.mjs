import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function buildSpeechHelper() {
  if (process.platform !== 'darwin') throw new Error('The dictation helper must be built on macOS with the macOS 26 SDK.');
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const bundle = path.join(root, 'artifacts', 'LabMate Speech.app');
  const contents = path.join(bundle, 'Contents');
  mkdirSync(path.join(contents, 'MacOS'), { recursive: true });
  const sdk = execFileSync('xcrun', ['--sdk', 'macosx', '--show-sdk-path'], { encoding: 'utf8' }).trim();
  execFileSync('xcrun', ['swiftc', '-parse-as-library', '-swift-version', '5', '-module-cache-path', path.join(root, 'artifacts', 'swift-module-cache'), '-O', '-target', 'arm64-apple-macosx26.0', '-sdk', sdk, path.join(root, 'native/speech/main.swift'), '-o', path.join(contents, 'MacOS', 'LabMate Speech')], { stdio: 'inherit' });
  writeFileSync(path.join(contents, 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>com.louishess.labmate.speech</string>
<key>CFBundleName</key><string>LabMate Speech</string>
<key>CFBundleExecutable</key><string>LabMate Speech</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleVersion</key><string>1</string>
<key>LSMinimumSystemVersion</key><string>26.0</string>
<key>LSUIElement</key><true/>
<key>NSMicrophoneUsageDescription</key><string>LabMate uses the microphone only when you start dictation. Speech is transcribed on this Mac and audio is not saved.</string>
</dict></plist>\n`);
  const entitlements = path.join(root, 'native', 'speech', 'entitlements.plist');
  execFileSync('codesign', ['--force', '--sign', '-', '--entitlements', entitlements, bundle], { stdio: 'inherit' });
  return bundle;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) console.log(buildSpeechHelper());
