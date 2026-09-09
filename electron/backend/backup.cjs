'use strict';

const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const crypto = require('node:crypto');
const { ZipArchive } = require('archiver');
const yauzl = require('yauzl');

const FORMAT_VERSION = 1;
const { SCHEMA_VERSION: SUPPORTED_SCHEMA_VERSION, columnsForVersion } = require('./schema.cjs');
const MAGIC = Buffer.from('LABMATE-ENCRYPTED-BACKUP\0', 'utf8');
const HEADER_LENGTH_BYTES = 4;
const AUTH_TAG_BYTES = 16;
const SALT_BYTES = 16;
const NONCE_BYTES = 12;
const KEY_BYTES = 32;
const DEFAULT_MAX_BACKUP_BYTES = 2 * 1024 * 1024 * 1024;
const DEFAULT_MAX_ARCHIVE_BYTES = 2 * 1024 * 1024 * 1024;
const DEFAULT_MAX_FILE_BYTES = 1024 * 1024 * 1024;
const DEFAULT_MAX_ENTRIES = 10000;
const DEFAULT_MAX_MANIFEST_BYTES = 2 * 1024 * 1024;
const DEFAULT_LOCAL_RETENTION = 7;
// Kept in staging so LibraryStore can recover it before opening SQLite and
// can preserve its candidate/swap directories during ordinary cleanup.
const RESTORE_JOURNAL_NAME = path.join('staging', 'restore-journal.json');

const ERROR_CODES = new Set([
  'VALIDATION',
  'NOT_FOUND',
  'STALE_REVISION',
  'IO',
  'CANCELLED',
  'UNAVAILABLE',
  'CORRUPT_BACKUP',
]);

class BackupError extends Error {
  constructor(code, message, cause) {
    super(message);
    this.name = 'BackupError';
    this.code = code;
    if (cause) this.cause = cause;
  }
}

function backupError(code, message, cause) {
  return new BackupError(code, message, cause);
}

function asBackupError(error, fallbackCode = 'IO', fallbackMessage = 'Backup operation failed.') {
  if (error instanceof BackupError) return error;
  if (error && error.code === 'CANCELLED') return backupError('CANCELLED', 'Backup operation cancelled.', error);
  if (error && error.name === 'AbortError') return backupError('CANCELLED', 'Backup operation cancelled.', error);
  if (error && ERROR_CODES.has(error.code)) return backupError(error.code, error.message || fallbackMessage, error);
  return backupError(fallbackCode, fallbackMessage, error);
}

function isAbortSignal(value) {
  return value && typeof value.aborted === 'boolean' && typeof value.addEventListener === 'function';
}

function makeJobContext(context, jobId, operation) {
  const signal = isAbortSignal(context && context.signal) ? context.signal : null;
  const onProgress = context && typeof context.onProgress === 'function' ? context.onProgress : null;
  const progress = (phase, message, completed, total) => {
    if (!onProgress) return;
    try {
      onProgress({
        jobId: typeof jobId === 'string' ? jobId : '',
        operation,
        phase,
        ...(Number.isFinite(completed) ? { completed } : {}),
        ...(Number.isFinite(total) ? { total } : {}),
        ...(message ? { message } : {}),
      });
    } catch {
      // Progress listeners belong to the caller. A broken listener must not
      // leave a backup half-written or change its data-integrity result.
    }
  };
  const throwIfAborted = () => {
    if (signal && signal.aborted) throw backupError('CANCELLED', 'Backup operation cancelled.');
  };
  return { signal, progress, throwIfAborted };
}

function normalizeRoot(value, fallback) {
  if (typeof value !== 'string' || value.length === 0) return path.resolve(fallback);
  return path.resolve(value);
}

function assertInside(root, target, label = 'path') {
  const relative = path.relative(root, target);
  if (relative === '' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
    throw backupError('VALIDATION', `Unsafe ${label}.`);
  }
}

async function lstatOrNull(filePath) {
  try {
    return await fsp.lstat(filePath);
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    throw error;
  }
}

async function ensureDirectory(directory, mode = 0o700) {
  await fsp.mkdir(directory, { recursive: true, mode });
  const stat = await fsp.lstat(directory);
  if (!stat.isDirectory()) throw backupError('IO', `Expected directory at ${directory}.`);
}

async function ensureRegularFile(filePath, label = 'file') {
  const stat = await fsp.lstat(filePath);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw backupError('CORRUPT_BACKUP', `The ${label} is not a regular file.`);
  }
  return stat;
}

function validatePassword(password) {
  if (typeof password !== 'string' || password.length === 0) {
    throw backupError('VALIDATION', 'A non-empty backup password is required.');
  }
  return password;
}

function validateHash(hash) {
  return typeof hash === 'string' && /^[a-f0-9]{64}$/i.test(hash);
}

function canonicalHash(hash) {
  return String(hash).toLowerCase();
}

function randomToken(bytes = 8) {
  return crypto.randomBytes(bytes).toString('hex');
}

function makeBackupName(createdAt) {
  const stamp = createdAt.replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  return `labmate-${stamp}-${randomToken(6)}.labmatebackup`;
}

function uniquePath(directory, stem, extension = '') {
  return path.join(directory, `${stem}-${Date.now()}-${process.pid}-${randomToken(6)}${extension}`);
}

async function writeBuffer(handle, buffer) {
  let offset = 0;
  while (offset < buffer.length) {
    const result = await handle.write(buffer, offset, buffer.length - offset);
    offset += result.bytesWritten;
  }
}

async function fsyncDirectory(directory) {
  try {
    const handle = await fsp.open(directory, 'r');
    try { await handle.sync(); } finally { await handle.close(); }
  } catch {
    // Some filesystems reject opening directories for fsync. The surrounding
    // file writes remain atomic, and callers still retain the journal or
    // staged copy when a later operation fails.
  }
}

async function readExact(handle, length, position) {
  const buffer = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const result = await handle.read(buffer, offset, length - offset, position + offset);
    if (result.bytesRead === 0) throw backupError('CORRUPT_BACKUP', 'The backup is truncated.');
    offset += result.bytesRead;
  }
  return buffer;
}

function decodeBase64(value, expectedBytes, label) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
    throw backupError('CORRUPT_BACKUP', `The backup ${label} is invalid.`);
  }
  const decoded = Buffer.from(value, 'base64');
  if (decoded.length !== expectedBytes) throw backupError('CORRUPT_BACKUP', `The backup ${label} is invalid.`);
  return decoded;
}

function parseJsonBuffer(buffer, label) {
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch (error) {
    throw backupError('CORRUPT_BACKUP', `The backup ${label} is not valid UTF-8.`, error);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw backupError('CORRUPT_BACKUP', `The backup ${label} is not valid JSON.`, error);
  }
}

function numberInRange(value, min, max) {
  return Number.isInteger(value) && value >= min && value <= max;
}

function deriveKey(password, salt) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, KEY_BYTES, {
      N: 16384,
      r: 8,
      p: 1,
      maxmem: 64 * 1024 * 1024,
    }, (error, key) => error ? reject(error) : resolve(key));
  });
}

function validateHeaderObject(header, fileSize, prefixLength, maxBackupBytes) {
  if (!header || typeof header !== 'object' || Array.isArray(header)) {
    throw backupError('CORRUPT_BACKUP', 'The backup header is invalid.');
  }
  if (header.formatVersion !== FORMAT_VERSION || header.algorithm !== 'aes-256-gcm' || header.kdf !== 'scrypt') {
    throw backupError('CORRUPT_BACKUP', 'The backup format is unsupported.');
  }
  if (!numberInRange(header.archiveBytes, 1, maxBackupBytes) || !numberInRange(header.tagBytes, AUTH_TAG_BYTES, AUTH_TAG_BYTES)) {
    throw backupError('CORRUPT_BACKUP', 'The backup size metadata is invalid.');
  }
  if (!numberInRange(header.schemaVersion, 1, Number.MAX_SAFE_INTEGER)) {
    throw backupError('CORRUPT_BACKUP', 'The backup schema version is invalid.');
  }
  if (header.schemaVersion > SUPPORTED_SCHEMA_VERSION) {
    throw backupError('CORRUPT_BACKUP', 'The backup was created by a newer LabMate schema.');
  }
  decodeBase64(header.salt, SALT_BYTES, 'salt');
  decodeBase64(header.nonce, NONCE_BYTES, 'nonce');
  if (!Number.isSafeInteger(prefixLength + header.archiveBytes + header.tagBytes) || prefixLength + header.archiveBytes + header.tagBytes !== fileSize) {
    throw backupError('CORRUPT_BACKUP', 'The backup is truncated or has unexpected trailing data.');
  }
}

async function readEncryptedHeader(source, limits) {
  const stat = await ensureRegularFile(source, 'backup');
  if (stat.size > limits.maxBackupBytes || stat.size <= MAGIC.length + HEADER_LENGTH_BYTES + AUTH_TAG_BYTES) {
    throw backupError('CORRUPT_BACKUP', 'The backup size is invalid.');
  }
  const handle = await fsp.open(source, 'r');
  try {
    const magic = await readExact(handle, MAGIC.length, 0);
    if (!magic.equals(MAGIC)) throw backupError('CORRUPT_BACKUP', 'The backup signature is invalid.');
    const lengthBuffer = await readExact(handle, HEADER_LENGTH_BYTES, MAGIC.length);
    const headerLength = lengthBuffer.readUInt32BE(0);
    if (headerLength < 2 || headerLength > 64 * 1024) throw backupError('CORRUPT_BACKUP', 'The backup header is invalid.');
    const headerBuffer = await readExact(handle, headerLength, MAGIC.length + HEADER_LENGTH_BYTES);
    const header = parseJsonBuffer(headerBuffer, 'header');
    const prefixLength = MAGIC.length + HEADER_LENGTH_BYTES + headerLength;
    validateHeaderObject(header, stat.size, prefixLength, limits.maxBackupBytes);
    const tagPosition = prefixLength + header.archiveBytes;
    const tag = await readExact(handle, header.tagBytes, tagPosition);
    return {
      stat,
      header,
      salt: decodeBase64(header.salt, SALT_BYTES, 'salt'),
      nonce: decodeBase64(header.nonce, NONCE_BYTES, 'nonce'),
      tag,
      prefixLength,
      aad: Buffer.concat([magic, lengthBuffer, headerBuffer]),
    };
  } finally {
    await handle.close();
  }
}

async function encryptArchive(zipPath, outputPath, password, metadata, job) {
  job.throwIfAborted();
  const zipStat = await ensureRegularFile(zipPath, 'archive staging file');
  if (zipStat.size < 1 || zipStat.size > metadata.maxArchiveBytes) {
    throw backupError('IO', 'The archive is outside the supported size limit.');
  }
  const salt = crypto.randomBytes(SALT_BYTES);
  const nonce = crypto.randomBytes(NONCE_BYTES);
  const key = await deriveKey(password, salt);
  const header = {
    formatVersion: FORMAT_VERSION,
    algorithm: 'aes-256-gcm',
    kdf: 'scrypt',
    salt: salt.toString('base64'),
    nonce: nonce.toString('base64'),
    archiveBytes: zipStat.size,
    tagBytes: AUTH_TAG_BYTES,
    schemaVersion: metadata.schemaVersion,
    createdAt: metadata.createdAt,
  };
  const headerBuffer = Buffer.from(JSON.stringify(header), 'utf8');
  if (headerBuffer.length > 64 * 1024) throw backupError('IO', 'The backup header is too large.');
  const prefix = Buffer.alloc(MAGIC.length + HEADER_LENGTH_BYTES);
  MAGIC.copy(prefix, 0);
  prefix.writeUInt32BE(headerBuffer.length, MAGIC.length);
  const input = fs.createReadStream(zipPath, { highWaterMark: 1024 * 1024 });
  const output = await fsp.open(outputPath, 'wx', 0o600);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.concat([prefix, headerBuffer]));
  let copied = 0;
  try {
    await writeBuffer(output, prefix);
    await writeBuffer(output, headerBuffer);
    for await (const chunk of input) {
      job.throwIfAborted();
      const encrypted = cipher.update(chunk);
      if (encrypted.length) await writeBuffer(output, encrypted);
      copied += chunk.length;
      job.progress('encrypting', 'Encrypting backup.', copied, zipStat.size);
    }
    const final = cipher.final();
    if (final.length) await writeBuffer(output, final);
    const tag = cipher.getAuthTag();
    await writeBuffer(output, tag);
    await output.sync();
  } catch (error) {
    input.destroy();
    throw error;
  } finally {
    key.fill(0);
    salt.fill(0);
    nonce.fill(0);
    await output.close();
  }
}

async function decryptArchive(source, zipPath, password, limits, job) {
  job.throwIfAborted();
  const envelope = await readEncryptedHeader(source, limits);
  if (envelope.header.archiveBytes > limits.maxArchiveBytes) throw backupError('CORRUPT_BACKUP', 'The backup archive exceeds the supported size limit.');
  const key = await deriveKey(password, envelope.salt);
  const input = fs.createReadStream(source, {
    start: envelope.prefixLength,
    end: envelope.prefixLength + envelope.header.archiveBytes - 1,
    highWaterMark: 1024 * 1024,
  });
  const output = await fsp.open(zipPath, 'wx', 0o600);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, envelope.nonce);
  decipher.setAAD(envelope.aad);
  let copied = 0;
  try {
    for await (const chunk of input) {
      job.throwIfAborted();
      const plain = decipher.update(chunk);
      if (plain.length) await writeBuffer(output, plain);
      copied += chunk.length;
      job.progress('authenticating', 'Authenticating backup.', copied, envelope.header.archiveBytes);
    }
    decipher.setAuthTag(envelope.tag);
    const final = decipher.final();
    if (final.length) await writeBuffer(output, final);
    if (copied !== envelope.header.archiveBytes) throw backupError('CORRUPT_BACKUP', 'The backup is truncated.');
    await output.sync();
  } catch (error) {
    input.destroy();
    if (error instanceof BackupError) throw error;
    throw backupError('CORRUPT_BACKUP', 'The backup failed authentication.', error);
  } finally {
    key.fill(0);
    envelope.salt.fill(0);
    envelope.nonce.fill(0);
    envelope.tag.fill(0);
    await output.close();
  }
}

function isSymlinkEntry(entry) {
  const attributes = Number(entry.externalFileAttributes) >>> 0;
  const unixMode = (attributes >>> 16) & 0xffff;
  const fileType = unixMode & 0o170000;
  return fileType === 0o120000 || fileType === 0o060000 || fileType === 0o010000;
}

function validateArchiveEntryName(name) {
  if (typeof name !== 'string' || name.length === 0 || name.length > 1024 || name.includes('\0')) {
    throw backupError('CORRUPT_BACKUP', 'The backup contains an invalid entry name.');
  }
  if (name.includes('\\') || name.startsWith('/') || name.startsWith('\\') || /^[A-Za-z]:/.test(name) || name.startsWith('//')) {
    throw backupError('CORRUPT_BACKUP', 'The backup contains an unsafe entry path.');
  }
  const pieces = name.split('/');
  if (pieces.some(piece => piece === '' || piece === '.' || piece === '..')) {
    throw backupError('CORRUPT_BACKUP', 'The backup contains a traversal entry path.');
  }
  const normalized = path.posix.normalize(name);
  if (normalized !== name || normalized.startsWith('../') || normalized === '..') {
    throw backupError('CORRUPT_BACKUP', 'The backup contains an unsafe entry path.');
  }
  return name;
}

function validateExpectedEntryName(name) {
  if (name === 'manifest.json' || name === 'library.sqlite') return;
  if (!/^objects\/[a-f0-9]{64}$/i.test(name)) {
    throw backupError('CORRUPT_BACKUP', 'The backup contains an unexpected archive entry.');
  }
}

async function writeEntryStream(zipfile, entry, target, limits, job, hashEntry) {
  const readStream = await new Promise((resolve, reject) => {
    zipfile.openReadStream(entry, (error, stream) => error ? reject(error) : resolve(stream));
  });
  const output = await fsp.open(target, 'wx', 0o600);
  let bytes = 0;
  const hash = hashEntry ? crypto.createHash('sha256') : null;
  try {
    for await (const chunk of readStream) {
      job.throwIfAborted();
      bytes += chunk.length;
      if (bytes > limits.maxFileBytes) throw backupError('CORRUPT_BACKUP', 'The backup contains an oversized file.');
      if (hash) hash.update(chunk);
      await writeBuffer(output, chunk);
    }
    if (bytes !== entry.uncompressedSize) throw backupError('CORRUPT_BACKUP', 'The backup entry size is invalid.');
    await output.sync();
    return { bytes, hash: hash ? hash.digest('hex') : null };
  } catch (error) {
    readStream.destroy();
    throw error;
  } finally {
    await output.close();
  }
}

async function extractArchive(zipPath, extractionRoot, limits, job) {
  await ensureDirectory(extractionRoot);
  const entries = [];
  const names = new Set();
  let totalBytes = 0;
  await new Promise((resolve, reject) => {
    let zipfile;
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      try { if (zipfile) zipfile.close(); } catch { /* best effort */ }
      reject(error);
    };
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    const processEntry = async (entry) => {
      job.throwIfAborted();
      const name = validateArchiveEntryName(entry.fileName);
      validateExpectedEntryName(name);
      if (names.has(name)) throw backupError('CORRUPT_BACKUP', 'The backup contains duplicate archive entries.');
      names.add(name);
      if (isSymlinkEntry(entry)) throw backupError('CORRUPT_BACKUP', 'The backup contains a symbolic link.');
      if (!numberInRange(entry.uncompressedSize, 0, limits.maxFileBytes) || !numberInRange(entry.compressedSize, 0, limits.maxFileBytes)) {
        throw backupError('CORRUPT_BACKUP', 'The backup contains an oversized entry.');
      }
      if (entry.uncompressedSize === 0 && !name.startsWith('objects/')) throw backupError('CORRUPT_BACKUP', 'The backup contains an empty manifest or database entry.');
      totalBytes += entry.uncompressedSize;
      if (totalBytes > limits.maxArchiveBytes) throw backupError('CORRUPT_BACKUP', 'The backup expands beyond the supported size limit.');
      const target = path.join(extractionRoot, ...name.split('/'));
      assertInside(extractionRoot, target, 'archive extraction path');
      await ensureDirectory(path.dirname(target));
      const result = await writeEntryStream(zipfile, entry, target, limits, job, name.startsWith('objects/'));
      entries.push({ name, size: result.bytes, hash: result.hash });
      job.progress('extracting', `Extracted ${name}.`, totalBytes, limits.maxArchiveBytes);
    };
    const openCallback = (error, opened) => {
      if (error) return fail(backupError('CORRUPT_BACKUP', 'The backup archive could not be opened.', error));
      zipfile = opened;
      zipfile.on('error', (archiveError) => fail(backupError('CORRUPT_BACKUP', 'The backup archive is corrupt.', archiveError)));
      zipfile.on('entry', (entry) => {
        if (entries.length + 1 > limits.maxEntries) return fail(backupError('CORRUPT_BACKUP', 'The backup contains too many entries.'));
        processEntry(entry).then(() => {
          if (!settled) zipfile.readEntry();
        }).catch(fail);
      });
      zipfile.on('end', finish);
      try { zipfile.readEntry(); } catch (readError) { fail(backupError('CORRUPT_BACKUP', 'The backup archive is corrupt.', readError)); }
    };
    try {
      yauzl.open(zipPath, {
        lazyEntries: true,
        autoClose: true,
        decodeStrings: true,
        validateEntrySizes: true,
      }, openCallback);
    } catch (error) {
      fail(backupError('CORRUPT_BACKUP', 'The backup archive could not be opened.', error));
    }
    if (job.signal) {
      if (job.signal.aborted) return fail(backupError('CANCELLED', 'Backup operation cancelled.'));
      job.signal.addEventListener('abort', () => fail(backupError('CANCELLED', 'Backup operation cancelled.')), { once: true });
    }
  });
  return { entries, names, totalBytes };
}

function normalizeManifestObject(value) {
  if (typeof value === 'string') return { hash: canonicalHash(value), name: `objects/${canonicalHash(value)}` };
  if (!value || typeof value !== 'object') throw backupError('CORRUPT_BACKUP', 'The backup manifest contains an invalid object.');
  const hash = canonicalHash(value.hash);
  const name = value.name || `objects/${hash}`;
  if (name !== `objects/${hash}`) throw backupError('CORRUPT_BACKUP', 'The backup manifest contains an unsafe object name.');
  return { hash, name, ...(Number.isSafeInteger(value.size) ? { size: value.size } : {}) };
}

function validateManifest(manifest, limits) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw backupError('CORRUPT_BACKUP', 'The backup manifest is invalid.');
  if (manifest.formatVersion !== FORMAT_VERSION) throw backupError('CORRUPT_BACKUP', 'The backup manifest format is unsupported.');
  if (!numberInRange(manifest.schemaVersion, 1, SUPPORTED_SCHEMA_VERSION)) {
    if (Number.isInteger(manifest.schemaVersion) && manifest.schemaVersion > SUPPORTED_SCHEMA_VERSION) {
      throw backupError('CORRUPT_BACKUP', 'The backup was created by a newer LabMate schema.');
    }
    throw backupError('CORRUPT_BACKUP', 'The backup manifest schema version is invalid.');
  }
  if (!manifest.database || typeof manifest.database !== 'object' || manifest.database.name !== 'library.sqlite') {
    throw backupError('CORRUPT_BACKUP', 'The backup manifest database entry is invalid.');
  }
  if (!numberInRange(manifest.database.size, 1, limits.maxFileBytes) || !/^[a-f0-9]{64}$/i.test(manifest.database.sha256 || '')) {
    throw backupError('CORRUPT_BACKUP', 'The backup manifest database hash is invalid.');
  }
  if (!Array.isArray(manifest.objects) || manifest.objects.length > limits.maxEntries) {
    throw backupError('CORRUPT_BACKUP', 'The backup manifest object list is invalid.');
  }
  const objects = [];
  const hashes = new Set();
  for (const value of manifest.objects) {
    const object = normalizeManifestObject(value);
    if (!validateHash(object.hash) || hashes.has(object.hash)) throw backupError('CORRUPT_BACKUP', 'The backup manifest has duplicate or invalid objects.');
    if (object.size !== undefined && !numberInRange(object.size, 0, limits.maxFileBytes)) throw backupError('CORRUPT_BACKUP', 'The backup manifest object size is invalid.');
    hashes.add(object.hash);
    objects.push(object);
  }
  return { ...manifest, schemaVersion: manifest.schemaVersion, database: { ...manifest.database, sha256: canonicalHash(manifest.database.sha256) }, objects, hashes };
}

async function hashFile(filePath, limit, job, minimumSize = 0) {
  const stat = await ensureRegularFile(filePath, 'backup file');
  if (stat.size < minimumSize || stat.size > limit) throw backupError('CORRUPT_BACKUP', 'The backup file size is invalid.');
  const hash = crypto.createHash('sha256');
  let bytes = 0;
  const input = fs.createReadStream(filePath, { highWaterMark: 1024 * 1024 });
  for await (const chunk of input) {
    job.throwIfAborted();
    bytes += chunk.length;
    hash.update(chunk);
  }
  return { size: bytes, sha256: hash.digest('hex') };
}

function loadSqliteDriver(options) {
  if (options && options.sqlite) return options.sqlite;
  try {
    // better-sqlite3 is a native dependency and is intentionally loaded only
    // when validating a candidate. This keeps backup.js importable in tooling
    // that does not load Electron's native modules.
    return require('better-sqlite3');
  } catch {
    return null;
  }
}

function schemaTablesFromDb(db) {
  if (!db || typeof db.prepare !== 'function') return [];
  try {
    return db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row => row.name).filter(name => typeof name === 'string');
  } catch {
    return [];
  }
}

function schemaColumnsFromDb(db, tableName) {
  if (!db || typeof db.prepare !== 'function') return [];
  try {
    return db.prepare(`PRAGMA table_info(${quoteIdentifier(tableName)})`).all().map(row => row.name).filter(name => typeof name === 'string');
  } catch {
    return [];
  }
}

function quoteIdentifier(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

function validateCandidateSchema(candidatePath, manifestSchemaVersion, store, options) {
  if (options && typeof options.validateDatabase === 'function') {
    const customResult = options.validateDatabase(candidatePath, manifestSchemaVersion);
    if (customResult && typeof customResult.then === 'function') {
      throw backupError('UNAVAILABLE', 'The configured database validator must be synchronous.');
    }
  }
  const Database = loadSqliteDriver(options);
  if (!Database) {
    // The SQLite magic is still checked by the caller. A deployment without a
    // SQLite driver cannot run PRAGMA integrity_check, so an explicit validator
    // can supply the stronger check during packaging or a native test harness.
    return null;
  }
  let db;
  try {
    db = new Database(candidatePath, { readonly: true, fileMustExist: true });
    const integrity = db.pragma('integrity_check', { simple: true });
    if (integrity !== 'ok') throw backupError('CORRUPT_BACKUP', 'The restored SQLite database failed integrity_check.');
    const foreignKeyViolations = db.prepare('PRAGMA foreign_key_check').all();
    if (foreignKeyViolations.length > 0) throw backupError('CORRUPT_BACKUP', 'The restored SQLite database failed foreign_key_check.');
    const userVersion = Number(db.pragma('user_version', { simple: true }));
    if (Number.isInteger(userVersion) && userVersion > SUPPORTED_SCHEMA_VERSION) {
      throw backupError('CORRUPT_BACKUP', 'The restored database uses a newer schema.');
    }
    if (!Number.isInteger(userVersion) || userVersion !== manifestSchemaVersion) {
      throw backupError('CORRUPT_BACKUP', 'The database schema does not match the backup manifest.');
    }
    const requiredColumns = columnsForVersion(manifestSchemaVersion);
    const currentTables = Object.keys(requiredColumns);
    const candidateTables = schemaTablesFromDb(db);
    for (const table of currentTables) {
      if (!candidateTables.includes(table)) throw backupError('CORRUPT_BACKUP', 'The restored database schema is missing a table.');
      const currentColumns = requiredColumns[table];
      const candidateColumns = schemaColumnsFromDb(db, table);
      for (const column of currentColumns) {
        if (!candidateColumns.includes(column)) throw backupError('CORRUPT_BACKUP', 'The restored database schema is missing a column.');
      }
    }
    if (candidateTables.includes('documents')) {
      const documentColumns = schemaColumnsFromDb(db, 'documents');
      if (!documentColumns.includes('document_schema_version')) {
        throw backupError('CORRUPT_BACKUP', 'The restored database is missing document schema versions.');
      }
      const unsupportedDocument = db.prepare(
        'SELECT run_id FROM documents WHERE document_schema_version <> 1 LIMIT 1',
      ).get();
      if (unsupportedDocument) {
        throw backupError('CORRUPT_BACKUP', 'The restored database contains an unsupported document schema version.');
      }
    }
    const attachmentTable = ['attachments', 'attachment'].find(table => candidateTables.includes(table));
    if (attachmentTable) {
      const columns = schemaColumnsFromDb(db, attachmentTable);
      if (columns.includes('hash')) {
        const selectedColumns = columns.includes('size') ? 'hash, size' : 'hash';
        const rows = db.prepare(`SELECT ${selectedColumns} FROM ${quoteIdentifier(attachmentTable)}`).all();
        return {
          attachmentHashes: rows.map(row => row.hash).filter(hash => typeof hash === 'string').map(canonicalHash),
          attachmentRecords: rows.map(row => ({ hash: typeof row.hash === 'string' ? canonicalHash(row.hash) : row.hash, size: row.size })),
        };
      }
    }
    return { attachmentHashes: null, attachmentRecords: null };
  } catch (error) {
    if (error instanceof BackupError) throw error;
    throw backupError('CORRUPT_BACKUP', 'The restored SQLite database could not be validated.', error);
  } finally {
    if (db) {
      try { db.close(); } catch { /* best effort */ }
    }
  }
}

async function validateExtractedArchive(extractionRoot, extracted, manifest, limits, job, store, options) {
  const names = extracted.names;
  if (!names.has('manifest.json') || !names.has('library.sqlite')) {
    throw backupError('CORRUPT_BACKUP', 'The backup is missing its manifest or database.');
  }
  const manifestStat = await ensureRegularFile(path.join(extractionRoot, 'manifest.json'), 'manifest');
  if (manifestStat.size > limits.maxManifestBytes) throw backupError('CORRUPT_BACKUP', 'The backup manifest is too large.');
  const manifestBuffer = await fsp.readFile(path.join(extractionRoot, 'manifest.json'));
  const parsedManifest = validateManifest(parseJsonBuffer(manifestBuffer, 'manifest'), limits);
  if (parsedManifest.schemaVersion !== manifest.schemaVersion) throw backupError('CORRUPT_BACKUP', 'The backup schema metadata does not match.');
  const expectedNames = new Set(['manifest.json', 'library.sqlite', ...parsedManifest.objects.map(object => object.name)]);
  if (names.size !== expectedNames.size || [...names].some(name => !expectedNames.has(name))) {
    throw backupError('CORRUPT_BACKUP', 'The backup does not contain exactly its manifest objects.');
  }
  const dbHash = await hashFile(path.join(extractionRoot, 'library.sqlite'), limits.maxFileBytes, job);
  if (dbHash.size !== parsedManifest.database.size || dbHash.sha256 !== parsedManifest.database.sha256) {
    throw backupError('CORRUPT_BACKUP', 'The restored database hash does not match its manifest.');
  }
  for (const object of parsedManifest.objects) {
    const objectPath = path.join(extractionRoot, object.name);
    const objectHash = await hashFile(objectPath, limits.maxFileBytes, job, 0);
    if (object.size !== undefined && objectHash.size !== object.size) throw backupError('CORRUPT_BACKUP', 'A restored object size does not match its manifest.');
    if (objectHash.sha256 !== object.hash) throw backupError('CORRUPT_BACKUP', 'A restored object hash does not match its manifest.');
  }
  const dbHeader = await fsp.open(path.join(extractionRoot, 'library.sqlite'), 'r');
  try {
    const sqliteMagic = await readExact(dbHeader, 16, 0);
    if (!sqliteMagic.equals(Buffer.from('SQLite format 3\0', 'ascii'))) {
      throw backupError('CORRUPT_BACKUP', 'The restored database is not a SQLite database.');
    }
  } finally {
    await dbHeader.close();
  }
  const schemaResult = validateCandidateSchema(path.join(extractionRoot, 'library.sqlite'), parsedManifest.schemaVersion, store, options);
  if (schemaResult && schemaResult.attachmentHashes) {
    const expectedHashes = [...parsedManifest.hashes].sort();
    const actualHashes = [...new Set(schemaResult.attachmentHashes)].sort();
    if (expectedHashes.length !== actualHashes.length || expectedHashes.some((hash, index) => hash !== actualHashes[index])) {
      throw backupError('CORRUPT_BACKUP', 'The restored database references objects missing from the manifest.');
    }
    if (schemaResult.attachmentRecords) {
      const objectSizes = new Map(parsedManifest.objects.map(object => [object.hash, object.size]));
      for (const record of schemaResult.attachmentRecords) {
        if (!validateHash(record.hash) || !Number.isSafeInteger(Number(record.size)) || !objectSizes.has(record.hash)
          || (objectSizes.get(record.hash) !== undefined && Number(record.size) !== objectSizes.get(record.hash))) {
          throw backupError('CORRUPT_BACKUP', 'The restored attachment metadata does not match its object.');
        }
      }
    }
  }
  return parsedManifest;
}

async function createZipArchive(archivePath, dbPath, manifest, objectPaths, job) {
  job.throwIfAborted();
  const output = fs.createWriteStream(archivePath, { flags: 'wx', mode: 0o600 });
  const archive = new ZipArchive({ zlib: { level: 9 } });
  const completed = new Promise((resolve, reject) => {
    output.once('close', resolve);
    output.once('error', reject);
    archive.once('error', reject);
    archive.once('warning', (error) => {
      if (error && error.code === 'ENOENT') reject(error);
    });
  });
  const abort = () => {
    try { archive.abort(); } catch { /* best effort */ }
    output.destroy(backupError('CANCELLED', 'Backup operation cancelled.'));
  };
  if (job.signal) {
    if (job.signal.aborted) abort();
    else job.signal.addEventListener('abort', abort, { once: true });
  }
  archive.pipe(output);
  try {
    archive.append(Buffer.from(JSON.stringify(manifest), 'utf8'), { name: 'manifest.json' });
    archive.file(dbPath, { name: 'library.sqlite' });
    for (const object of objectPaths) archive.file(object.path, { name: object.name });
    job.progress('archiving', 'Building encrypted backup archive.');
    await archive.finalize();
    await completed;
  } catch (error) {
    output.destroy();
    throw error;
  } finally {
    if (job.signal) job.signal.removeEventListener('abort', abort);
  }
}

async function copyFileAtomic(source, target, limits, job) {
  const sourceStat = await ensureRegularFile(source, 'local backup');
  if (sourceStat.size > limits.maxBackupBytes) throw backupError('IO', 'The backup exceeds the supported size limit.');
  const sourceDigest = await hashFile(source, limits.maxBackupBytes, job, 1);
  const parent = path.dirname(target);
  const parentStat = await lstatOrNull(parent);
  if (!parentStat || parentStat.isSymbolicLink() || !parentStat.isDirectory()) throw backupError('UNAVAILABLE', 'The backup destination is unavailable.');
  const temporary = path.join(parent, `.${path.basename(target)}.partial-${randomToken(8)}`);
  const input = fs.createReadStream(source, { highWaterMark: 1024 * 1024 });
  const output = await fsp.open(temporary, 'wx', 0o600);
  let copied = 0;
  try {
    for await (const chunk of input) {
      job.throwIfAborted();
      await writeBuffer(output, chunk);
      copied += chunk.length;
      job.progress('copying', 'Copying verified backup to destination.', copied, sourceStat.size);
    }
    if (copied !== sourceStat.size) throw backupError('IO', 'The backup copy was incomplete.');
    await output.sync();
    await output.close();
    const destinationDigest = await hashFile(temporary, limits.maxBackupBytes, job, 1);
    if (destinationDigest.size !== sourceDigest.size || destinationDigest.sha256 !== sourceDigest.sha256) {
      throw backupError('IO', 'The verified backup copy did not match its source.');
    }
    await fsp.rename(temporary, target);
    await fsyncDirectory(parent);
  } catch (error) {
    input.destroy();
    try { await output.close(); } catch { /* best effort */ }
    try { await fsp.rm(temporary, { force: true }); } catch { /* best effort */ }
    throw error;
  }
}

async function uniqueDestinationTarget(destination, name) {
  const destinationStat = await lstatOrNull(destination);
  if (!destinationStat || destinationStat.isSymbolicLink()) throw backupError('UNAVAILABLE', 'The backup destination is unavailable.');
  let directory = destination;
  const explicitFile = destinationStat.isFile() && destination.toLowerCase().endsWith('.labmatebackup');
  if (destinationStat.isFile()) directory = path.dirname(destination);
  if (!destinationStat.isDirectory() && !destinationStat.isFile()) throw backupError('UNAVAILABLE', 'The backup destination is unavailable.');
  const requestedName = explicitFile ? path.basename(destination) : name;
  const base = path.basename(requestedName, '.labmatebackup');
  for (let index = 0; index < 1000; index += 1) {
    const candidateName = index === 0 ? requestedName : `${base}-${index}.labmatebackup`;
    const candidate = path.join(directory, candidateName);
    if (!await lstatOrNull(candidate)) return candidate;
  }
  throw backupError('UNAVAILABLE', 'The backup destination has no available filename.');
}

async function retainLocalBackups(backupsRoot, retention) {
  const entries = await fsp.readdir(backupsRoot, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (!entry.name.endsWith('.labmatebackup')) continue;
    const candidate = path.join(backupsRoot, entry.name);
    const stat = await lstatOrNull(candidate);
    if (stat && stat.isFile() && !stat.isSymbolicLink()) files.push({ path: candidate, mtimeMs: stat.mtimeMs });
  }
  files.sort((a, b) => b.mtimeMs - a.mtimeMs || b.path.localeCompare(a.path));
  for (const file of files.slice(Math.max(0, retention))) {
    try { await fsp.rm(file.path, { force: true }); } catch { /* retention is best effort */ }
  }
}

function attachmentObjects(snapshot, objectsRoot) {
  const attachments = Array.isArray(snapshot && snapshot.attachments) ? snapshot.attachments : [];
  const byHash = new Map();
  for (const attachment of attachments) {
    if (!attachment || !validateHash(attachment.hash)) throw backupError('IO', 'An attachment has an invalid object hash.');
    const hash = canonicalHash(attachment.hash);
    if (!byHash.has(hash)) byHash.set(hash, { hash, name: `objects/${hash}`, path: path.join(objectsRoot, hash) });
  }
  return [...byHash.values()].sort((a, b) => a.hash.localeCompare(b.hash));
}

async function validateObjectSources(objects, maxFileBytes, job) {
  for (const object of objects) {
    const stat = await ensureRegularFile(object.path, 'attachment object');
    if (stat.size > maxFileBytes) throw backupError('IO', 'An attachment object is outside the supported size limit.');
    const hash = await hashFile(object.path, maxFileBytes, job);
    if (hash.sha256 !== object.hash || hash.size !== stat.size) throw backupError('IO', 'An attachment object hash does not match its name.');
    object.size = stat.size;
  }
}

async function currentLibraryForRollback(store, root, rollbackPath, job, maxFileBytes) {
  const dbPath = path.resolve(store.databasePath || path.join(root, 'library.sqlite'));
  const objectsRoot = path.resolve(root, 'objects');
  assertInside(root, dbPath, 'database path');
  assertInside(root, objectsRoot, 'objects path');
  const dbStat = await lstatOrNull(dbPath);
  if (dbStat) {
    if (dbStat.isSymbolicLink() || !dbStat.isFile()) throw backupError('IO', 'The current library database is not a regular file.');
    if (dbStat.size > maxFileBytes) throw backupError('IO', 'The current library database is too large to retain for rollback.');
    if (typeof store.backupDatabase === 'function') {
      await store.backupDatabase(path.join(rollbackPath, 'library.sqlite'));
    } else {
      // This fallback is retained for small test doubles. A live LibraryStore
      // always exposes backupDatabase, which is required for WAL-safe copies.
      await fsp.copyFile(dbPath, path.join(rollbackPath, 'library.sqlite'));
    }
    await ensureRegularFile(path.join(rollbackPath, 'library.sqlite'), 'rollback database');
  }
  const oldObjects = await lstatOrNull(objectsRoot);
  if (oldObjects) {
    if (oldObjects.isSymbolicLink() || !oldObjects.isDirectory()) throw backupError('IO', 'The current objects directory is unsafe.');
    await ensureDirectory(path.join(rollbackPath, 'objects'));
    const snapshot = typeof store.snapshot === 'function' ? store.snapshot() : null;
    const objects = attachmentObjects(snapshot, objectsRoot);
    await validateObjectSources(objects, maxFileBytes, job);
    for (const object of objects) {
      await fsp.copyFile(object.path, path.join(rollbackPath, 'objects', object.hash));
    }
  }
  return { dbPath, objectsRoot };
}

async function pathExists(filePath) {
  return Boolean(await lstatOrNull(filePath));
}

async function safeRename(source, target) {
  if (!await pathExists(source)) return false;
  await fsp.rename(source, target);
  return true;
}

function journalRelative(root, filePath) {
  const relative = path.relative(root, filePath);
  if (!relative || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
    throw backupError('IO', 'The restore journal path is outside the library.');
  }
  return relative;
}

async function writeRestoreJournal(root, journal) {
  const journalPath = path.join(root, RESTORE_JOURNAL_NAME);
  const temporary = `${journalPath}.partial-${randomToken(8)}`;
  const payload = Buffer.from(JSON.stringify({ ...journal, state: journal.phase === 'committed' ? 'complete' : 'in-progress' }), 'utf8');
  const handle = await fsp.open(temporary, 'wx', 0o600);
  try {
    await writeBuffer(handle, payload);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fsp.rename(temporary, journalPath);
  await fsyncDirectory(path.dirname(journalPath));
}

async function removeRestoreJournal(root) {
  try { await fsp.rm(path.join(root, RESTORE_JOURNAL_NAME), { force: true }); } catch { /* caller decides whether to preserve it */ }
}

function validateJournalPath(root, value) {
  if (typeof value !== 'string' || value.length === 0 || path.isAbsolute(value) || value.includes('\0')) {
    throw backupError('IO', 'The restore journal is invalid.');
  }
  const resolved = path.resolve(root, value);
  assertInside(root, resolved, 'restore journal path');
  return resolved;
}

/**
 * Recover a restore switch after a process interruption. LibraryStore calls
 * this before opening its database. An unfinished switch is always rolled
 * back to the old paths; a switch marked opened/committed is finalized.
 */
function recoverRestoreJournal(rootValue) {
  const root = path.resolve(rootValue);
  const journalPath = path.join(root, RESTORE_JOURNAL_NAME);
  const legacyJournalPath = path.join(root, '.labmate-restore-journal.json');
  const existingJournal = filePath => {
    try {
      const stats = fs.lstatSync(filePath);
      if (stats.isSymbolicLink() || !stats.isFile()) throw backupError('IO', 'The restore journal is not a regular file.');
      return true;
    } catch (error) {
      if (error && error.code === 'ENOENT') return false;
      throw error;
    }
  };
  const activeJournalPath = existingJournal(journalPath) ? journalPath : legacyJournalPath;
  if (activeJournalPath === legacyJournalPath && fs.existsSync(legacyJournalPath)) existingJournal(legacyJournalPath);
  let journal;
  try {
    journal = JSON.parse(fs.readFileSync(activeJournalPath, 'utf8'));
  } catch (error) {
    if (error && error.code === 'ENOENT') return { recovered: false };
    throw backupError('IO', 'The restore journal could not be read.', error);
  }
  if (!journal || journal.version !== 1 || typeof journal.phase !== 'string') {
    throw backupError('IO', 'The restore journal is invalid.');
  }
  const validPhases = new Set(['prepared', 'db-moved', 'objects-moved', 'candidate-db-moved', 'candidate-objects-moved', 'opened', 'committed']);
  if (!validPhases.has(journal.phase)) throw backupError('IO', 'The restore journal has an unsupported phase.');
  if (journal.state !== undefined && journal.state !== 'in-progress' && journal.state !== 'complete') {
    throw backupError('IO', 'The restore journal has an unsupported state.');
  }
  const dbPath = validateJournalPath(root, journal.dbPath);
  const objectsPath = validateJournalPath(root, journal.objectsPath);
  const oldDb = validateJournalPath(root, journal.oldDb);
  const oldObjects = validateJournalPath(root, journal.oldObjects);
  const candidateDb = validateJournalPath(root, journal.candidateDb);
  const candidateObjects = validateJournalPath(root, journal.candidateObjects);
  const rollbackPath = validateJournalPath(root, journal.rollbackPath);
  const journalPaths = [dbPath, objectsPath, oldDb, oldObjects, candidateDb, candidateObjects, rollbackPath];
  if (new Set(journalPaths).size !== journalPaths.length) throw backupError('IO', 'The restore journal contains duplicate paths.');
  for (const target of journalPaths) {
    try {
      const stats = fs.lstatSync(target);
      if (stats.isSymbolicLink()) throw backupError('IO', 'The restore journal references a symbolic link.');
    } catch (error) {
      if (error && error.code !== 'ENOENT') throw error;
    }
  }
  const complete = journal.phase === 'opened' || journal.phase === 'committed';
  try {
    if (complete) {
      if (!fs.existsSync(dbPath)) throw backupError('IO', 'The completed restore is missing its live database.');
      fs.rmSync(oldDb, { force: true });
      fs.rmSync(oldObjects, { recursive: true, force: true });
      fs.rmSync(candidateDb, { force: true });
      fs.rmSync(candidateObjects, { recursive: true, force: true });
      fs.rmSync(activeJournalPath, { force: true });
      return { recovered: true, phase: 'committed' };
    }
    // Remove any candidate that made it into the live location, then put the
    // old path back. The old paths are rename-only swap files, so this remains
    // atomic and does not depend on copying a live WAL database.
    if (!fs.existsSync(dbPath) && !fs.existsSync(oldDb)) {
      throw backupError('IO', 'The interrupted restore has no live or rollback database.');
    }
    const liveDb = fs.existsSync(dbPath);
    const oldDbExists = fs.existsSync(oldDb);
    if (oldDbExists) {
      if (liveDb) fs.rmSync(dbPath, { force: true });
      fs.renameSync(oldDb, dbPath);
    }
    const liveObjects = fs.existsSync(objectsPath);
    const oldObjectsExists = fs.existsSync(oldObjects);
    if (oldObjectsExists) {
      if (liveObjects) fs.rmSync(objectsPath, { recursive: true, force: true });
      fs.renameSync(oldObjects, objectsPath);
    }
    fs.rmSync(candidateDb, { force: true });
    fs.rmSync(candidateObjects, { recursive: true, force: true });
    fs.rmSync(rollbackPath, { recursive: true, force: true });
    fs.rmSync(activeJournalPath, { force: true });
    return { recovered: true, phase: 'rolled-back' };
  } catch (error) {
    // Leave both journal and swap/rollback paths intact. A later startup can
    // retry recovery, and an operator can still inspect the retained rollback.
    throw backupError('IO', 'The interrupted restore could not be recovered.', error);
  }
}

async function switchLibrary(store, root, extractionRoot, rollbackPath, job, options = {}) {
  const dbPath = path.resolve(store.databasePath || path.join(root, 'library.sqlite'));
  const objectsRoot = path.resolve(root, 'objects');
  const candidateDb = path.join(extractionRoot, 'library.sqlite');
  const candidateObjects = path.join(extractionRoot, 'objects');
  assertInside(root, dbPath, 'database path');
  assertInside(root, objectsRoot, 'objects path');
  const swapRoot = path.join(extractionRoot, 'swap');
  await ensureDirectory(swapRoot);
  const oldDb = path.join(swapRoot, 'library.sqlite');
  const oldObjects = path.join(swapRoot, 'objects');
  const journal = {
    version: 1,
    phase: 'prepared',
    dbPath: journalRelative(root, dbPath),
    objectsPath: journalRelative(root, objectsRoot),
    oldDb: journalRelative(root, oldDb),
    oldObjects: journalRelative(root, oldObjects),
    candidateDb: journalRelative(root, candidateDb),
    candidateObjects: journalRelative(root, candidateObjects),
    rollbackPath: journalRelative(root, rollbackPath),
  };
  let currentDbMoved = false;
  let currentObjectsMoved = false;
  let candidateDbMoved = false;
  let candidateObjectsMoved = false;
  let storeClosed = false;
  const notifyPhase = async () => {
    if (typeof options.onSwitchPhase === 'function') await options.onSwitchPhase(journal.phase, { root, rollbackPath });
  };
  try {
    job.throwIfAborted();
    if (typeof store.close !== 'function' || typeof store.reopen !== 'function') throw backupError('IO', 'The library store cannot be reopened for restore.');
    await writeRestoreJournal(root, journal);
    await notifyPhase();
    await store.close();
    storeClosed = true;
    currentDbMoved = await safeRename(dbPath, oldDb);
    journal.phase = 'db-moved';
    await writeRestoreJournal(root, journal);
    await notifyPhase();
    currentObjectsMoved = await safeRename(objectsRoot, oldObjects);
    journal.phase = 'objects-moved';
    await writeRestoreJournal(root, journal);
    await notifyPhase();
    job.progress('switching', 'Switching the restored library into place.');
    await fsp.rename(candidateDb, dbPath);
    candidateDbMoved = true;
    journal.phase = 'candidate-db-moved';
    await writeRestoreJournal(root, journal);
    await notifyPhase();
    await ensureDirectory(path.dirname(candidateObjects));
    candidateObjectsMoved = await safeRename(candidateObjects, objectsRoot);
    if (!candidateObjectsMoved) {
      await ensureDirectory(objectsRoot);
      candidateObjectsMoved = true;
    }
    journal.phase = 'candidate-objects-moved';
    await writeRestoreJournal(root, journal);
    await notifyPhase();
    job.throwIfAborted();
    await store.reopen();
    journal.phase = 'opened';
    await writeRestoreJournal(root, journal);
    await notifyPhase();
    const snapshot = store.snapshot();
    await fsp.rm(oldDb, { force: true });
    await fsp.rm(oldObjects, { recursive: true, force: true });
    journal.phase = 'committed';
    await writeRestoreJournal(root, journal);
    await notifyPhase();
    await fsp.rm(path.join(root, RESTORE_JOURNAL_NAME), { force: true });
    return snapshot;
  } catch (error) {
    const switchStarted = currentDbMoved || currentObjectsMoved || candidateDbMoved || candidateObjectsMoved;
    if (!switchStarted) {
      try {
        await fsp.rm(path.join(root, RESTORE_JOURNAL_NAME), { force: true });
      } catch (cleanupError) {
        const failedCleanup = asBackupError(error, 'IO', 'Restoring the library failed.');
        failedCleanup.cause = { error, cleanupError };
        failedCleanup.preserveStaging = true;
        throw failedCleanup;
      }
      throw asBackupError(error, 'IO', 'Restoring the library failed.');
    }
    let rollbackError = null;
    try {
      if (storeClosed) {
        try { await store.close(); } catch { /* best effort */ }
      }
      if (candidateDbMoved) await fsp.rm(dbPath, { force: true });
      if (candidateObjectsMoved) await fsp.rm(objectsRoot, { recursive: true, force: true });
      if (currentDbMoved) await fsp.rename(oldDb, dbPath);
      else if (await pathExists(path.join(rollbackPath, 'library.sqlite'))) await fsp.copyFile(path.join(rollbackPath, 'library.sqlite'), dbPath);
      if (currentObjectsMoved) await fsp.rename(oldObjects, objectsRoot);
      else if (await pathExists(path.join(rollbackPath, 'objects'))) {
        await ensureDirectory(objectsRoot);
        // Recovery must finish even when the user cancelled the job while a
        // switch was in flight; otherwise cancellation could strand a closed
        // store with the candidate library half-installed.
        await copyDirectoryFiles(path.join(rollbackPath, 'objects'), objectsRoot);
      }
      if (storeClosed) await store.reopen();
      await fsp.rm(path.join(root, RESTORE_JOURNAL_NAME), { force: true });
    } catch (restoreError) {
      rollbackError = restoreError;
    }
    const wrapped = asBackupError(error, 'IO', 'Restoring the library failed.');
    if (rollbackError) {
      wrapped.cause = { error, rollbackError };
      wrapped.preserveStaging = true;
    }
    throw wrapped;
  }
}

async function copyDirectoryFiles(source, target, job = null) {
  const entries = await fsp.readdir(source, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.includes('/') || entry.name.includes('\\') || entry.name === '.' || entry.name === '..') throw backupError('IO', 'The rollback directory is unsafe.');
    const from = path.join(source, entry.name);
    const to = path.join(target, entry.name);
    if (entry.isSymbolicLink() || !entry.isFile()) throw backupError('IO', 'The rollback directory contains an unsafe file.');
    if (job) job.throwIfAborted();
    await fsp.copyFile(from, to, fs.constants.COPYFILE_EXCL);
  }
}

function createBackupService(store, options = {}) {
  if (!store || typeof store !== 'object') throw new TypeError('createBackupService requires a library store.');
  const root = normalizeRoot(options.root, store.root || process.cwd());
  const backupsRoot = normalizeRoot(options.backupsRoot, path.join(root, 'backups'));
  const stagingRoot = normalizeRoot(options.stagingRoot, path.join(root, 'staging'));
  const rollbackRoot = normalizeRoot(options.rollbackRoot, path.join(root, 'rollback'));
  assertInside(root, backupsRoot, 'backup directory');
  assertInside(root, stagingRoot, 'staging directory');
  assertInside(root, rollbackRoot, 'rollback directory');
  const limits = {
    maxBackupBytes: Number.isSafeInteger(options.maxBackupBytes) ? options.maxBackupBytes : DEFAULT_MAX_BACKUP_BYTES,
    maxArchiveBytes: Number.isSafeInteger(options.maxArchiveBytes) ? options.maxArchiveBytes : DEFAULT_MAX_ARCHIVE_BYTES,
    maxFileBytes: Number.isSafeInteger(options.maxFileBytes) ? options.maxFileBytes : DEFAULT_MAX_FILE_BYTES,
    maxEntries: Number.isSafeInteger(options.maxEntries) ? options.maxEntries : DEFAULT_MAX_ENTRIES,
    maxManifestBytes: Number.isSafeInteger(options.maxManifestBytes) ? options.maxManifestBytes : DEFAULT_MAX_MANIFEST_BYTES,
  };
  const retention = Number.isSafeInteger(options.localRetention) ? Math.max(1, options.localRetention) : DEFAULT_LOCAL_RETENTION;

  async function withBackupLock(operation) {
    if (typeof store.backupLocks === 'number') store.backupLocks += 1;
    try {
      return await operation();
    } finally {
      if (typeof store.backupLocks === 'number') store.backupLocks = Math.max(0, store.backupLocks - 1);
    }
  }

  async function create(request = {}, context = {}) {
    const password = validatePassword(request.password);
    const destination = request.destination;
    const createdAt = new Date().toISOString();
    const job = makeJobContext(context, request.jobId, 'backup.create');
    return withBackupLock(async () => {
      const stage = uniquePath(stagingRoot, 'backup-create');
      const archiveStage = path.join(stage, 'archive.zip');
      const encryptedStage = path.join(stage, 'backup.labmatebackup');
      let localPath;
      try {
        job.throwIfAborted();
        await ensureDirectory(backupsRoot);
        await ensureDirectory(stagingRoot);
        await ensureDirectory(stage);
        job.progress('snapshot', 'Capturing a consistent library snapshot.');
        const snapshot = typeof store.snapshot === 'function' ? store.snapshot() : null;
        if (!snapshot || !numberInRange(snapshot.schemaVersion, 1, SUPPORTED_SCHEMA_VERSION)) {
          throw backupError('IO', 'The library snapshot schema is unsupported.');
        }
        const databasePath = path.resolve(store.databasePath || path.join(root, 'library.sqlite'));
        const objectsRoot = path.resolve(options.objectsRoot || path.join(root, 'objects'));
        assertInside(root, databasePath, 'database path');
        assertInside(root, objectsRoot, 'objects path');
        const objects = attachmentObjects(snapshot, objectsRoot);
        await validateObjectSources(objects, limits.maxFileBytes, job);
        const dbStage = path.join(stage, 'library.sqlite');
        if (typeof store.backupDatabase === 'function') await store.backupDatabase(dbStage);
        else {
          await ensureRegularFile(databasePath, 'library database');
          await fsp.copyFile(databasePath, dbStage);
        }
        const dbHash = await hashFile(dbStage, limits.maxFileBytes, job);
        validateCandidateSchema(dbStage, snapshot.schemaVersion, store, options);
        const manifest = {
          formatVersion: FORMAT_VERSION,
          schemaVersion: snapshot.schemaVersion,
          createdAt,
          database: { name: 'library.sqlite', size: dbHash.size, sha256: dbHash.sha256 },
          objects: objects.map(object => ({ name: object.name, hash: object.hash, size: object.size })),
        };
        await createZipArchive(archiveStage, dbStage, manifest, objects, job);
        await encryptArchive(archiveStage, encryptedStage, password, { schemaVersion: snapshot.schemaVersion, createdAt, maxArchiveBytes: limits.maxArchiveBytes }, job);
        const name = makeBackupName(createdAt);
        localPath = path.join(backupsRoot, name);
        job.progress('validating', 'Validating the local encrypted backup.');
        const validationStage = path.join(stage, 'validation');
        await ensureDirectory(validationStage);
        const validationZip = path.join(validationStage, 'archive.zip');
        const validationContent = path.join(validationStage, 'content');
        await decryptArchive(encryptedStage, validationZip, password, limits, job);
        const extracted = await extractArchive(validationZip, validationContent, limits, job);
        const checkedManifest = await validateExtractedArchive(validationContent, extracted, manifest, limits, job, store, options);
        if (checkedManifest.schemaVersion !== manifest.schemaVersion) throw backupError('CORRUPT_BACKUP', 'The local backup schema validation failed.');
        await fsp.rename(encryptedStage, localPath);
        await fsyncDirectory(backupsRoot);
        await retainLocalBackups(backupsRoot, retention);
        job.throwIfAborted();
        let copiedToDestination = false;
        if (destination !== undefined && destination !== null && destination !== '') {
          const destinationTarget = await uniqueDestinationTarget(String(destination), name);
          if (path.resolve(destinationTarget) !== path.resolve(localPath)) {
            if (typeof options.copyFile === 'function') await options.copyFile(localPath, destinationTarget, job);
            else await copyFileAtomic(localPath, destinationTarget, limits, job);
            copiedToDestination = true;
          }
        }
        job.progress('complete', 'Encrypted backup created.', 1, 1);
        return {
          name,
          createdAt,
          message: copiedToDestination ? 'Saved to Box Drive; upload managed by Box.' : 'Encrypted LabMate backup created.',
        };
      } catch (error) {
        throw asBackupError(error, error && error.code === 'UNAVAILABLE' ? 'UNAVAILABLE' : 'IO', 'Creating the encrypted backup failed.');
      } finally {
        try { await fsp.rm(stage, { recursive: true, force: true }); } catch { /* staging cleanup is best effort */ }
      }
    });
  }

  async function restore(request = {}, context = {}) {
    const password = validatePassword(request.password);
    if (typeof request.source !== 'string' || request.source.length === 0) throw backupError('VALIDATION', 'A backup source is required.');
    const source = path.resolve(request.source);
    const job = makeJobContext(context, request.jobId, 'backup.restore');
    return withBackupLock(async () => {
      const stage = uniquePath(stagingRoot, 'backup-restore');
      const decryptStage = path.join(stage, 'archive.zip');
      const extractionRoot = path.join(stage, 'content');
      const rollbackPath = path.join(rollbackRoot, `rollback-${Date.now()}-${process.pid}-${randomToken(8)}`);
      let preserveStaging = false;
      try {
        job.throwIfAborted();
        await ensureDirectory(stagingRoot);
        await ensureDirectory(rollbackRoot);
        await ensureDirectory(stage);
        const envelope = await readEncryptedHeader(source, limits);
        if (envelope.header.schemaVersion > SUPPORTED_SCHEMA_VERSION) throw backupError('CORRUPT_BACKUP', 'The backup was created by a newer LabMate schema.');
        await decryptArchive(source, decryptStage, password, limits, job);
        const extracted = await extractArchive(decryptStage, extractionRoot, limits, job);
        const manifestPath = path.join(extractionRoot, 'manifest.json');
        if (!extracted.names.has('manifest.json')) throw backupError('CORRUPT_BACKUP', 'The backup is missing its manifest.');
        const manifestStat = await ensureRegularFile(manifestPath, 'manifest');
        if (manifestStat.size > limits.maxManifestBytes) throw backupError('CORRUPT_BACKUP', 'The backup manifest is too large.');
        const rawManifest = parseJsonBuffer(await fsp.readFile(manifestPath), 'manifest');
        const manifest = validateManifest(rawManifest, limits);
        if (manifest.schemaVersion !== envelope.header.schemaVersion) throw backupError('CORRUPT_BACKUP', 'The backup schema metadata does not match.');
        await validateExtractedArchive(extractionRoot, extracted, manifest, limits, job, store, options);
        await ensureDirectory(rollbackPath);
        await currentLibraryForRollback(store, root, rollbackPath, job, limits.maxFileBytes);
        job.throwIfAborted();
        const snapshot = await switchLibrary(store, root, extractionRoot, rollbackPath, job, options);
        job.progress('complete', 'Encrypted backup restored.', 1, 1);
        return snapshot;
      } catch (error) {
        preserveStaging = Boolean(error && error.preserveStaging);
        const wrapped = asBackupError(error, error && error.code === 'CORRUPT_BACKUP' ? 'CORRUPT_BACKUP' : 'IO', 'Restoring the encrypted backup failed.');
        if (preserveStaging) wrapped.preserveStaging = true;
        throw wrapped;
      } finally {
        if (!preserveStaging) {
          try { await fsp.rm(stage, { recursive: true, force: true }); } catch { /* staging cleanup is best effort */ }
        }
      }
    });
  }

  return Object.freeze({ create, restore });
}

module.exports = { createBackupService, BackupError, RESTORE_JOURNAL_NAME, recoverRestoreJournal };
