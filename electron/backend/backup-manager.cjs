'use strict';
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { assertCapacity } = require('./backup-capacity.cjs');
const { readCatalog, localArchiveAvailable } = require('./backup-catalog.cjs');

function cleanInterruptedCaptures(root) {
  const directory = path.join(root, 'backup-jobs');
  let stat;
  try { stat = fs.lstatSync(directory); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  if (!stat.isDirectory() || stat.isSymbolicLink()) return;
  for (const name of fs.readdirSync(directory)) {
    if (!/^capture-[A-Za-z0-9]{6}$/.test(name)) continue;
    const target = path.join(directory, name), child = fs.lstatSync(target);
    if (child.isDirectory() && !child.isSymbolicLink()) fs.rmSync(target, { recursive: true, force: true });
  }
}

async function capture(store) {
  assertCapacity(store);
  const directory = path.join(store.root, 'backup-jobs');
  await fsp.mkdir(directory, { recursive: true, mode: 0o700 });
  const stage = await fsp.mkdtemp(path.join(directory, 'capture-'));
  try {
    const token = store.db.prepare('SELECT change_token FROM library_state WHERE id=1').get().change_token;
    const schemaVersion = store.db.pragma('user_version', { simple: true });
    const attachments = store.db.prepare('SELECT DISTINCT hash, size FROM attachments').all();
    await fsp.mkdir(path.join(stage, 'objects'), { mode: 0o700 });
    await store.backupDatabase(path.join(stage, 'library.sqlite'));
    // Managed objects are immutable. A private hard link pins their inode even
    // if a later record deletion removes the original managed-object name.
    for (const item of attachments) {
      const source = path.join(store.root, 'objects', item.hash);
      const stat = await fsp.lstat(source);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== item.size) throw new Error('An attachment is missing or damaged. Restore a verified backup.');
      await fsp.link(source, path.join(stage, 'objects', item.hash));
    }
    return { stage, token, schemaVersion, attachments, capturedAt: new Date().toISOString() };
  } catch (error) { await fsp.rm(stage, { recursive: true, force: true }).catch(() => {}); throw error; }
}

function runThread(data, context) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(path.join(__dirname, 'backup-worker.cjs'), { workerData: data });
    let settled = false;
    const abort = () => worker.postMessage({ cancel: true });
    const finish = (error, value) => {
      if (settled) return; settled = true;
      context.signal?.removeEventListener('abort', abort);
      if (error) reject(error); else resolve(value);
    };
    context.signal?.addEventListener('abort', abort, { once: true });
    if (context.signal?.aborted) abort();
    worker.on('message', message => {
      if (message.progress) { try { context.onProgress?.(message.progress); } catch { abort(); } }
      if (message.committed) context.markCommitted?.();
      if (message.result) finish(null, message.result);
      if (message.error) finish(Object.assign(new Error(message.error.message), { code: message.error.code }));
    });
    worker.on('error', error => finish(error));
    worker.on('exit', code => { if (!settled) finish(Object.assign(new Error(`Backup worker stopped before completion (${code}).`), { code: 'IO' })); });
  });
}

async function runManagedBackup(store, request, context = {}) {
  if (request.destination) request = {...request,destination:await fsp.realpath(request.destination).catch(()=>request.destination)};
  const catalog = readCatalog(store.root);
  const token = store.db.prepare('SELECT change_token FROM library_state WHERE id=1').get().change_token;
  const previous = [...catalog.archives].filter(a => !a.rehearsalOnly).sort((a, b) => b.capturedAt.localeCompare(a.capturedAt))[0];
  let captured;
  try {
    if (request.force || !previous || previous.token !== token || !localArchiveAvailable(store.root, previous)) captured = await capture(store);
    if (context.signal?.aborted) throw Object.assign(new Error('Backup cancelled.'), { code: 'CANCELLED' });
    const operation = runThread({ operation: 'backup', root: store.root, captured, request }, context);
    context.releaseQueue?.();
    return await operation;
  } finally { if (captured) await fsp.rm(captured.stage, { recursive: true, force: true }).catch(() => {}); }
}

function verifyBackup(root, request, context = {}) {
  return runThread({ operation: 'verify', root, request }, context);
}
module.exports = { capture, runManagedBackup, verifyBackup, runThread, cleanInterruptedCaptures };
