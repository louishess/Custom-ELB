'use strict';
const { workerData, parentPort } = require('node:worker_threads');
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const crypto = require('node:crypto');
const { createBackupService, copyFileAtomic } = require('./backup.cjs');
const { digest, readCatalog, writeCatalog, catalogStatus } = require('./backup-catalog.cjs');
const controller = new AbortController();
parentPort.on('message', message => { if (message.cancel) controller.abort(); });
const { root, request, captured } = workerData;
const job = {
  signal: controller.signal,
  onProgress: progress => parentPort.postMessage({ progress }),
  markCommitted: () => parentPort.postMessage({ committed: true }),
};
const copyJob = {
  throwIfAborted() { if (controller.signal.aborted) throw Object.assign(new Error('Delivery deferred.'), { code: 'CANCELLED' }); },
  progress(phase, message, completed, total) { job.onProgress({ jobId: request.jobId, operation: 'backups.run', phase, message, completed, total }); },
};
async function sameHash(file, hash) { try { return await digest(file) === hash; } catch { return false; } }

async function backup() {
  const catalog = readCatalog(root);
  if (captured) {
    const frozenStore = {
      root, databasePath: path.join(captured.stage, 'library.sqlite'), backupLocks: 0,
      snapshot: () => ({ schemaVersion: captured.schemaVersion, attachments: captured.attachments }),
      backupDatabase: destination => fsp.copyFile(path.join(captured.stage, 'library.sqlite'), destination),
    };
    const service = createBackupService(frozenStore, { objectsRoot: path.join(captured.stage, 'objects'), localRetention: Number.MAX_SAFE_INTEGER });
    const result = await service.create({ password: request.password, jobId: request.jobId }, job);
    const sha256 = await digest(path.join(root, 'backups', result.name));
    const localStat=await fsp.lstat(path.join(root,'backups',result.name));
    catalog.archives.push({ localSize:localStat.size,localMtimeMs:localStat.mtimeMs,name: result.name, capturedAt: captured.capturedAt, token: captured.token, sha256, copies: [] });
    await writeCatalog(root, catalog);
    job.markCommitted();
  }
  return catalogStatus(catalog, request.destination);
}

async function verify() {
  const { LibraryStore } = require('./store.cjs');
  const folder = path.join(root, 'recovery-tests');
  await fsp.mkdir(folder, { recursive: true, mode: 0o700 });
  const temporary = await fsp.mkdtemp(path.join(folder, 'test-'));
  let store;
  try {
    // Box can replace a downloaded file during verification. Rehearse and pin
    // the same private, verified byte copy rather than rereading that path.
    const source = path.join(temporary, 'source.labmatebackup');
    await copyFileAtomic(request.source, source, { maxBackupBytes: 2 * 1024 ** 3 }, copyJob);
    store = new LibraryStore(temporary);
    const snapshot = await createBackupService(store).restore({ ...request, source }, job);
    // Restore validation checks authentication, every referenced hash, SQLite
    // integrity/foreign keys, schema, documents, and migration before readback.
    const records = { notebooks: snapshot.notebooks.length, experiments: snapshot.experiments.length, runs: snapshot.runs.length, attachments: snapshot.attachments.length, citations: snapshot.citations.length };
    const sha256 = await digest(source);
    const catalog = readCatalog(root);
    let archive = catalog.archives.find(a => a.sha256 === sha256);
    if (archive && !await sameHash(path.join(root,'backups',archive.name),sha256)) archive = null;
    if (!archive) {
      const name = `rehearsed-${crypto.randomUUID()}.labmatebackup`;
      await fsp.mkdir(path.join(root, 'backups'), { recursive: true, mode: 0o700 });
      await copyFileAtomic(source, path.join(root, 'backups', name), { maxBackupBytes: 2 * 1024 ** 3 }, copyJob);
      archive = { name, sha256, capturedAt: new Date().toISOString(), token: null, copies: [], rehearsalOnly: true };
      catalog.archives.push(archive);
    }
    catalog.rehearsal = { at: new Date().toISOString(), name: archive.name, sha256, records };
    await writeCatalog(root, catalog);
    return { ...catalog.rehearsal, schemaVersion: snapshot.schemaVersion, verified: true };
  } finally { store?.close(); await fsp.rm(temporary, { recursive: true, force: true }).catch(() => {}); }
}

(async () => {
  try { parentPort.postMessage({ result: await (workerData.operation === 'verify' ? verify() : backup()) }); }
  catch (error) { parentPort.postMessage({ error: { code: error.code || 'IO', message: error.message || 'Backup operation failed.' } }); }
  finally { parentPort.close(); }
})();
