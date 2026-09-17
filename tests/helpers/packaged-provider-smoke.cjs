'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const { fork } = require('node:child_process');

async function main() {
  const [asarPath, requestedRoot] = process.argv.slice(2);
  assert.ok(asarPath?.endsWith('app.asar'), 'packaged archive path is required');
  assert.ok(requestedRoot, 'disposable work root is required');
  const root = fs.realpathSync(requestedRoot);
  const packedRequire = createRequire(path.join(asarPath, 'package.json'));
  const providerModule = './electron/backend/cloud-process.cjs';
  assert.equal(packedRequire.resolve(providerModule), path.join(asarPath, 'electron/backend/cloud-process.cjs'));
  const { runCloudProcess, stageCloudBackup } = packedRequire(providerModule);
  const { runManagedBackup } = packedRequire('./electron/backend/backup-manager.cjs');
  const { readCatalog, digest } = packedRequire('./electron/backend/backup-catalog.cjs');
  const { LibraryStore } = packedRequire('./electron/backend/store.cjs');
  const expectedEntry = path.join(`${asarPath}.unpacked`, 'electron/backend/cloud-worker.cjs');
  assert.ok(fs.statSync(expectedEntry).isFile());
  const children = [];
  const realFork = (filename, args, options) => {
    assert.equal(filename, expectedEntry, 'provider must execute the unpacked packaged script');
    assert.equal(options.env.ELECTRON_RUN_AS_NODE, '1');
    const child = fork(filename, args, options);
    assert.ok(Number.isInteger(child.pid) && child.pid !== process.pid, 'provider must be a real separate process');
    children.push(child);
    return child;
  };
  const destination = path.join(root, 'synthetic-home', 'Library', 'CloudStorage', 'Box-Box', 'Backups');
  fs.mkdirSync(destination, { recursive: true });
  const libraryRoot = path.join(root, 'library');
  const store = new LibraryStore(libraryRoot);
  let staged;
  try {
    const created = store.dispatch('records.createNotebook', { name: 'Packaged provider fixture', description: 'Disposable files only', discipline: 'Chemistry', color: 'sage' });
    assert.equal(created.ok, true);
    const delivered = await runManagedBackup(store, { password: 'Disposable packaged provider fixture', destination, jobId: 'packaged-provider-delivery' }, {
      runDelivery: (payload, options) => {
        assert.equal(Object.hasOwn(payload, 'password'), false, 'provider must never receive credentials');
        return runCloudProcess(payload, { ...options, timeoutMs: 10_000, forkProcess: realFork });
      },
    });
    assert.equal(delivered.pendingDeliveryCount, 0, JSON.stringify(delivered));
    const catalog = readCatalog(libraryRoot);
    assert.equal(catalog.archives.length, 1);
    const archive = catalog.archives[0];
    const copy = archive.copies.find(item => item.directory === fs.realpathSync(destination));
    assert.ok(copy, 'verified destination must be recorded');
    const deliveredFile = path.join(copy.directory, copy.name);
    assert.equal(await digest(deliveredFile), archive.sha256);
    assert.equal(await digest(path.join(libraryRoot, 'backups', archive.name)), archive.sha256);

    staged = await stageCloudBackup(deliveredFile, { timeoutMs: 10_000, forkProcess: realFork });
    assert.notEqual(staged.source, deliveredFile);
    assert.match(staged.source, /labmate-incoming-/);
    assert.equal(await digest(staged.source), archive.sha256);
    await staged.cleanup();
    assert.equal(fs.existsSync(staged.source), false);
    assert.equal(fs.existsSync(deliveredFile), true, 'staging cleanup must preserve the original');
    assert.equal(store.snapshot().notebooks[0].name, 'Packaged provider fixture');
    assert.equal(children.length, 2);
    process.stdout.write(JSON.stringify({ delivered: true, staged: true, cleaned: true, childCount: children.length }) + '\n');
  } finally {
    await staged?.cleanup();
    for (const child of children) { try { child.kill('SIGKILL'); } catch {} }
    store.close();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
