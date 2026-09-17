'use strict';
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const crypto = require('node:crypto');

const inside = (root, target) => { const relative = path.relative(root, target); return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)); };
async function probe({ home, destination }) {
  const roots = [];
  for (const candidate of [path.join(home, 'Library/CloudStorage/Box-Box'), path.join(home, 'Library/CloudStorage/Box'), path.join(home, 'Box')]) {
    try { if ((await fsp.stat(candidate)).isDirectory()) roots.push(await fsp.realpath(candidate)); } catch {}
  }
  if (!destination) return { roots, available: false };
  try {
    const stat = await fsp.lstat(destination);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Choose a regular folder inside Box Drive.');
    const canonical = await fsp.realpath(destination);
    if (!roots.some(root => inside(root, canonical))) throw new Error('Choose a folder inside the detected Box Drive directory');
    await fsp.access(canonical, fs.constants.W_OK);
    return { roots, destination: canonical, available: true };
  } catch (error) { return { roots, available: false, message: error.message }; }
}

async function deliver({ root, destination, catalog, jobId }) {
  // The unpacked entry point loads shared code from the packaged archive.
  const source = __dirname.replace('.asar.unpacked', '.asar');
  const { copyFileAtomic } = require(path.join(source, 'backup.cjs'));
  const { digest, retainedArchives } = require(path.join(source, 'backup-catalog.cjs'));
  const sameHash = async (file, hash) => { try { return await digest(file) === hash; } catch { return false; } };
  const copies = [], prunable = [];
  const job = { throwIfAborted() {}, progress(phase, message, completed, total) { process.send?.({ progress: { jobId, operation: 'backups.run', phase, message, completed, total } }); } };
  let destinationAvailable = false;
  try {
    const stat = await fsp.lstat(destination);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('The Box backup folder is unavailable.');
    destination = await fsp.realpath(destination);
    destinationAvailable = true;
    const keep = retainedArchives(catalog, destination);
    for (const archive of [...catalog.archives].sort((a, b) => b.capturedAt.localeCompare(a.capturedAt))) {
      if (!keep.has(archive.name)) continue;
      const previous = archive.copies.find(c => c.directory === destination);
      const target = path.join(destination, previous?.name || archive.name);
      let unchanged = false;
      if (previous?.size !== undefined) { try { const s = await fsp.lstat(target); unchanged = s.isFile() && !s.isSymbolicLink() && s.size === previous.size && s.mtimeMs === previous.mtimeMs; } catch {} }
      let output = target;
      if (!unchanged && !await sameHash(target, archive.sha256)) {
        const local = path.join(root, 'backups', archive.name);
        if (!await sameHash(local, archive.sha256)) throw new Error('A local checkpoint failed verification. Existing recovery copies were retained.');
        try { await fsp.lstat(output); output = path.join(destination, `labmate-${crypto.randomUUID()}.labmatebackup`); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        await copyFileAtomic(local, output, { maxBackupBytes: 2 * 1024 ** 3 }, job);
      }
      const verified = await fsp.lstat(output);
      const copy = { directory: destination, name: path.basename(output), verifiedAt: previous?.verifiedAt && unchanged ? previous.verifiedAt : new Date().toISOString(), size: verified.size, mtimeMs: verified.mtimeMs };
      archive.copies = [...archive.copies.filter(c => c.directory !== destination), copy];
      copies.push({ name: archive.name, copy });
    }
    const retained = retainedArchives(catalog, destination);
    for (const archive of catalog.archives) {
      if (retained.has(archive.name)) continue;
      let removed = true;
      for (const copy of archive.copies.filter(c => c.directory === destination)) {
        const file = path.join(destination, copy.name);
        if (!await sameHash(file, archive.sha256)) {
          // A previous attempt may have removed this owned copy before its
          // reply arrived. Missing copies need no re-upload just to prune them.
          try { await fsp.lstat(file); removed = false; }
          catch (error) { if (error.code !== 'ENOENT') removed = false; }
          continue;
        }
        try { await fsp.unlink(file); } catch { removed = false; }
      }
      if (removed) prunable.push(archive.name);
    }
    return { copies, prunable, destination, destinationAvailable };
  } catch (error) { return { copies, prunable: [], destination, destinationAvailable, failure: error.message }; }
}

async function stage({ source, destination }) {
  const { copyFileAtomic } = require(path.join(__dirname.replace('.asar.unpacked', '.asar'), 'backup.cjs'));
  const job = { throwIfAborted() {}, progress(phase, message, completed, total) { process.send?.({ progress: { phase, message, completed, total } }); } };
  await copyFileAtomic(source, destination, { maxBackupBytes: 2 * 1024 ** 3 }, job);
  return { file: destination };
}

if (require.main === module) process.once('message', async message => {
  try { process.send?.({ result: await (message.operation === 'probe' ? probe(message) : message.operation === 'stage' ? stage(message) : deliver(message)) }); }
  catch (error) { process.send?.({ error: { message: error.message } }); }
});
module.exports = { probe, deliver };
