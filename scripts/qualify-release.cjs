'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = process.cwd();
const binary = path.join(root, 'out/LabMate-darwin-arm64/LabMate.app/Contents/MacOS/LabMate');
const output = path.join(root, 'artifacts/release');
const identity = JSON.parse(fs.readFileSync(path.join(binary, '../../Resources/LabMate-release.json'), 'utf8'));
const env = { ...process.env, LABMATE_APP_BINARY: binary, LABMATE_REQUIRE_PACKAGE: '1' };
const checks = [
  ['backend', ['--test', ...fs.readdirSync('tests').filter(name => name.endsWith('.test.cjs')).map(name => 'tests/' + name)]],
  ...['ui', 'functional', 'tables', 'yield', 'material-yield', 'zotero', 'dictation', 'palettes', 'appearance', 'release', 'backup-lifecycle'].map(name => [name, ['scripts/check-' + name + (name === 'release' ? '.cjs' : '.mjs')]]),
];
const report = { version: identity.version, schema: identity.schema, commit: identity.commit, sourceHash: identity.sourceHash, startedAt: new Date().toISOString(), checks: [] };
for (const [name, args] of checks) {
  const filename = path.join(output, 'final-' + name + '.txt');
  const fd = fs.openSync(filename, 'w');
  const started = Date.now();
  console.log('Checking ' + name);
  let result;
  try { result = spawnSync(process.execPath, args, { cwd: root, env, stdio: ['ignore', fd, fd] }); }
  finally { fs.closeSync(fd); }
  report.checks.push({ name, passed: result.status === 0, elapsedMs: Date.now() - started, log: filename });
  fs.writeFileSync(path.join(output, 'qualification.json'), JSON.stringify(report, null, 2) + '\n');
  if (result.status !== 0) { console.error('FAILED ' + name + ': ' + filename); process.exitCode = 1; break; }
  console.log('PASS ' + name);
}
