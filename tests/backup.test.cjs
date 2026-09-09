'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = fs.promises;
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const { ZipArchive } = require('archiver');
const BetterSqlite3 = require('better-sqlite3');
const { LibraryStore } = require('../electron/backend/store.cjs');
const {
  createBackupService,
  RESTORE_JOURNAL_NAME,
  recoverRestoreJournal,
} = require('../electron/backend/backup.cjs');

const roots = new Set();
const MAGIC = Buffer.from('LABMATE-ENCRYPTED-BACKUP\0', 'utf8');
const TAG_BYTES = 16;

function temporaryRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'labmate-backup-test-'));
  roots.add(root);
  return root;
}

function hash(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function writeObject(root, bytes) {
  const objectHash = hash(bytes);
  fs.writeFileSync(path.join(root, 'objects', objectHash), bytes);
  return objectHash;
}

function value(result) {
  assert.equal(result.ok, true, result.ok ? '' : JSON.stringify(result.error));
  return result.value;
}

function setup(t, { emptyObject = false } = {}) {
  const root = temporaryRoot();
  const store = new LibraryStore(root);
  const notebook = value(store.dispatch('records.createNotebook', {
    name: 'Backup notebook',
    description: 'Disposable backup fixture',
    discipline: 'Chemistry',
    color: 'sage',
  })).notebooks[0];
  const run = value(store.dispatch('records.createExperiment', {
    notebookId: notebook.id,
    label: 'Experiment A',
    title: 'Before restore',
    date: '2026-09-08',
    author: 'Backup tester',
  })).runs[0];
  const bytes = emptyObject ? Buffer.alloc(0) : Buffer.from('immutable attachment bytes\n', 'utf8');
  const objectHash = writeObject(root, bytes);
  const attachment = {
    id: crypto.randomUUID(),
    runId: run.id,
    name: emptyObject ? 'empty.bin' : 'attachment.bin',
    mime: 'application/octet-stream',
    size: bytes.length,
    hash: objectHash,
    caption: '',
    kind: 'file',
    createdAt: new Date().toISOString(),
  };
  store.addAttachment(attachment);
  t.after(() => {
    try { store.close(); } catch {}
    roots.delete(root);
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, store, run, attachment, objectBytes: bytes, objectHash };
}

function serviceFor(fixture, options = {}) {
  return createBackupService(fixture.store, options);
}

function backupFile(fixture, result) {
  return path.join(fixture.root, 'backups', result.name);
}

async function zipFromEntries(filePath, entries) {
  const output = fs.createWriteStream(filePath, { flags: 'wx', mode: 0o600 });
  const archive = new ZipArchive({ zlib: { level: 6 } });
  const completed = Promise.race([
    once(output, 'close'),
    once(output, 'error').then(([error]) => { throw error; }),
    once(archive, 'error').then(([error]) => { throw error; }),
  ]);
  archive.pipe(output);
  for (const entry of entries) archive.append(Buffer.from(entry.data), { name: entry.name });
  await archive.finalize();
  await completed;
}

async function encryptedEnvelope(zipPath, outputPath, password, overrides = {}) {
  const archiveBytes = fs.readFileSync(zipPath);
  const salt = overrides.salt || crypto.randomBytes(16);
  const nonce = overrides.nonce || crypto.randomBytes(12);
  const header = {
    formatVersion: 1,
    algorithm: 'aes-256-gcm',
    kdf: 'scrypt',
    salt: salt.toString('base64'),
    nonce: nonce.toString('base64'),
    archiveBytes: archiveBytes.length,
    tagBytes: TAG_BYTES,
    schemaVersion: overrides.schemaVersion === undefined ? 1 : overrides.schemaVersion,
    createdAt: overrides.createdAt || new Date().toISOString(),
  };
  const headerBuffer = Buffer.from(JSON.stringify(header), 'utf8');
  const prefix = Buffer.alloc(MAGIC.length + 4);
  MAGIC.copy(prefix);
  prefix.writeUInt32BE(headerBuffer.length, MAGIC.length);
  const key = crypto.scryptSync(password, salt, 32, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.concat([prefix, headerBuffer]));
  const encrypted = Buffer.concat([cipher.update(archiveBytes), cipher.final(), cipher.getAuthTag()]);
  fs.writeFileSync(outputPath, Buffer.concat([prefix, headerBuffer, encrypted]), { mode: 0o600 });
}

function readEnvelope(filePath) {
  const bytes = Buffer.from(fs.readFileSync(filePath));
  assert.equal(bytes.subarray(0, MAGIC.length).equals(MAGIC), true);
  const headerLength = bytes.readUInt32BE(MAGIC.length);
  const headerStart = MAGIC.length + 4;
  const header = JSON.parse(bytes.subarray(headerStart, headerStart + headerLength).toString('utf8'));
  const prefixLength = headerStart + headerLength;
  return { bytes, header, headerLength, headerStart, prefixLength };
}

async function databaseCopy(fixture, filePath) {
  await fixture.store.backupDatabase(filePath);
  return fs.readFileSync(filePath);
}

async function craftedBackup(fixture, fileName, entries, overrides = {}) {
  const work = path.join(fixture.root, 'staging', `crafted-${crypto.randomUUID()}`);
  fs.mkdirSync(work, { recursive: true });
  const zipPath = path.join(work, 'archive.zip');
  const outputPath = path.join(fixture.root, 'backups', fileName);
  await zipFromEntries(zipPath, entries);
  await encryptedEnvelope(zipPath, outputPath, 'correct horse', overrides);
  return outputPath;
}

async function validManifestAndDatabase(fixture, objectHash, objectBytes) {
  const databasePath = path.join(fixture.root, 'staging', `manifest-${crypto.randomUUID()}.sqlite`);
  const databaseBytes = await databaseCopy(fixture, databasePath);
  return {
    databasePath,
    databaseBytes,
    manifest: {
      formatVersion: 1,
      schemaVersion: 1,
      createdAt: new Date().toISOString(),
      database: { name: 'library.sqlite', size: databaseBytes.length, sha256: hash(databaseBytes) },
      objects: [{ name: `objects/${objectHash}`, hash: objectHash, size: objectBytes.length }],
    },
  };
}

test.after(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
  roots.clear();
});

test('creates, authenticates, and restores a roundtrip with a zero-byte immutable object', async t => {
  const fixture = setup(t, { emptyObject: true });
  const service = serviceFor(fixture);
  const created = await service.create({ password: 'correct horse', jobId: 'roundtrip' });
  const backup = backupFile(fixture, created);
  assert.equal(fs.statSync(backup).isFile(), true);
  assert.equal(created.message, 'Encrypted LabMate backup created.');

  const update = fixture.store.dispatch('records.updateRun', {
    id: fixture.run.id,
    expectedRevision: fixture.run.revision,
    changes: { title: 'After mutation' },
  });
  assert.equal(update.ok, true);
  const restored = await service.restore({ password: 'correct horse', source: backup, jobId: 'roundtrip-restore' });
  assert.equal(restored.runs[0].title, 'Before restore');
  assert.equal(restored.attachments[0].size, 0);
  assert.deepEqual(fs.readFileSync(path.join(fixture.root, 'objects', fixture.objectHash)), Buffer.alloc(0));
  assert.equal(fixture.store.backupLocks, 0);
  assert.equal(fs.existsSync(path.join(fixture.root, RESTORE_JOURNAL_NAME)), false);
});

test('copies only after local validation and reports the Box destination message', async t => {
  const fixture = setup(t);
  const destination = fs.mkdtempSync(path.join(os.tmpdir(), 'labmate-backup-destination-'));
  roots.add(destination);
  const service = serviceFor(fixture);
  const created = await service.create({ password: 'correct horse', destination, jobId: 'destination' });
  assert.equal(created.message, 'Saved to Box Drive; upload managed by Box.');
  const destinationFiles = fs.readdirSync(destination).filter(name => name.endsWith('.labmatebackup'));
  assert.deepEqual(destinationFiles, [created.name]);
  assert.equal(fs.readFileSync(path.join(destination, created.name)).equals(fs.readFileSync(backupFile(fixture, created))), true);
});

test('rejects wrong password, ciphertext tampering, authenticated header tampering, and truncation', async t => {
  const fixture = setup(t);
  const service = serviceFor(fixture);
  const created = await service.create({ password: 'correct horse' });
  const backup = backupFile(fixture, created);
  const original = fs.readFileSync(backup);
  await assert.rejects(() => service.restore({ password: 'wrong password', source: backup }), error => error.code === 'CORRUPT_BACKUP');

  const tamperedCiphertext = path.join(fixture.root, 'backups', 'tampered.labmatebackup');
  const cipherBytes = Buffer.from(original);
  const envelope = readEnvelope(backup);
  cipherBytes[envelope.prefixLength + 1] ^= 0x40;
  fs.writeFileSync(tamperedCiphertext, cipherBytes);
  await assert.rejects(() => service.restore({ password: 'correct horse', source: tamperedCiphertext }), error => error.code === 'CORRUPT_BACKUP');

  const tamperedHeader = path.join(fixture.root, 'backups', 'tampered-header.labmatebackup');
  const headerBytes = Buffer.from(original);
  const newHeader = Buffer.from(JSON.stringify({ ...envelope.header, createdAt: '2000-01-01T00:00:00.000Z' }), 'utf8');
  assert.equal(newHeader.length, envelope.headerLength);
  newHeader.copy(headerBytes, envelope.headerStart);
  fs.writeFileSync(tamperedHeader, headerBytes);
  await assert.rejects(() => service.restore({ password: 'correct horse', source: tamperedHeader }), error => error.code === 'CORRUPT_BACKUP');

  const truncated = path.join(fixture.root, 'backups', 'truncated.labmatebackup');
  fs.writeFileSync(truncated, original.subarray(0, original.length - TAG_BYTES));
  await assert.rejects(() => service.restore({ password: 'correct horse', source: truncated }), error => error.code === 'CORRUPT_BACKUP');
});

test('rejects traversal entries and missing manifest objects before touching the library', async t => {
  const fixture = setup(t);
  const service = serviceFor(fixture);
  const outside = path.join(fixture.root, 'escape.txt');
  const traversal = await craftedBackup(fixture, 'traversal.labmatebackup', [
    { name: 'manifest.json', data: '{}' },
    { name: 'library.sqlite', data: 'SQLite format 3\0' },
    { name: '../escape.txt', data: 'escape' },
  ]);
  await assert.rejects(() => service.restore({ password: 'correct horse', source: traversal }), error => error.code === 'CORRUPT_BACKUP');
  assert.equal(fs.existsSync(outside), false);

  const crafted = await validManifestAndDatabase(fixture, fixture.objectHash, fixture.objectBytes);
  const missingObject = await craftedBackup(fixture, 'missing-object.labmatebackup', [
    { name: 'manifest.json', data: JSON.stringify(crafted.manifest) },
    { name: 'library.sqlite', data: crafted.databaseBytes },
  ]);
  await assert.rejects(() => service.restore({ password: 'correct horse', source: missingObject }), error => error.code === 'CORRUPT_BACKUP');
  assert.equal(fixture.store.snapshot().runs[0].title, 'Before restore');
});

test('rejects a SQLite foreign-key violation before switching the current library', async t => {
  const fixture = setup(t);
  const service = serviceFor(fixture);
  const databasePath = path.join(fixture.root, 'staging', `orphan-${crypto.randomUUID()}.sqlite`);
  const databaseBytes = await databaseCopy(fixture, databasePath);
  const database = new BetterSqlite3(databasePath);
  database.pragma('foreign_keys = OFF');
  database.prepare('INSERT INTO scheme_members (scheme_id, run_id, position) VALUES (?, ?, ?)').run(crypto.randomUUID(), crypto.randomUUID(), 0);
  database.close();
  const mutatedDatabase = fs.readFileSync(databasePath);
  const manifest = {
    formatVersion: 1,
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    database: { name: 'library.sqlite', size: mutatedDatabase.length, sha256: hash(mutatedDatabase) },
    objects: [{ name: `objects/${fixture.objectHash}`, hash: fixture.objectHash, size: fixture.objectBytes.length }],
  };
  const work = path.join(fixture.root, 'staging', `foreign-key-${crypto.randomUUID()}`);
  fs.mkdirSync(work, { recursive: true });
  const zipPath = path.join(work, 'archive.zip');
  await zipFromEntries(zipPath, [
    { name: 'manifest.json', data: JSON.stringify(manifest) },
    { name: 'library.sqlite', data: mutatedDatabase },
    { name: `objects/${fixture.objectHash}`, data: fixture.objectBytes },
  ]);
  const malformed = path.join(fixture.root, 'backups', 'foreign-key.labmatebackup');
  await encryptedEnvelope(zipPath, malformed, 'correct horse');
  await assert.rejects(() => service.restore({ password: 'correct horse', source: malformed }), error => error.code === 'CORRUPT_BACKUP');
  assert.equal(fixture.store.snapshot().runs[0].title, 'Before restore');
  assert.equal(fs.existsSync(databasePath), true);
});

test('rejects an unsupported stored document schema before switching the current library', async t => {
  const fixture = setup(t);
  const service = serviceFor(fixture);
  const databasePath = path.join(fixture.root, 'staging', `document-schema-${crypto.randomUUID()}.sqlite`);
  await databaseCopy(fixture, databasePath);
  const database = new BetterSqlite3(databasePath);
  database.pragma('ignore_check_constraints = ON');
  database.prepare('UPDATE documents SET document_schema_version = 2 WHERE run_id = ?').run(fixture.run.id);
  database.close();
  const databaseBytes = fs.readFileSync(databasePath);
  const manifest = {
    formatVersion: 1,
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    database: { name: 'library.sqlite', size: databaseBytes.length, sha256: hash(databaseBytes) },
    objects: [{ name: `objects/${fixture.objectHash}`, hash: fixture.objectHash, size: fixture.objectBytes.length }],
  };
  const malformed = await craftedBackup(fixture, 'unsupported-document-schema.labmatebackup', [
    { name: 'manifest.json', data: JSON.stringify(manifest) },
    { name: 'library.sqlite', data: databaseBytes },
    { name: `objects/${fixture.objectHash}`, data: fixture.objectBytes },
  ]);
  await assert.rejects(
    () => service.restore({ password: 'correct horse', source: malformed }),
    error => error.code === 'CORRUPT_BACKUP',
  );
  assert.equal(fixture.store.snapshot().runs[0].title, 'Before restore');
});

test('rejects a future schema and cleans staging after cancellation', async t => {
  const fixture = setup(t);
  const service = serviceFor(fixture);
  const created = await service.create({ password: 'correct horse' });
  const envelope = readEnvelope(backupFile(fixture, created));
  const future = path.join(fixture.root, 'backups', 'future.labmatebackup');
  const futureBytes = Buffer.from(envelope.bytes);
  const futureHeader = Buffer.from(JSON.stringify({ ...envelope.header, schemaVersion: 2 }), 'utf8');
  assert.equal(futureHeader.length, envelope.headerLength);
  futureHeader.copy(futureBytes, envelope.headerStart);
  fs.writeFileSync(future, futureBytes);
  await assert.rejects(() => service.restore({ password: 'correct horse', source: future }), error => error.code === 'CORRUPT_BACKUP');

  const controller = new AbortController();
  controller.abort();
  await assert.rejects(() => service.create({ password: 'correct horse', jobId: 'cancelled' }, { signal: controller.signal }), error => error.code === 'CANCELLED');
  assert.deepEqual(fs.readdirSync(path.join(fixture.root, 'staging')), []);
});

test('retains exactly the latest seven local snapshots', async t => {
  const fixture = setup(t);
  const service = serviceFor(fixture);
  for (let index = 0; index < 8; index += 1) {
    await service.create({ password: 'correct horse', jobId: `retention-${index}` });
  }
  const localBackups = fs.readdirSync(path.join(fixture.root, 'backups')).filter(name => name.endsWith('.labmatebackup'));
  assert.equal(localBackups.length, 7);
});

test('keeps a valid local snapshot when the external destination is unavailable', async t => {
  const fixture = setup(t);
  const service = serviceFor(fixture);
  const unavailable = path.join(fixture.root, 'does-not-exist', 'destination');
  await assert.rejects(() => service.create({ password: 'correct horse', destination: unavailable }), error => error.code === 'UNAVAILABLE');
  const localBackups = fs.readdirSync(path.join(fixture.root, 'backups')).filter(name => name.endsWith('.labmatebackup'));
  assert.equal(localBackups.length, 1);
  assert.equal(fixture.store.backupLocks, 0);
});

test('keeps an earlier good snapshot when local validation or destination copy fails', async t => {
  const fixture = setup(t);
  const service = serviceFor(fixture);
  const first = await service.create({ password: 'correct horse' });
  const firstPath = backupFile(fixture, first);
  assert.equal(fs.existsSync(firstPath), true);

  const validationFailure = serviceFor(fixture, {
    validateDatabase: () => { throw new Error('injected local validation failure'); },
  });
  await assert.rejects(() => validationFailure.create({ password: 'correct horse' }), error => error.code === 'IO');
  assert.equal(fs.existsSync(firstPath), true);
  assert.equal(fs.readdirSync(path.join(fixture.root, 'backups')).filter(name => name.endsWith('.labmatebackup')).length, 1);
  await service.restore({ password: 'correct horse', source: firstPath });
  assert.equal(fixture.store.snapshot().runs[0].title, 'Before restore');

  const destination = fs.mkdtempSync(path.join(os.tmpdir(), 'labmate-copy-failure-'));
  roots.add(destination);
  const copyFailure = serviceFor(fixture, {
    copyFile: () => { throw new Error('injected destination copy failure'); },
  });
  await assert.rejects(() => copyFailure.create({ password: 'correct horse', destination }), error => error.code === 'IO');
  assert.equal(fs.existsSync(firstPath), true);
});

test('rolls back the same open store after a reopen failure and retains rollback data', async t => {
  const fixture = setup(t);
  const service = serviceFor(fixture);
  const created = await service.create({ password: 'correct horse' });
  const backup = backupFile(fixture, created);
  const updated = fixture.store.dispatch('records.updateRun', {
    id: fixture.run.id,
    expectedRevision: fixture.run.revision,
    changes: { title: 'Current unsaved library' },
  });
  assert.equal(updated.ok, true);
  const originalReopen = fixture.store.reopen.bind(fixture.store);
  let failOnce = true;
  fixture.store.reopen = () => {
    if (failOnce) {
      failOnce = false;
      throw new Error('simulated reopen failure');
    }
    return originalReopen();
  };
  await assert.rejects(() => service.restore({ password: 'correct horse', source: backup }), error => error.code === 'IO');
  assert.equal(fixture.store.snapshot().runs[0].title, 'Current unsaved library');
  assert.equal(fixture.store.backupLocks, 0);
  assert.equal(fs.readdirSync(path.join(fixture.root, 'rollback')).length > 0, true);
});

test('cancellation during the switch rolls back with an open store and cleans staging', async t => {
  const fixture = setup(t);
  const initialService = serviceFor(fixture);
  const created = await initialService.create({ password: 'correct horse' });
  const backup = backupFile(fixture, created);
  const updated = fixture.store.dispatch('records.updateRun', {
    id: fixture.run.id,
    expectedRevision: fixture.run.revision,
    changes: { title: 'Current after cancellation' },
  });
  assert.equal(updated.ok, true);
  const controller = new AbortController();
  const service = serviceFor(fixture, {
    onSwitchPhase: phase => {
      if (phase === 'candidate-objects-moved') controller.abort();
    },
  });
  await assert.rejects(
    () => service.restore({ password: 'correct horse', source: backup }, { signal: controller.signal }),
    error => error.code === 'CANCELLED',
  );
  assert.equal(fixture.store.snapshot().runs[0].title, 'Current after cancellation');
  assert.equal(fixture.store.backupLocks, 0);
  assert.deepEqual(fs.readdirSync(path.join(fixture.root, 'staging')), []);
});

test('recovers an interrupted restore journal before reopening the library', async t => {
  const phases = ['db-moved', 'objects-moved', 'candidate-db-moved', 'candidate-objects-moved', 'opened'];
  for (const phase of phases) {
    const fixture = setup(t);
    const service = serviceFor(fixture);
    const created = await service.create({ password: 'correct horse' });
    const backup = backupFile(fixture, created);
    const updated = fixture.store.dispatch('records.updateRun', {
      id: fixture.run.id,
      expectedRevision: fixture.run.revision,
      changes: { title: `Current survives ${phase}` },
    });
    assert.equal(updated.ok, true);
    fixture.store.close();

    const childScript = `
      const { LibraryStore } = require(${JSON.stringify(path.join(__dirname, '..', 'electron/backend/store.cjs'))});
      const { createBackupService } = require(${JSON.stringify(path.join(__dirname, '..', 'electron/backend/backup.cjs'))});
      const store = new LibraryStore(${JSON.stringify(fixture.root)});
      const service = createBackupService(store, { onSwitchPhase: currentPhase => { if (currentPhase === ${JSON.stringify(phase)}) process.exit(73); } });
      service.restore({ password: 'correct horse', source: ${JSON.stringify(backup)} }).catch(() => process.exit(74));
    `;
    const child = spawnSync(process.execPath, ['-e', childScript], { encoding: 'utf8' });
    assert.equal(child.status, 73, `${phase}: ${child.stderr}`);
    assert.equal(fs.existsSync(path.join(fixture.root, RESTORE_JOURNAL_NAME)), true);

    const reopened = new LibraryStore(fixture.root);
    assert.equal(
      reopened.snapshot().runs[0].title,
      phase === 'opened' ? 'Before restore' : `Current survives ${phase}`,
    );
    assert.equal(fs.existsSync(path.join(fixture.root, RESTORE_JOURNAL_NAME)), false);
    if (phase === 'opened') assert.equal(fs.readdirSync(path.join(fixture.root, 'rollback')).length > 0, true);
    reopened.close();
    await recoverRestoreJournal(fixture.root);
  }
});
