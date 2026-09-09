import { packager } from '@electron/packager';
import { rebuild } from '@electron/rebuild';
import { execFileSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';

const iconSource = 'scripts/icon.swift';
const iconPath = 'artifacts/LabMate.icns';
const iconNeedsBuild = !existsSync(iconPath) || statSync(iconPath).mtimeMs < statSync(iconSource).mtimeMs;
if (iconNeedsBuild) {
  try {
    execFileSync('swift', [iconSource, 'artifacts/LabMate.iconset'], { stdio: 'inherit' });
    execFileSync('iconutil', ['-c', 'icns', 'artifacts/LabMate.iconset', '-o', iconPath], { stdio: 'inherit' });
  } catch (error) {
    if (!existsSync(iconPath)) throw error;
    console.warn('Icon regeneration failed; packaging with the existing generated LabMate.icns.');
  }
}

const paths = await packager({
  dir: '.',
  name: 'LabMate',
  executableName: 'LabMate',
  appBundleId: 'com.louishess.labmate',
  icon: iconPath,
  platform: 'darwin',
  arch: 'arm64',
  out: 'out',
  overwrite: true,
  // Native bindings must stay outside the archive so macOS can load and sign
  // them. Renderer assets (including the local PDF worker) remain in dist.
  asar: { unpack: '{**/better-sqlite3/prebuilds/darwin-arm64.node,**/electron/backend/parser.cjs}' },
  asarIntegrityDigest: true,
  prune: true,
  ignore: [/^\/(src|scripts|tests|artifacts|docs|shared|\.codex|\.git)(\/|$)/, /^\/(AGENTS\.md|README\.md|tsconfig\.json|vite\.config\.ts|index\.html|package-lock\.json)$/],
  // Rebuild only the packaged copy. The development install remains usable by
  // Node's test runner after packaging.
  afterCopy: [async ({ buildPath, electronVersion, arch }) => {
    await rebuild({
      buildPath,
      electronVersion,
      arch,
      force: true,
      onlyModules: ['better-sqlite3'],
    });
  }],
});
for (const outputPath of paths) console.log(path.join(outputPath, 'LabMate.app'));
