'use strict';
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const crypto = require('node:crypto');
const validName = name => typeof name === 'string' && /^[a-zA-Z0-9_-]+\.labmatebackup$/.test(name);
async function digest(file) {
  const stat = await fsp.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Backup is not a regular file.');
  const hash = crypto.createHash('sha256');
  for await (const bytes of fs.createReadStream(file)) hash.update(bytes);
  return hash.digest('hex');
}
function readCatalog(root) {
  const file = path.join(root, 'backups', 'catalog.json');
  try {
    if (fs.lstatSync(file).isSymbolicLink()) throw new Error('Unsafe backup catalog.');
    const catalog = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (catalog.version !== 1 || !Array.isArray(catalog.archives) || !catalog.archives.every(a => validName(a.name) && /^[a-f0-9]{64}$/.test(a.sha256) && Number.isFinite(Date.parse(a.capturedAt)) && Array.isArray(a.copies) && a.copies.every(c => typeof c.directory === 'string' && path.isAbsolute(c.directory) && validName(c.name)))) throw new Error('Invalid backup catalog.');
    return catalog;
  } catch (error) {
    if (error.code === 'ENOENT') return { version: 1, archives: [], lastFailure: null, rehearsal: null };
    throw Object.assign(new Error('The backup catalog cannot be read. Existing archives have been preserved.'), { code: 'IO', cause: error });
  }
}
async function writeCatalog(root, catalog) {
  const folder = path.join(root, 'backups');
  await fsp.mkdir(folder, { recursive: true, mode: 0o700 });
  const target = path.join(folder, 'catalog.json');
  const temp = path.join(folder, `catalog-${crypto.randomUUID()}.tmp`);
  try {
    const h = await fsp.open(temp, 'wx', 0o600);
    try { await h.writeFile(JSON.stringify(catalog)); await h.sync(); } finally { await h.close(); }
    await fsp.rename(temp, target);
    const dir = await fsp.open(folder, 'r');
    try { await dir.sync(); } finally { await dir.close(); }
  } finally { await fsp.rm(temp, { force: true }).catch(() => {}); }
}
function retainedArchives(catalog, destination) {
  const sorted = [...catalog.archives].sort((a, b) => b.capturedAt.localeCompare(a.capturedAt));
  const keep = new Set(sorted.slice(0, 16).map(a => a.name));
  for (const [limit, bucket] of [[30, d => d.slice(0, 10)], [12, d => {
    const date = new Date(d); date.setUTCHours(0, 0, 0, 0); date.setUTCDate(date.getUTCDate() - (date.getUTCDay() + 6) % 7); return date.toISOString().slice(0, 10);
  }]]) {
    const buckets = new Set();
    for (const archive of sorted) {
      const key = bucket(archive.capturedAt);
      if (!buckets.has(key) && buckets.size < limit) { keep.add(archive.name); buckets.add(key); }
    }
  }
  for (const archive of sorted) if (!archive.copies.length || (destination && !archive.copies.some(c => c.directory === destination))) keep.add(archive.name);
  for (const archive of sorted) if (archive.sha256 === catalog.rehearsal?.sha256) keep.add(archive.name);
  return keep;
}
function catalogStatus(catalog, destination) {
  const live = catalog.archives.filter(a => !a.rehearsalOnly).sort((a, b) => b.capturedAt.localeCompare(a.capturedAt));
  const copied = live.filter(a => a.copies.some(c => c.directory === destination));
  const retained = retainedArchives(catalog, destination);
  return {
    lastLocalBackupAt: live[0]?.capturedAt,
    lastBoxCopyAt: copied[0]?.copies.find(c => c.directory === destination)?.verifiedAt,
    lastBoxCaptureAt: copied[0]?.capturedAt,
    capturedRevision: live[0]?.token,
    pendingDeliveryCount: catalog.archives.filter(a => retained.has(a.name) && !a.copies.some(c => c.directory === destination)).length,
    lastRehearsal: catalog.rehearsal ? { at: catalog.rehearsal.at, name: catalog.rehearsal.name, records: catalog.rehearsal.records } : undefined,
    lastFailure: catalog.lastFailure || undefined,
    retainedCount: retained.size,
    cloudStatus: 'not-verified',
  };
}
module.exports = { digest, readCatalog, writeCatalog, retainedArchives, catalogStatus };
