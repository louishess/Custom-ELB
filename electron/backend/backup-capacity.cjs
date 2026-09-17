'use strict';
const fs = require('node:fs');
const path = require('node:path');
const LIMITS = Object.freeze({ bytes: 2 * 1024 ** 3, fileBytes: 1024 ** 3, entries: 10000 });
function capacity(store, additions = []) {
  const rows = store.db ? store.db.prepare('SELECT hash, MAX(size) AS size FROM attachments GROUP BY hash').all() : (store.snapshot().attachments || []);
  const objects = new Map(rows.map(row => [row.hash, Number(row.size)]));
  for (const item of additions) objects.set(item.hash, item.size);
  const databaseBytes = store.db ? Number(store.db.pragma('page_count', { simple: true })) * Number(store.db.pragma('page_size', { simple: true })) : (fs.existsSync(path.join(store.root, 'library.sqlite')) ? fs.statSync(path.join(store.root, 'library.sqlite')).size : 0);
  const objectBytes = [...objects.values()].reduce((a, b) => a + b, 0);
  // Reserve room for ZIP headers, the manifest, and modest database growth.
  const estimatedBytes = databaseBytes + objectBytes + 4 * 1024 ** 2 + objects.size * 512;
  const stat = fs.statfsSync(store.root);
  const availableBytes = Number(stat.bavail) * Number(stat.bsize);
  const requiredTemporaryBytes = estimatedBytes * 5 + 64 * 1024 ** 2;
  let issue;
  if (databaseBytes > LIMITS.fileBytes || [...objects.values()].some(size => size > LIMITS.fileBytes)) issue = 'A file exceeds the 1 GiB backup limit.';
  else if (objects.size + 2 > LIMITS.entries) issue = 'The library exceeds the 10,000-entry backup limit.';
  else if (estimatedBytes > LIMITS.bytes) issue = 'The library exceeds the 2 GiB complete-backup limit.';
  else if (availableBytes < requiredTemporaryBytes) issue = 'There is not enough free space to create and verify a complete backup.';
  return { estimatedBytes, databaseBytes, objectBytes, objectCount: objects.size, availableBytes, requiredTemporaryBytes, estimatedHistoryBytes: estimatedBytes * 59, issue };
}
function assertCapacity(store, additions) {
  const result = capacity(store, additions);
  if (result.issue) throw Object.assign(new Error(result.issue), { code: 'IO' });
  return result;
}
module.exports = { LIMITS, capacity, assertCapacity };
