'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { Worker } = require('node:worker_threads');

const main = require('../electron/main.cjs');
const worker = require('../electron/backend/worker.cjs');

const UUID = '550e8400-e29b-41d4-a716-446655440000';

function frameEvent({ frameUrl = 'elb://app/index.html', top = true, senderUrl = frameUrl } = {}) {
  const frame = { url: frameUrl };
  const sender = {
    id: 12,
    mainFrame: top ? frame : { url: 'elb://app/index.html' },
    getURL: () => senderUrl,
  };
  return { sender, senderFrame: frame };
}

function transport() {
  const messages = [];
  const listeners = new Map();
  return {
    messages,
    postMessage(message) { messages.push(message); },
    on(name, listener) { listeners.set(name, listener); },
    emit(name, message) { listeners.get(name)?.(message); },
  };
}

function fakeServices() {
  const calls = [];
  let backupStarted;
  let releaseBackup;
  const backupReady = new Promise(resolve => { backupStarted = resolve; });
  const services = {
    calls,
    backupReady,
    releaseBackup: () => releaseBackup?.(),
    store: {
      snapshot: () => ({ schemaVersion: 1, notebooks: [], experiments: [], runs: [], attachments: [], schemes: [], preferences: {} }),
      dispatch(method) { calls.push(method); return { schemaVersion: 1, notebooks: [], experiments: [], runs: [], attachments: [], schemes: [], preferences: {} }; },
      close() { calls.push('close'); },
    },
    fileService: {
      importFiles: async (_input, context) => { context.onProgress?.({ phase: 'complete', completed: 1, total: 1 }); return { imported: true }; },
      preview: async () => ({ kind: 'unsupported', message: 'test' }),
      getPath: () => '/tmp/managed-file',
      update: () => ({ updated: true }),
      remove: () => ({ removed: true }),
    },
    exportService: { write: async () => ({ cancelled: false, name: 'out.md', warnings: [] }) },
    backupService: {
      create: (_input, context) => {
        backupStarted();
        return new Promise((resolve, reject) => {
          releaseBackup = () => resolve({ name: 'backup', createdAt: new Date().toISOString() });
          context.signal.addEventListener('abort', () => {
            const error = new Error('cancelled');
            error.code = 'CANCELLED';
            reject(error);
          }, { once: true });
        });
      },
      restore: async () => ({ schemaVersion: 1 }),
    },
  };
  return services;
}

test('preload/main allowlist rejects renderer paths and unsafe requesting frames', () => {
  assert.equal(main.PUBLIC_METHODS.has('records.snapshot'), true);
  assert.equal(main.PUBLIC_METHODS.has('filesystem.read'), false);
  const valid = main.validateRendererPayload('attachments.import', { runId: UUID, jobId: 'job-1' });
  assert.equal(valid.ok, true);
  const pathAttempt = main.validateRendererPayload('attachments.import', { runId: UUID, jobId: 'job-1', paths: ['/etc/passwd'] });
  assert.equal(pathAttempt.ok, false);
  assert.equal(main.validateRendererPayload('schemes.create', { notebookId: UUID, name: 'Route', description: '', runIds: [UUID] }).ok, true);
  assert.equal(main.isAllowedTopFrame(frameEvent()), true);
  assert.equal(main.isAllowedTopFrame(frameEvent({ top: false })), false);
  assert.equal(main.isAllowedTopFrame(frameEvent({ frameUrl: 'https://example.test/index.html', senderUrl: 'https://example.test/index.html' })), false);
  assert.equal(main.isAllowedResourceURL('blob:elb://app/index.html'), true);
  assert.equal(main.isAllowedResourceURL('blob:https://example.test/id'), false);
  assert.equal(main.isAllowedResourceURL('https://example.test'), false);
});

test('test profile is applied before config construction and Box defaults are detected', () => {
  const calls = [];
  const paths = { userData: '/tmp/user-data', sessionData: '/tmp/session-data', home: '/Users/tester' };
  const appApi = {
    setPath(name, value) { calls.push([name, value]); paths[name] = value; },
    getPath(name) { return paths[name]; },
  };
  const profile = main.configureTestProfile(appApi, { LABMATE_LIBRARY_ROOT: '/tmp/disposable-library' });
  assert.equal(profile, '/tmp/disposable-library/profile');
  assert.deepEqual(calls, [
    ['userData', '/tmp/disposable-library/profile'],
    ['sessionData', '/tmp/disposable-library/profile/session'],
  ]);
  assert.equal(new main.LocalConfigStore({ appApi, safeStorageApi: {} }).filePath, '/tmp/disposable-library/profile/labmate-config.json');
  const fakeFs = { statSync(candidate) { return { isDirectory: () => candidate.endsWith('Box-Box') }; } };
  assert.deepEqual(main.detectBoxDrivePaths('/Users/tester', fakeFs), ['/Users/tester/Library/CloudStorage/Box-Box']);
});

test('close flush replies are matched to webContents IDs, even when BrowserWindow IDs differ', async () => {
  let closeRequest;
  const frame = { url: 'elb://app/index.html' };
  const sender = { id: 77, mainFrame: frame, getURL: () => frame.url };
  const event = { sender, senderFrame: frame };
  const webContents = {
    id: 77,
    send(channel, requestId) {
      if (channel === main.CLOSE_REQUEST_CHANNEL) {
        closeRequest = requestId;
        runtime.receiveCloseResult(event, requestId, true);
      }
    },
  };
  const window = { id: 12, webContents };
  const runtime = main.createBridgeRuntime({
    BrowserWindowApi: { fromWebContents: () => window, getAllWindows: () => [window] },
    appApi: { getPath: name => name === 'cache' ? '/tmp/labmate-close-cache' : '/tmp/labmate-user-data' },
    utilityProcessApi: { fork: () => ({ on() {}, postMessage() {}, kill() {} }) },
    closeTimeoutMs: 100,
  });
  runtime.registerCloseListener(event);
  assert.equal(await runtime.requestRendererFlush(window), true);
  assert.equal(typeof closeRequest, 'string');
});

test('restore flushes before its picker and accepts the native .labmatebackup extension', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'labmate-restore-'));
  const source = path.join(root, 'selected.labmatebackup');
  fs.writeFileSync(source, 'disposable backup');
  const frame = { url: 'elb://app/index.html' };
  const sender = { id: 77, mainFrame: frame, getURL: () => frame.url };
  const event = { sender, senderFrame: frame };
  let runtime;
  const order = [];
  const webContents = {
    id: 77,
    send(channel, requestId) {
      if (channel === main.CLOSE_REQUEST_CHANNEL) {
        order.push('flush');
        runtime.receiveCloseResult(event, requestId, true);
      }
    },
  };
  const window = { id: 12, webContents };
  const dialogApi = {
    showOpenDialog: async (_target, options) => {
      order.push('picker');
      assert.deepEqual(options.filters[0].extensions, ['labmatebackup', 'labmate', 'backup', 'zip']);
      return { canceled: true, filePaths: [] };
    },
    showMessageBox: async () => {
      order.push('confirmation');
      return { response: 1 };
    },
  };
  runtime = main.createBridgeRuntime({
    root,
    appApi: { getPath: name => name === 'cache' ? path.join(root, 'cache') : path.join(root, 'profile') },
    BrowserWindowApi: { fromWebContents: () => window, getAllWindows: () => [window] },
    dialogApi,
    utilityProcessApi: { fork: () => ({ on() {}, postMessage() {}, kill() {} }) },
    closeTimeoutMs: 100,
  });
  runtime.worker = { request: async () => { order.push('worker'); return { ok: true, value: { schemaVersion: 1 } }; } };
  runtime.registerCloseListener(event);
  const result = await runtime.handleInvoke(event, 'backups.restore', { password: 'pw', jobId: 'restore-1' });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'CANCELLED');
  assert.deepEqual(order, ['flush', 'picker']);
  fs.rmSync(root, { recursive: true, force: true });
});

test('daily backup catches up once when due and stays idle after a same-day success', async () => {
  const secureStorage = {
    isEncryptionAvailable: () => true,
    encryptString: value => Buffer.from(`encrypted:${value}`),
    decryptString: value => value.toString().replace(/^encrypted:/, ''),
  };
  const makeRuntime = root => {
    const destination = path.join(root, 'Box-Box');
    fs.mkdirSync(destination, { recursive: true });
    const appApi = { getPath: name => name === 'cache' ? path.join(root, 'cache') : path.join(root, 'profile') };
    const runtime = main.createBridgeRuntime({
      root,
      appApi,
      safeStorageApi: secureStorage,
      utilityProcessApi: { fork: () => ({ on() {}, postMessage() {}, kill() {} }) },
    });
    assert.equal(runtime.configStore.configure(destination, 'pw').ok, true);
    return runtime;
  };

  const dueRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'labmate-daily-due-'));
  const dueRuntime = makeRuntime(dueRoot);
  const dueCalls = [];
  dueRuntime.worker = {
    request: async (method, payload) => {
      dueCalls.push({ method, payload });
      return { ok: true, value: { name: 'backup.labmatebackup', createdAt: new Date().toISOString(), message: 'verified' } };
    },
  };
  dueRuntime.startDailyBackup();
  await new Promise(resolve => setImmediate(resolve));
  dueRuntime.stopDailyBackup();
  assert.equal(dueCalls.length, 1);
  assert.equal(dueCalls[0].method, 'backups.run');
  assert.equal(typeof dueCalls[0].payload.password, 'string');
  assert.equal(typeof dueCalls[0].payload.destination, 'string');
  fs.rmSync(dueRoot, { recursive: true, force: true });

  const currentRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'labmate-daily-current-'));
  const currentRuntime = makeRuntime(currentRoot);
  assert.equal(currentRuntime.configStore.recordBackupSuccess(new Date().toISOString()).ok, true);
  const currentCalls = [];
  currentRuntime.worker = { request: async (...args) => { currentCalls.push(args); return { ok: true, value: {} }; } };
  currentRuntime.startDailyBackup();
  await new Promise(resolve => setImmediate(resolve));
  currentRuntime.stopDailyBackup();
  assert.equal(currentCalls.length, 0);
  fs.rmSync(currentRoot, { recursive: true, force: true });
});

test('LocalConfigStore stores only encrypted password bytes and reports unavailable Keychain', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'labmate-config-'));
  const destination = path.join(root, 'Box-Box');
  fs.mkdirSync(destination);
  const safe = {
    isEncryptionAvailable: () => true,
    encryptString: value => Buffer.from(`encrypted:${value}`),
    decryptString: value => value.toString().replace(/^encrypted:/, ''),
  };
  const store = new main.LocalConfigStore({
    appApi: { getPath: name => name === 'userData' ? root : root },
    safeStorageApi: safe,
  });
  assert.equal(store.configure(destination, 'secret password').ok, true);
  const configText = fs.readFileSync(store.filePath, 'utf8');
  assert.equal(configText.includes('secret password'), false);
  assert.equal(store.readUsable().value.password, 'secret password');
  const unavailable = new main.LocalConfigStore({ appApi: { getPath: () => root }, safeStorageApi: { isEncryptionAvailable: () => false } });
  assert.equal(unavailable.configure(destination, 'secret').error.code, 'UNAVAILABLE');
  const unreadable = new main.LocalConfigStore({
    appApi: { getPath: () => root },
    safeStorageApi: { isEncryptionAvailable: () => true, decryptString: () => { throw new Error('Keychain unavailable'); } },
  });
  const unreadableRuntime = main.createBridgeRuntime({
    appApi: { getPath: name => name === 'cache' ? path.join(root, 'cache') : root },
    safeStorageApi: unreadable.safeStorageApi,
    utilityProcessApi: { fork: () => ({ on() {}, postMessage() {}, kill() {} }) },
  });
  const status = await unreadableRuntime.status();
  assert.equal(status.ok, true);
  assert.equal(status.value.configured, false);
  fs.rmSync(root, { recursive: true, force: true });
});

test('attachment open copies a managed hash object into a bounded cache with a safe extension', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'labmate-open-'));
  const objects = path.join(root, 'objects');
  const cache = path.join(root, 'cache');
  fs.mkdirSync(objects, { recursive: true });
  const source = path.join(objects, 'a'.repeat(64));
  fs.writeFileSync(source, 'managed bytes');
  const copied = main.copyAttachmentForOpen({ path: source, name: '../../unsafe.csv', mime: 'text/csv' }, {
    appApi: { getPath: () => cache },
    root,
  });
  assert.equal(copied.ok, true);
  assert.equal(path.extname(copied.value), '.csv');
  assert.equal(path.basename(copied.value).includes('..'), false);
  assert.equal(fs.readFileSync(copied.value, 'utf8'), 'managed bytes');
  let opened;
  const runtime = main.createBridgeRuntime({
    root,
    appApi: { getPath: () => cache },
    shellApi: { openPath: async value => { opened = value; return ''; } },
    utilityProcessApi: { fork: () => ({ on() {}, postMessage() {}, kill() {} }) },
  });
  runtime.worker = { request: async () => ({ ok: true, value: { path: source, name: '../../unsafe.csv', mime: 'text/csv' } }) };
  const result = await runtime.handleInvoke(frameEvent(), 'attachments.open', { id: UUID });
  assert.deepEqual(result, { ok: true, value: { opened: true } });
  assert.equal(path.extname(opened), '.csv');
  assert.equal(path.basename(opened).includes('..'), false);
  fs.rmSync(root, { recursive: true, force: true });
});

test('attachment preview progress is routed only to its requesting window', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'labmate-progress-'));
  const firstEvents = [];
  const secondEvents = [];
  const first = { id: 12, webContents: { id: 77, send: (_channel, value) => firstEvents.push(value) } };
  const second = { id: 13, webContents: { id: 78, send: (_channel, value) => secondEvents.push(value) } };
  const frame = { url: 'elb://app/index.html' };
  const event = { sender: { id: 77, mainFrame: frame, getURL: () => frame.url }, senderFrame: frame };
  const runtime = main.createBridgeRuntime({
    root,
    appApi: { getPath: () => path.join(root, 'cache') },
    BrowserWindowApi: {
      fromWebContents: () => first,
      fromId: id => id === first.id ? first : id === second.id ? second : null,
      getAllWindows: () => [first, second],
    },
    utilityProcessApi: { fork: () => ({ on() {}, postMessage() {}, kill() {} }) },
  });
  runtime.worker = {
    request: async (method, payload) => {
      assert.equal(method, 'attachments.preview');
      runtime.forwardProgress({ jobId: payload.jobId, operation: method, phase: 'reading', completed: 1, total: 2 });
      return { ok: true, value: { kind: 'unsupported', message: 'test' } };
    },
  };
  const result = await runtime.handleInvoke(event, 'attachments.preview', { id: UUID, jobId: 'preview-1' });
  assert.equal(result.ok, true);
  assert.equal(firstEvents.length, 1);
  assert.equal(secondEvents.length, 0);
  assert.equal(firstEvents[0].value?.jobId ?? firstEvents[0].jobId, 'preview-1');
  fs.rmSync(root, { recursive: true, force: true });
});

test('worker validates again, unwraps MessageEvent.data, serializes jobs, and lets cancel bypass the queue', async () => {
  const tx = transport();
  const services = fakeServices();
  const runtime = worker.createWorkerRuntime({ parentPort: tx, root: '/tmp/labmate-worker-test', services });
  const snapshotMessage = { id: 'snapshot', method: 'records.snapshot', payload: undefined };
  const event = Object.create({ data: snapshotMessage });
  runtime.receive(event);
  await runtime.waitForIdle();
  assert.equal(tx.messages[0].id, 'snapshot');
  assert.equal(tx.messages[0].result.ok, true);

  runtime.receive({ id: 'bad', method: 'attachments.import', payload: { runId: UUID, jobId: 'bad', paths: ['relative'] } });
  assert.equal(tx.messages.at(-1).result.error.code, 'VALIDATION');

  runtime.receive({ id: 'long', method: 'backups.run', payload: { jobId: 'long-job', password: 'pw', destination: '/tmp' } });
  await services.backupReady;
  runtime.receive({ id: 'cancel', method: 'jobs.cancel', payload: { jobId: 'long-job' } });
  await new Promise(resolve => setImmediate(resolve));
  const cancelReply = tx.messages.find(message => message.id === 'cancel');
  assert.deepEqual(cancelReply.result, { ok: true, value: { cancelled: true } });
  await runtime.waitForIdle();
  const longReply = tx.messages.find(message => message.id === 'long');
  assert.equal(longReply.result.error.code, 'CANCELLED');
  assert.equal(runtime.activeJobs.size, 0);
});

test('real worker child opens an isolated library through the raw worker transport', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'labmate-worker-child-'));
  const child = new Worker(path.join(__dirname, '..', 'electron', 'backend', 'worker.cjs'), {
    argv: [`--root=${root}`],
  });
  const pending = new Map();
  const settlePending = (key, callback) => {
    const entry = pending.get(key);
    if (!entry) return;
    pending.delete(key);
    clearTimeout(entry.timer);
    callback(entry);
  };
  child.on('message', incoming => {
    const message = incoming?.data ?? incoming;
    if (message && typeof message.id === 'string') settlePending(message.id, entry => entry.resolve(message));
  });
  child.on('error', error => {
    for (const [key, entry] of pending) {
      pending.delete(key);
      clearTimeout(entry.timer);
      entry.reject(error);
    }
  });
  const request = (id, method, payload) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Timed out waiting for ${method}`));
    }, 5_000);
    pending.set(id, { resolve, reject, timer });
    child.postMessage({ id, method, payload });
  });
  try {
    const snapshot = await request('child-snapshot', 'records.snapshot', undefined);
    assert.equal(snapshot.result.ok, true);
    assert.equal(snapshot.result.value.schemaVersion, 3);
    const shutdown = await request('child-shutdown', '__shutdown', undefined);
    assert.equal(shutdown.result.ok, true);
  } finally {
    await child.terminate();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('WorkerClient turns child exit into UNAVAILABLE and retries only on a later request', async () => {
  const children = [];
  const api = {
    fork() {
      const handlers = new Map();
      const child = {
        on(name, listener) { handlers.set(name, listener); },
        postMessage(message) { child.lastMessage = message; },
        kill() {},
        emit(name, value) { handlers.get(name)?.(value); },
      };
      children.push(child);
      return child;
    },
  };
  const client = new main.WorkerClient({ utilityProcessApi: api, root: '/tmp/library' });
  const pending = client.request('records.snapshot', undefined);
  children[0].emit('exit', 1);
  assert.equal((await pending).error.code, 'UNAVAILABLE');
  const next = client.request('records.snapshot', undefined);
  assert.equal(children.length, 2);
  children[1].emit('message', { id: children[1].lastMessage.id, result: { ok: true, value: { schemaVersion: 1 } } });
  assert.deepEqual(await next, { ok: true, value: { schemaVersion: 1 } });
});
