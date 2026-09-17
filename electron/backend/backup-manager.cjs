'use strict';
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { assertCapacity } = require('./backup-capacity.cjs');
const { readCatalog, writeCatalog, digest, retainedArchives, catalogStatus, localArchiveAvailable } = require('./backup-catalog.cjs');
const { runCloudProcess } = require('./cloud-process.cjs');

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
      if (message.committed) (data.operation === 'backup' ? context.markCheckpointCommitted || context.markCommitted : context.markCommitted)?.();
      if (message.result) finish(null, message.result);
      if (message.error) finish(Object.assign(new Error(message.error.message), { code: message.error.code }));
    });
    worker.on('error', error => finish(error));
    worker.on('exit', code => { if (!settled) finish(Object.assign(new Error(`Backup worker stopped before completion (${code}).`), { code: 'IO' })); });
  });
}

function validateDelivery(result, catalog, destination) {
  const names = new Set(catalog.archives.map(a => a.name));
  const validName = name => typeof name === 'string' && /^[a-zA-Z0-9_-]+\.labmatebackup$/.test(name);
  if (!result || !Array.isArray(result.copies) || !Array.isArray(result.prunable) || typeof result.destinationAvailable !== 'boolean'
    || typeof result.destination !== 'string' || !path.isAbsolute(result.destination) || result.destination.includes('\0')
    || (result.failure !== undefined && typeof result.failure !== 'string')
    || result.copies.length > catalog.archives.length || new Set(result.copies.map(c => c.name)).size !== result.copies.length
    || !result.copies.every(c => names.has(c.name) && c.copy && c.copy.directory === result.destination && validName(c.copy.name)
      && Number.isFinite(Date.parse(c.copy.verifiedAt)) && Number.isSafeInteger(c.copy.size) && c.copy.size >= 0 && Number.isFinite(c.copy.mtimeMs))
    || !result.prunable.every(name => names.has(name))) throw new Error('Invalid Box delivery response; local checkpoints were retained.');
  return result;
}

async function deliverAndRotate(root, request, context = {}) {
  const catalog = readCatalog(root);
  let delivery, failure;
  try {
    if (!request.destination) throw new Error('The Box folder is unavailable.');
    context.onProgress?.({ phase: 'delivery', message: 'Local checkpoint verified. Delivering to Box; this step can be deferred.' });
    delivery = validateDelivery(await (context.runDelivery || runCloudProcess)({ operation: 'deliver', root, destination: request.destination, catalog, jobId: request.jobId },
      { signal: context.signal, onProgress: context.onProgress, timeoutMs: request.deliveryTimeoutMs ?? context.deliveryTimeoutMs }), catalog, request.destination);
    failure = delivery.failure;
    request = { ...request, destination: delivery.destination };
    for (const { name, copy } of delivery.copies) {
      const archive = catalog.archives.find(a => a.name === name);
      archive.copies = [...archive.copies.filter(c => c.directory !== request.destination), copy];
    }
  } catch (error) { failure = error.message; }
  catalog.lastFailure = failure ? { at: new Date().toISOString(), message: `Local checkpoint retained; Box delivery pending. ${failure}` } : null;
  await writeCatalog(root, catalog);
  if (!failure && delivery) {
    const keep = retainedArchives(catalog, request.destination);
    for (const name of delivery.prunable) {
      if (keep.has(name)) continue;
      const archive = catalog.archives.find(a => a.name === name);
      if (!archive) continue;
      const local = path.join(root, 'backups', name);
      try { if (await digest(local) !== archive.sha256) continue; } catch { continue; }
      // Publish removal before unlinking. A crash can leave an unowned archive,
      // never a catalog entry whose intentionally deleted source blocks retries.
      catalog.archives = catalog.archives.filter(a => a.name !== name);
      await writeCatalog(root, catalog);
      await fsp.unlink(local).catch(() => {});
    }
  }
  const status = catalogStatus(catalog, request.destination);
  return { ...status, destinationAvailable: !!delivery?.destinationAvailable, createdAt: status.lastLocalBackupAt,
    message: failure || status.pendingDeliveryCount ? 'Local checkpoint verified. Box delivery is pending.' : 'Local checkpoint and Box Drive copy verified; upload is managed by Box.' };
}

async function runManagedBackup(store, request, context = {}) {
  const catalog = readCatalog(store.root);
  const token = store.db.prepare('SELECT change_token FROM library_state WHERE id=1').get().change_token;
  const previous = [...catalog.archives].filter(a => !a.rehearsalOnly).sort((a, b) => b.capturedAt.localeCompare(a.capturedAt))[0];
  let captured;
  try {
    if (request.force || !previous || previous.token !== token || !localArchiveAvailable(store.root, previous)) captured = await capture(store);
    if (context.signal?.aborted) throw Object.assign(new Error('Backup cancelled.'), { code: 'CANCELLED' });
    const operation = runThread({ operation: 'backup', root: store.root, captured, request }, context);
    context.releaseQueue?.();
    await operation;
  } finally { if (captured) await fsp.rm(captured.stage, { recursive: true, force: true }).catch(() => {}); }
  // Reusing an already verified checkpoint is also a safe delivery boundary.
  (context.markCheckpointCommitted || context.markCommitted)?.();
  return deliverAndRotate(store.root, request, context);
}

function verifyBackup(root, request, context = {}) {
  return runThread({ operation: 'verify', root, request }, context);
}
module.exports = { capture, runManagedBackup, verifyBackup, runThread, cleanInterruptedCaptures, deliverAndRotate, validateDelivery };
