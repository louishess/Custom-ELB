'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const { extractFile, listPackage, statFile } = require('@electron/asar');

const projectRoot = path.resolve(__dirname, '..');
const appRoot = path.join(projectRoot, 'out', 'LabMate-darwin-arm64', 'LabMate.app');
const resourcesRoot = path.join(appRoot, 'Contents', 'Resources');
const asarPath = path.join(resourcesRoot, 'app.asar');
const binaryPath = path.join(appRoot, 'Contents', 'MacOS', 'LabMate');
const packageRequired = process.env.LABMATE_REQUIRE_PACKAGE === '1';
const expectedVersion = require(path.join(projectRoot, 'package.json')).version;

function packageIsCurrent() {
  if (!fs.existsSync(asarPath)) return false;
  try {
    const packagedManifest = JSON.parse(extractFile(asarPath, 'package.json').toString('utf8'));
    return packagedManifest.version === expectedVersion;
  } catch {
    return false;
  }
}

function packageTest(name, fn) {
  const current = packageIsCurrent();
  return test(name, { skip: !current && !packageRequired ? 'package the current app to run this integration check' : false }, fn);
}

packageTest('packaged app contains backend processes, local PDF worker, and unpacked native SQLite', () => {
  assert.ok(fs.existsSync(asarPath), `missing packaged archive: ${asarPath}`);
  assert.ok(fs.existsSync(binaryPath), `missing packaged executable: ${binaryPath}`);

  for (const runtimeFile of [
    'electron/main.cjs',
    'electron/preload.cjs',
    'electron/backend/worker.cjs',
    'electron/backend/store.cjs',
    'electron/backend/backup.cjs',
    'electron/backend/files.cjs',
    'electron/backend/parser.cjs',
    'electron/backend/exports.cjs',
  ]) {
    assert.doesNotThrow(() => statFile(asarPath, runtimeFile), `${runtimeFile} is not packaged`);
  }

  const files = listPackage(asarPath, { isPack: false });
  assert.ok(
    files.some(file => /^\/dist\/assets\/pdf\.worker\.min-[^/]+\.mjs$/.test(file)),
    'Vite did not package the local PDF worker',
  );
  assert.ok(
    fs.existsSync(path.join(resourcesRoot, 'app.asar.unpacked', 'node_modules', 'better-sqlite3', 'prebuilds', 'darwin-arm64.node')),
    'better-sqlite3 arm64 binding was not unpacked',
  );
  assert.ok(
    fs.existsSync(path.join(resourcesRoot, 'app.asar.unpacked', 'electron', 'backend', 'parser.cjs')),
    'isolated spreadsheet parser was not unpacked for child-process execution',
  );
});

packageTest('packaged Electron verifies SQLite and encrypted library backup/restore with attachments', t => {
  const workRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'labmate-packaged-db-'));
  t.after(() => fs.rmSync(workRoot, { recursive: true, force: true }));
  const helper = path.join(__dirname, 'helpers', 'packaged-database-smoke.cjs');
  const result = spawnSync(binaryPath, [helper, asarPath, workRoot], {
    encoding: 'utf8',
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    timeout: 30_000,
  });
  assert.equal(result.signal, null, `packaged database check timed out: ${result.stderr}`);
  assert.equal(result.status, 0, `packaged database check failed:\n${result.stdout}\n${result.stderr}`);
});
