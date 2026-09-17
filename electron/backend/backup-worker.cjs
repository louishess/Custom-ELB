'use strict';
const { workerData, parentPort } = require('node:worker_threads');
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const crypto = require('node:crypto');
const { createBackupService, copyFileAtomic } = require('./backup.cjs');
const { digest, readCatalog, writeCatalog, retainedArchives, catalogStatus } = require('./backup-catalog.cjs');
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

async function deliverAndRotate(catalog) {
  const keep = retainedArchives(catalog, request.destination);
  let deliveryFailure;
  const destination = request.destination;
  if (destination) {
    try {
      const stat = await fsp.lstat(destination);
      if (!stat.isDirectory() || stat.isSymbolicLink() || await fsp.realpath(destination) !== destination) throw new Error('The Box backup folder is unavailable.');
      for (const archive of [...catalog.archives].sort((a, b) => b.capturedAt.localeCompare(a.capturedAt))) {
        if (!keep.has(archive.name)) continue;
        const previousCopy = archive.copies.find(c => c.directory === destination);
        const target = path.join(destination, previousCopy?.name || archive.name);
        let unchangedCopy = false;
        if (previousCopy?.size !== undefined) { try { const stat = await fsp.lstat(target); unchangedCopy = stat.isFile() && !stat.isSymbolicLink() && stat.size === previousCopy.size && stat.mtimeMs === previousCopy.mtimeMs; } catch {} }
        if (unchangedCopy || await sameHash(target, archive.sha256)) {
          if (!previousCopy) archive.copies.push({ directory: destination, name: path.basename(target), verifiedAt: new Date().toISOString() });
          continue;
        }
        const source = path.join(root, 'backups', archive.name);
        if (!await sameHash(source, archive.sha256)) throw new Error('A local checkpoint failed verification. Existing recovery copies were retained.');
        // Never overwrite an unexpected or changed file at the destination.
        let output = target;
        try { await fsp.lstat(output); output = path.join(destination, `labmate-${crypto.randomUUID()}.labmatebackup`); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        await copyFileAtomic(source, output, { maxBackupBytes: 2 * 1024 ** 3 }, copyJob);
        archive.copies = archive.copies.filter(c => c.directory !== destination);
        const verifiedStat = await fsp.lstat(output);
        archive.copies.push({ directory: destination, name: path.basename(output), verifiedAt: new Date().toISOString(), size: verifiedStat.size, mtimeMs: verifiedStat.mtimeMs });
        await writeCatalog(root, catalog);
      }
    } catch (error) { deliveryFailure = { at: new Date().toISOString(), message: `Local checkpoint retained; Box delivery pending. ${error.message}` }; }
  } else deliveryFailure = {at: new Date().toISOString(), message: 'The Box folder is unavailable. Your local checkpoint is retained; delivery will retry automatically.'};
  catalog.lastFailure = deliveryFailure || null;
  await writeCatalog(root, catalog);
  // A failure never causes automatic deletion. Hash/ownership checks apply to
  // every removal; foreign files and changed archives remain untouched.
  if (!deliveryFailure && catalog.archives.length > 1) {
    const retainedAfterDelivery = retainedArchives(catalog, destination);
    for (const archive of [...catalog.archives]) {
      if (retainedAfterDelivery.has(archive.name)) continue;
      let removed = true;
      for (const copy of archive.copies.filter(c => c.directory === destination)) {
        const file = path.join(copy.directory, copy.name);
        if (await sameHash(file, archive.sha256)) await fsp.unlink(file).catch(() => { removed = false; });
        else removed = false;
      }
      const local = path.join(root, 'backups', archive.name);
      if (removed && await sameHash(local, archive.sha256)) await fsp.unlink(local).catch(() => { removed = false; });
      else removed = false;
      if (removed) catalog.archives = catalog.archives.filter(a => a.name !== archive.name);
    }
    await writeCatalog(root, catalog);
  }
  return catalogStatus(catalog, destination);
}

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
  const status = await deliverAndRotate(catalog);
  return { ...status, createdAt: status.lastLocalBackupAt, message: status.pendingDeliveryCount ? 'Local checkpoint verified. Box delivery is pending.' : 'Local checkpoint and Box Drive copy verified; upload is managed by Box.' };
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
