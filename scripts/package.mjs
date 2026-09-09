import { packager } from '@electron/packager';
import { execFileSync } from 'node:child_process';

execFileSync('swift', ['scripts/icon.swift', 'artifacts/CustomELB.iconset'], { stdio: 'inherit' });
execFileSync('iconutil', ['-c', 'icns', 'artifacts/CustomELB.iconset', '-o', 'artifacts/CustomELB.icns'], { stdio: 'inherit' });

const paths = await packager({
  dir: '.',
  name: 'Custom ELB',
  executableName: 'Custom ELB',
  appBundleId: 'com.louishess.custom-elb',
  icon: 'artifacts/CustomELB.icns',
  platform: 'darwin',
  arch: 'arm64',
  out: 'out',
  overwrite: true,
  asar: true,
  prune: true,
  ignore: [/^\/(src|scripts|artifacts|\.git)(\/|$)/, /^\/(README\.md|tsconfig\.json|vite\.config\.ts|index\.html|package-lock\.json)$/],
  // React and icons are compiled into dist. No runtime Node dependencies are needed.
  afterPrune: [async ({ buildPath }) => {
    const { rm } = await import('node:fs/promises');
    await rm(`${buildPath}/node_modules`, { recursive: true, force: true });
  }],
});
for (const outputPath of paths) console.log(`${outputPath}/Custom ELB.app`);
