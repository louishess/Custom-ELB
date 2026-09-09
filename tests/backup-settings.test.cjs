'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const main = require('../electron/main.cjs');
const preload = require('../electron/preload.cjs');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'labmate-backup-settings-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  const box = path.join(home, 'Library/CloudStorage/Box-Box');
  const destination = path.join(box, 'LabMate');
  fs.mkdirSync(destination, { recursive: true });
  let selected = destination;
  const opened = [];
  const appApi = { getPath: name => name === 'home' ? home : path.join(root, name) };
  const safeStorageApi = {
    isEncryptionAvailable: () => true,
    encryptString: value => Buffer.from(`encrypted:${value}`),
    decryptString: value => value.toString().replace(/^encrypted:/, ''),
  };
  const runtime = main.createBridgeRuntime({ root, appApi, safeStorageApi,
    dialogApi: { showOpenDialog: async () => selected === null ? { canceled: true } : { canceled: false, filePaths: [selected] } },
    shellApi: { openPath: async value => { opened.push(value); return ''; } },
    utilityProcessApi: { fork: () => ({ on() {}, postMessage() {}, kill() {} }) },
  });
  const frame = { url: 'elb://app/index.html' };
  const event = { senderFrame: frame, sender: { mainFrame: frame, getURL: () => frame.url } };
  const invoke = (method, payload) => runtime.handleInvoke(event, `backups.${method}`, payload);
  return { root, home, box, destination, runtime, invoke, opened, select: value => { selected = value; } };
}

test('backup folder operations reject renderer-supplied paths and retain saved credentials', async t => {
  const f = fixture(t);
  for (const method of ['changeDestination', 'revealDestination']) {
    assert.equal(preload.isAllowedMethod(`backups.${method}`), true);
    assert.equal(main.validateRendererPayload(`backups.${method}`, { destination: '/etc' }).ok, false);
  }
  assert.equal((await f.invoke('configure', { password: 'private secret' })).ok, true);
  const before = f.runtime.configStore.readRaw().value;
  f.runtime.configStore.recordBackupSuccess('2026-09-08T12:00:00.000Z');
  const second = path.join(f.box, 'Second');
  fs.mkdirSync(second);
  f.select(second);
  const changed = await f.invoke('changeDestination');
  assert.equal(changed.ok, true);
  assert.equal(changed.value.destinationAvailable, true);
  assert.equal(changed.value.lastBackupAt, undefined);
  assert.equal(f.runtime.configStore.readRaw().value.encryptedPassword, before.encryptedPassword);
  assert.equal(f.runtime.configStore.readUsable().value.password, 'private secret');
  assert.equal(JSON.stringify(changed).includes(second), false);
  assert.deepEqual(await f.invoke('revealDestination'), { ok: true, value: { opened: true } });
  assert.deepEqual(f.opened, [fs.realpathSync(second)]);
});

test('Box picker rejects outside folders, parent folders and symlink ancestor escapes', async t => {
  const f = fixture(t);
  for (const outside of [f.root, path.dirname(f.box)]) {
    f.select(outside);
    assert.equal((await f.invoke('configure', { password: 'pw' })).error.code, 'VALIDATION');
  }
  const outside = path.join(f.root, 'outside');
  fs.mkdirSync(path.join(outside, 'nested'), { recursive: true });
  fs.symlinkSync(outside, path.join(f.box, 'escape'));
  f.select(path.join(f.box, 'escape', 'nested'));
  assert.equal((await f.invoke('configure', { password: 'pw' })).error.code, 'VALIDATION');
  f.select(null);
  assert.equal((await f.invoke('configure', { password: 'pw' })).error.code, 'CANCELLED');
  assert.equal(f.runtime.configStore.readRaw().value, null);
});

test('unavailable destination preserves setup and failed automatic attempts across restart', async t => {
  const f = fixture(t);
  assert.equal((await f.invoke('configure', { password: 'pw' })).ok, true);
  fs.rmSync(f.destination, { recursive: true });
  f.runtime.startDailyBackup();
  await new Promise(resolve => setImmediate(resolve));
  f.runtime.stopDailyBackup();
  const status = await f.invoke('status');
  assert.equal(status.value.configured, true);
  assert.equal(status.value.destinationAvailable, false);
  assert.match(status.value.lastFailure.message, /unavailable/);
  assert.ok(Number.isFinite(Date.parse(status.value.lastAttemptAt)));
  const stored = JSON.parse(fs.readFileSync(f.runtime.configStore.filePath, 'utf8'));
  assert.deepEqual(stored.lastFailure, status.value.lastFailure);
  assert.equal((await f.invoke('revealDestination')).error.code, 'UNAVAILABLE');
  assert.equal(f.opened.length, 0);
  fs.mkdirSync(f.destination);
  assert.equal((await f.invoke('status')).value.destinationAvailable, true);
});

test('failed and cancelled jobs retain last success; verified success clears failure', async t => {
  const f = fixture(t);
  await f.invoke('configure', { password: 'pw' });
  const previous = '2026-09-08T12:00:00.000Z';
  f.runtime.configStore.recordBackupSuccess(previous);
  for (const code of ['IO', 'CANCELLED']) {
    f.runtime.worker = { request: async () => ({ ok: false, error: { code, message: code === 'IO' ? 'Copy failed' : 'Cancelled' } }) };
    assert.equal((await f.invoke('run', { jobId: `backup-${code}` })).error.code, code);
    const status = (await f.invoke('status')).value;
    assert.equal(status.lastBackupAt, previous);
    assert.equal(status.lastFailure.message, code === 'IO' ? 'Copy failed' : 'Cancelled');
    assert.equal(!!status.running, false);
  }
  const now = new Date().toISOString();
  f.runtime.worker = { request: async () => ({ ok: true, value: { createdAt: now, message: 'Verified local copy' } }) };
  const result = await f.invoke('run', { jobId: 'backup-success' });
  assert.equal(result.value.lastBackupAt, now);
  assert.equal(result.value.lastFailure, undefined);
});

test('original version 1 settings load and unknown fields fail closed', async t => {
  const f = fixture(t);
  await f.invoke('configure', { password: 'pw' });
  const stored = f.runtime.configStore.readRaw().value;
  assert.deepEqual(Object.keys(stored).sort(), ['destination', 'encryptedPassword', 'lastBackupAt', 'version']);
  assert.equal(f.runtime.configStore.readStatus().ok, true);
  fs.writeFileSync(f.runtime.configStore.filePath, JSON.stringify({ ...stored, unexpected: true }));
  assert.equal(f.runtime.configStore.readRaw().error.code, 'CORRUPT_BACKUP');
});

test('scheduled progress is visible and destination changes wait for active backup', async t => {
  const f = fixture(t);
  await f.invoke('configure', { password: 'pw' });
  const workerClient = f.runtime.worker;
  let finish;
  let started;
  const ready = new Promise(resolve => { started = resolve; });
  f.runtime.worker = { request: async (_method, payload) => {
    workerClient.handleMessage({ event: 'progress', value: { jobId: payload.jobId, operation: 'backup', phase: 'copy', completed: 1, total: 2, message: 'Verifying local destination' } });
    started();
    return new Promise(resolve => { finish = resolve; });
  } };
  const operation = f.invoke('run', { jobId: 'backup-progress' });
  await ready;
  const status = (await f.invoke('status')).value;
  assert.equal(status.running, true);
  assert.equal(status.progress.jobId, 'backup-progress');
  assert.equal(status.progress.completed, 1);
  assert.equal((await f.invoke('changeDestination')).error.code, 'UNAVAILABLE');
  finish({ ok: true, value: { createdAt: new Date().toISOString() } });
  await operation;
  const completed = (await f.invoke('status')).value;
  assert.equal(completed.progress, undefined);
  assert.equal(!!completed.running, false);
});
