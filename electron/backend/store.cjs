'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

let BetterSqlite3;
let betterSqliteLoadError;
try {
  // Keep this lazy at module load time so callers can still inspect the
  // module and report a useful setup error when PM has not installed it yet.
  BetterSqlite3 = require('better-sqlite3');
} catch (error) {
  betterSqliteLoadError = error;
}

const { SCHEMA_VERSION, PALETTES, columnsForVersion, palettesForVersion } = require('./schema.cjs');
const { validateYieldInputs } = require('../../shared/yield.cjs');
const { validateManualMaterial } = require('../../shared/material-yield.cjs');
const DATABASE_NAME = 'library.sqlite';
const SECTION_IDS = ['information', 'method', 'notes', 'data'];
const COLORS = new Set(['sage', 'blue', 'clay']);
const STATUSES = new Set(['todo', 'progress', 'complete']);
const ATTACHMENT_KINDS = new Set(['image', 'pdf', 'spreadsheet', 'scientific', 'file']);
const PREFERENCE_KEYS = new Set(['appearance', 'palette', 'layout', 'directoryView', 'sort']);
const LAYOUTS = new Set(['continuous', 'tabs']);
const DIRECTORY_VIEWS = new Set(['grid', 'list']);
const DEFAULT_PREFERENCES = Object.freeze({
  appearance: 0,
  palette: 'sage',
  layout: 'continuous',
  directoryView: 'grid',
  sort: 'newest',
});

const EMPTY_DOCUMENT = Object.freeze({
  type: 'doc',
  content: [{ type: 'paragraph' }],
});

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA256_RE = /^[0-9a-f]{64}$/i;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const ISO_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

class StoreError extends Error {
  constructor(code, message, cause) {
    super(message);
    this.name = 'StoreError';
    this.code = code;
    if (cause) this.cause = cause;
  }
}

function ok(value) {
  return { ok: true, value };
}

function failure(code, message) {
  return { ok: false, error: { code, message } };
}

function asStoreError(error) {
  if (error instanceof StoreError) return error;
  const code = String(error && error.code || '');
  const message = String(error && error.message || error || 'Storage operation failed');
  if (code === 'SQLITE_CONSTRAINT_TRIGGER' || code === 'SQLITE_ABORT') {
    return new StoreError('IO', 'The database rejected the write.', error);
  }
  if (code.startsWith('SQLITE_CONSTRAINT')) {
    return new StoreError('VALIDATION', 'The requested value conflicts with an existing record.', error);
  }
  if (/not a database|malformed|file is encrypted|unsupported file format/i.test(message)) {
    return new StoreError('CORRUPT_BACKUP', 'The library database is corrupt or uses an unsupported schema.', error);
  }
  return new StoreError('IO', message, error);
}

function toResult(error) {
  const normalized = asStoreError(error);
  return failure(normalized.code, normalized.message);
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function makeEmptyDocument() {
  return cloneJson(EMPTY_DOCUMENT);
}

function nowTimestamp() {
  return new Date().toISOString();
}

function normalizeUuid(value, field = 'id') {
  if (typeof value !== 'string' || !UUID_RE.test(value)) {
    throw new StoreError('VALIDATION', `${field} must be a UUID.`);
  }
  return value.toLowerCase();
}

function requireText(value, field, { allowEmpty = false, max = 100000 } = {}) {
  if (typeof value !== 'string' || (!allowEmpty && value.trim().length === 0) || value.length > max) {
    throw new StoreError('VALIDATION', `${field} must be a non-empty string.`);
  }
  return value;
}

function validateDate(value, field = 'date') {
  if (typeof value !== 'string') throw new StoreError('VALIDATION', `${field} must be YYYY-MM-DD.`);
  const match = DATE_RE.exec(value);
  if (!match) throw new StoreError('VALIDATION', `${field} must be YYYY-MM-DD.`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1 || month < 1 || month > 12 || day < 1) {
    throw new StoreError('VALIDATION', `${field} must be a real calendar date.`);
  }
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    throw new StoreError('VALIDATION', `${field} must be a real calendar date.`);
  }
  return value;
}

function validateTimestamp(value, field = 'createdAt') {
  if (typeof value !== 'string' || !ISO_TIMESTAMP_RE.test(value) || Number.isNaN(Date.parse(value))) {
    throw new StoreError('VALIDATION', `${field} must be an ISO UTC timestamp.`);
  }
  return value;
}

function validateExpectedRevision(value) {
  if (!Number.isInteger(value) || value < 1) {
    throw new StoreError('VALIDATION', 'expectedRevision must be a positive integer.');
  }
  return value;
}

function validateInteger(value, field, { min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new StoreError('VALIDATION', `${field} must be an integer in range.`);
  }
  return value;
}

function validateHash(value) {
  if (typeof value !== 'string' || !SHA256_RE.test(value)) {
    throw new StoreError('VALIDATION', 'hash must be a SHA-256 hex digest.');
  }
  return value.toLowerCase();
}

function validateJsonValue(value, location, seen = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new StoreError('VALIDATION', `${location} must contain finite numbers.`);
    return;
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new StoreError('VALIDATION', `${location} contains a cycle.`);
    seen.add(value);
    value.forEach((item, index) => validateJsonValue(item, `${location}[${index}]`, seen));
    seen.delete(value);
    return;
  }
  if (isPlainObject(value)) {
    if (seen.has(value)) throw new StoreError('VALIDATION', `${location} contains a cycle.`);
    seen.add(value);
    for (const [key, item] of Object.entries(value)) validateJsonValue(item, `${location}.${key}`, seen);
    seen.delete(value);
    return;
  }
  throw new StoreError('VALIDATION', `${location} must be JSON serializable.`);
}

function validateDocNode(node, location, seen) {
  if (!isPlainObject(node)) throw new StoreError('VALIDATION', `${location} must be a document node.`);
  if (seen.has(node)) throw new StoreError('VALIDATION', `${location} contains a cycle.`);
  seen.add(node);

  const unknownKeys = Object.keys(node).filter(key => !['type', 'text', 'attrs', 'marks', 'content'].includes(key));
  if (unknownKeys.length) throw new StoreError('VALIDATION', `${location} contains an unknown field.`);

  if (typeof node.type !== 'string' || node.type.trim().length === 0) {
    throw new StoreError('VALIDATION', `${location}.type must be a non-empty string.`);
  }
  if (node.type === 'yieldCalculation' && !validateYieldInputs(node.attrs)) {
    throw new StoreError('VALIDATION', 'Yield calculation inputs are malformed or use an unsupported version.');
  }
  if (Object.prototype.hasOwnProperty.call(node, 'text') && typeof node.text !== 'string') {
    throw new StoreError('VALIDATION', `${location}.text must be a string.`);
  }
  if (Object.prototype.hasOwnProperty.call(node, 'attrs') && !isPlainObject(node.attrs)) {
    throw new StoreError('VALIDATION', `${location}.attrs must be an object.`);
  }
  if (Object.prototype.hasOwnProperty.call(node, 'attrs')) validateJsonValue(node.attrs, `${location}.attrs`);
  if (Object.prototype.hasOwnProperty.call(node, 'marks')) {
    if (!Array.isArray(node.marks)) throw new StoreError('VALIDATION', `${location}.marks must be an array.`);
    node.marks.forEach((mark, index) => {
      if (!isPlainObject(mark) || typeof mark.type !== 'string' || mark.type.trim().length === 0) {
        throw new StoreError('VALIDATION', `${location}.marks[${index}] is invalid.`);
      }
      const unknownMarkKeys = Object.keys(mark).filter(key => !['type', 'attrs'].includes(key));
      if (unknownMarkKeys.length) throw new StoreError('VALIDATION', `${location}.marks[${index}] contains an unknown field.`);
      if (Object.prototype.hasOwnProperty.call(mark, 'attrs') && !isPlainObject(mark.attrs)) {
        throw new StoreError('VALIDATION', `${location}.marks[${index}].attrs must be an object.`);
      }
      if (mark.type === 'yieldMaterial' && (
        !isPlainObject(mark.attrs)
        || Object.keys(mark.attrs).some(key => !['role', 'id', 'manual'].includes(key))
        || !['starting', 'product'].includes(mark.attrs.role)
        || typeof mark.attrs.id !== 'string'
        || !/^[A-Za-z0-9_-]{1,128}$/.test(mark.attrs.id)
        || (mark.attrs.manual != null && !validateManualMaterial(mark.attrs.manual))
      )) {
        throw new StoreError('VALIDATION', 'Yield material marks require a starting/product role and a valid identifier.');
      }
      if (Object.prototype.hasOwnProperty.call(mark, 'attrs')) validateJsonValue(mark.attrs, `${location}.marks[${index}].attrs`);
    });
  }
  if (Object.prototype.hasOwnProperty.call(node, 'content')) {
    if (!Array.isArray(node.content)) throw new StoreError('VALIDATION', `${location}.content must be an array.`);
    node.content.forEach((child, index) => validateDocNode(child, `${location}.content[${index}]`, seen));
  }
  seen.delete(node);
}

function validateDocument(value, field = 'document') {
  if (!isPlainObject(value) || value.type !== 'doc') {
    throw new StoreError('VALIDATION', `${field} must have a doc root.`);
  }
  validateDocNode(value, field, new Set());
  let serialized;
  try {
    serialized = JSON.stringify(value);
    if (serialized === undefined) throw new Error('undefined document');
    JSON.parse(serialized);
  } catch (error) {
    throw new StoreError('VALIDATION', `${field} must be JSON serializable.`, error);
  }
  return cloneJson(value);
}

// Repeated prose remains useful, but measured starting/product selections belong
// to the source run. Keep every other mark and node intact in the copied text.
function copyWithoutYieldMaterials(document) {
  const copy = cloneJson(document);
  const visit = node => {
    if (Array.isArray(node.marks) && node.marks.some(mark => mark.type === 'yieldMaterial')) {
      node.marks = node.marks.filter(mark => mark.type !== 'yieldMaterial');
      if (!node.marks.length) delete node.marks;
    }
    if (Array.isArray(node.content)) node.content.forEach(visit);
  };
  visit(copy);
  return copy;
}

function validateSectionDocuments(value, field = 'documents') {
  if (!isPlainObject(value)) throw new StoreError('VALIDATION', `${field} must be an object.`);
  const keys = Object.keys(value).sort();
  const expected = [...SECTION_IDS].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new StoreError('VALIDATION', `${field} must include exactly the four sections.`);
  }
  const documents = {};
  for (const section of SECTION_IDS) documents[section] = validateDocument(value[section], `${field}.${section}`);
  return documents;
}

function validatePreferencesChange(changes) {
  if (!isPlainObject(changes)) throw new StoreError('VALIDATION', 'Preference changes must be an object.');
  const unknown = Object.keys(changes).filter(key => !PREFERENCE_KEYS.has(key));
  if (unknown.length) throw new StoreError('VALIDATION', `Unknown preference: ${unknown[0]}.`);
  const result = {};
  if (Object.prototype.hasOwnProperty.call(changes, 'palette')) {
    if (!PALETTES.includes(changes.palette)) throw new StoreError('VALIDATION', 'Unknown appearance palette.');
    result.palette = changes.palette;
  }
  if (Object.prototype.hasOwnProperty.call(changes, 'appearance')) {
    result.appearance = validateInteger(changes.appearance, 'appearance', { min: 0, max: 100 });
  }
  if (Object.prototype.hasOwnProperty.call(changes, 'layout')) {
    if (!LAYOUTS.has(changes.layout)) throw new StoreError('VALIDATION', 'layout must be continuous or tabs.');
    result.layout = changes.layout;
  }
  if (Object.prototype.hasOwnProperty.call(changes, 'directoryView')) {
    if (!DIRECTORY_VIEWS.has(changes.directoryView)) throw new StoreError('VALIDATION', 'directoryView must be grid or list.');
    result.directoryView = changes.directoryView;
  }
  if (Object.prototype.hasOwnProperty.call(changes, 'sort')) result.sort = requireText(changes.sort, 'sort');
  return result;
}

function sqlitePlaceholders(length) {
  return Array.from({ length }, () => '?').join(', ');
}

/**
 * Delegate restore recovery to the backup service without creating a module
 * cycle. The backup module is loaded only during store construction, before
 * SQLite opens. Its helper must be synchronous: an async return here would let
 * the store create/open a database before recovery completed.
 */
function recoverRestoreJournal(root) {
  let backup;
  try {
    backup = require('./backup.cjs');
  } catch (error) {
    throw new StoreError('UNAVAILABLE', 'The backup recovery service is unavailable.', error);
  }
  if (!backup || typeof backup.recoverRestoreJournal !== 'function') {
    throw new StoreError('UNAVAILABLE', 'The backup recovery service does not expose startup recovery.');
  }
  let result;
  try {
    result = backup.recoverRestoreJournal(root);
  } catch (error) {
    throw asStoreError(error);
  }
  if (result && typeof result.then === 'function') {
    throw new StoreError('UNAVAILABLE', 'The backup recovery hook must be synchronous.');
  }
  return result;
}

const SCHEMA_SQL = [
  `CREATE TABLE IF NOT EXISTS notebooks (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL,
    discipline TEXT NOT NULL,
    color TEXT NOT NULL CHECK (color IN ('sage', 'blue', 'clay')),
    revision INTEGER NOT NULL CHECK (revision >= 1),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    trashed_at TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS experiments (
    id TEXT PRIMARY KEY,
    notebook_id TEXT NOT NULL REFERENCES notebooks(id) ON DELETE CASCADE,
    label TEXT NOT NULL,
    experiment_number INTEGER NOT NULL CHECK (experiment_number >= 1),
    revision INTEGER NOT NULL CHECK (revision >= 1),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    trashed_at TEXT,
    UNIQUE (notebook_id, experiment_number)
  )`,
  `CREATE TABLE IF NOT EXISTS runs (
    id TEXT PRIMARY KEY,
    notebook_id TEXT NOT NULL REFERENCES notebooks(id) ON DELETE CASCADE,
    experiment_id TEXT NOT NULL REFERENCES experiments(id) ON DELETE CASCADE,
    label TEXT NOT NULL,
    experiment_number INTEGER NOT NULL CHECK (experiment_number >= 1),
    run_number INTEGER NOT NULL CHECK (run_number >= 1),
    title TEXT NOT NULL,
    date TEXT NOT NULL,
    author TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('todo', 'progress', 'complete')),
    revision INTEGER NOT NULL CHECK (revision >= 1),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    trashed_at TEXT,
    UNIQUE (experiment_id, run_number)
  )`,
  `CREATE TABLE IF NOT EXISTS documents (
    run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    section_id TEXT NOT NULL CHECK (section_id IN ('information', 'method', 'notes', 'data')),
    document_schema_version INTEGER NOT NULL CHECK (document_schema_version = 1),
    json TEXT NOT NULL,
    PRIMARY KEY (run_id, section_id)
  )`,
  `CREATE TABLE IF NOT EXISTS attachments (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    mime TEXT NOT NULL,
    size INTEGER NOT NULL CHECK (size >= 0),
    hash TEXT NOT NULL,
    caption TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('image', 'pdf', 'spreadsheet', 'scientific', 'file')),
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS citation_associations (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    source_instance TEXT NOT NULL,
    library_id TEXT NOT NULL,
    item_key TEXT NOT NULL,
    snapshot_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (run_id, source_instance, library_id, item_key)
  )`,
  `CREATE TABLE IF NOT EXISTS schemes (
    id TEXT PRIMARY KEY,
    notebook_id TEXT NOT NULL REFERENCES notebooks(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    description TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK (revision >= 1),
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS scheme_members (
    scheme_id TEXT NOT NULL REFERENCES schemes(id) ON DELETE CASCADE,
    run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    position INTEGER NOT NULL CHECK (position >= 0),
    PRIMARY KEY (scheme_id, run_id),
    UNIQUE (scheme_id, position)
  )`,
  `CREATE TABLE IF NOT EXISTS counters (
    key TEXT PRIMARY KEY,
    next_number INTEGER NOT NULL CHECK (next_number >= 1)
  )`,
  `CREATE TABLE IF NOT EXISTS preferences (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    appearance INTEGER NOT NULL CHECK (appearance BETWEEN 0 AND 100),
    layout TEXT NOT NULL CHECK (layout IN ('continuous', 'tabs')),
    directory_view TEXT NOT NULL CHECK (directory_view IN ('grid', 'list')),
    sort TEXT NOT NULL,
    palette TEXT NOT NULL DEFAULT 'sage' CHECK (palette IN ('sage', 'ocean', 'lavender', 'terracotta', 'rose', 'graphite', 'midnight'))
  )`,
];

const REQUIRED_COLUMNS = columnsForVersion(SCHEMA_VERSION);

class LibraryStore {
  constructor(root) {
    if (typeof root !== 'string' || root.trim().length === 0) {
      throw new StoreError('VALIDATION', 'Library root must be a non-empty path.');
    }
    if (!BetterSqlite3) {
      throw new StoreError('UNAVAILABLE', 'better-sqlite3 is required for the local library store.', betterSqliteLoadError);
    }
    this.root = path.resolve(root);
    this.databasePath = path.join(this.root, DATABASE_NAME);
    this.backupLocks = 0;
    this.db = null;
    this._closed = true;
    this._backupActive = false;
    // Restore recovery must happen before SQLite opens and before any generic
    // staging cleanup can remove a candidate left by an interrupted swap.
    try {
      recoverRestoreJournal(this.root);
      this._open();
      this._cleanStaging();
      this._cleanOrphanObjects();
    } catch (error) {
      try { if (this.db && this.db.open) this.db.close(); } catch {}
      this.db = null;
      this._closed = true;
      throw asStoreError(error);
    }
  }

  _ensureDirectories() {
    fs.mkdirSync(this.root, { recursive: true });
    for (const directory of ['objects', 'staging', 'backups']) {
      const target = path.join(this.root, directory);
      let stats;
      try {
        stats = fs.lstatSync(target);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      if (stats && !stats.isDirectory()) {
        throw new StoreError('IO', `Library ${directory} path is not a directory.`);
      }
      if (!stats) fs.mkdirSync(target, { recursive: true });
    }
  }

  _open() {
    this._ensureDirectories();
    let database;
    try {
      database = new BetterSqlite3(this.databasePath);
      database.pragma('foreign_keys = ON');
      const versionRow = database.prepare('PRAGMA user_version').get();
      const version = Number(versionRow && (versionRow.user_version ?? Object.values(versionRow)[0]));
      if (!Number.isInteger(version) || version < 0 || version > SCHEMA_VERSION) {
        throw new StoreError('CORRUPT_BACKUP', `Unsupported library schema version ${version}.`);
      }
      database.pragma('journal_mode = WAL');
      database.pragma('synchronous = FULL');
      database.pragma('busy_timeout = 5000');

      if (version === 0) {
        const migrate = database.transaction(() => {
          for (const statement of SCHEMA_SQL) database.prepare(statement).run();
          database.prepare(`INSERT OR IGNORE INTO preferences
            (id, appearance, layout, directory_view, sort)
            VALUES (1, ?, ?, ?, ?)`).run(
            DEFAULT_PREFERENCES.appearance,
            DEFAULT_PREFERENCES.layout,
            DEFAULT_PREFERENCES.directoryView,
            DEFAULT_PREFERENCES.sort,
          );
          this._verifySchema(database);
          database.pragma(`user_version = ${SCHEMA_VERSION}`);
        });
        migrate();
      } else if (version === 1 || version === 2) {
        database.transaction(() => {
          this._verifySchema(database, version);
          // SQLite cannot alter a CHECK constraint. Rebuild only preferences,
          // within the same transaction as the version update, preserving values.
          database.exec('ALTER TABLE preferences RENAME TO preferences_before_v3');
          database.exec(SCHEMA_SQL[SCHEMA_SQL.length - 1]);
          database.exec(`INSERT INTO preferences (id, appearance, layout, directory_view, sort, palette)
            SELECT id, appearance, layout, directory_view, sort, ${version === 1 ? "'sage'" : 'palette'}
            FROM preferences_before_v3`);
          database.exec('DROP TABLE preferences_before_v3');
          this._verifySchema(database);
          database.pragma(`user_version = ${SCHEMA_VERSION}`);
        })();
      } else {
        this._verifySchema(database);
      }
      this.db = database;
      this._closed = false;
    } catch (error) {
      try { if (database && database.open) database.close(); } catch {}
      this.db = null;
      this._closed = true;
      throw asStoreError(error);
    }
  }

  _verifySchema(database = this.db, version = SCHEMA_VERSION) {
    for (const [table, columns] of Object.entries(version === SCHEMA_VERSION ? REQUIRED_COLUMNS : columnsForVersion(version))) {
      const rows = database.prepare(`PRAGMA table_info(${table})`).all();
      const found = new Set(rows.map(row => row.name));
      if (rows.length === 0 || columns.some(column => !found.has(column))) {
        throw new StoreError('CORRUPT_BACKUP', `Library schema is missing the ${table} table or columns.`);
      }
    }
    const preferences = database.prepare('SELECT COUNT(*) AS count FROM preferences WHERE id = 1').get();
    if (Number(preferences.count) !== 1) {
      throw new StoreError('CORRUPT_BACKUP', 'Library preferences row is missing.');
    }
    if (version >= 2) {
      const palette = database.prepare('SELECT palette FROM preferences WHERE id = 1').get().palette;
      if (!palettesForVersion(version).includes(palette)) {
        throw new StoreError('CORRUPT_BACKUP', 'Library appearance palette is unsupported for its schema.');
      }
    }
    const foreignKeys = database.prepare('PRAGMA foreign_key_check').all();
    if (foreignKeys.length > 0) {
      throw new StoreError('CORRUPT_BACKUP', 'Library foreign-key references are inconsistent.');
    }
    const runInvariants = database.prepare(`SELECT runs.id
      FROM runs
      LEFT JOIN experiments ON experiments.id = runs.experiment_id
      WHERE experiments.id IS NULL OR experiments.notebook_id <> runs.notebook_id
        OR experiments.experiment_number <> runs.experiment_number
        OR experiments.label <> runs.label`).all();
    if (runInvariants.length > 0) {
      throw new StoreError('CORRUPT_BACKUP', 'Run parent references are inconsistent.');
    }
    const schemeInvariants = database.prepare(`SELECT scheme_members.scheme_id
      FROM scheme_members
      JOIN schemes ON schemes.id = scheme_members.scheme_id
      JOIN runs ON runs.id = scheme_members.run_id
      WHERE schemes.notebook_id <> runs.notebook_id`).all();
    if (schemeInvariants.length > 0) {
      throw new StoreError('CORRUPT_BACKUP', 'Scheme membership references another notebook.');
    }
    const unsupportedDocuments = database.prepare(
      'SELECT run_id FROM documents WHERE document_schema_version <> 1 LIMIT 1',
    ).all();
    if (unsupportedDocuments.length > 0) {
      throw new StoreError('CORRUPT_BACKUP', 'A section document uses an unsupported schema version.');
    }
  }

  _cleanStaging() {
    const staging = path.join(this.root, 'staging');
    let stats;
    try {
      stats = fs.lstatSync(staging);
    } catch (error) {
      if (error.code === 'ENOENT') {
        fs.mkdirSync(staging, { recursive: true });
        return;
      }
      throw error;
    }
    // Never follow a replacement symlink at the staging root.
    if (!stats.isDirectory() || stats.isSymbolicLink()) return;
    for (const entry of fs.readdirSync(staging)) {
      const child = path.join(staging, entry);
      try {
        const childStats = fs.lstatSync(child);
        if (childStats.isDirectory() && !childStats.isSymbolicLink()) {
          fs.rmSync(child, { recursive: true, force: true });
        } else {
          fs.unlinkSync(child);
        }
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
  }

  _cleanOrphanObjects() {
    const objects = path.join(this.root, 'objects');
    let entries;
    try {
      entries = fs.readdirSync(objects);
    } catch (error) {
      if (error.code === 'ENOENT') return;
      throw new StoreError('IO', 'The attachment object directory could not be inspected.', error);
    }
    const referenced = new Set(this.db.prepare('SELECT DISTINCT hash FROM attachments').all().map(row => String(row.hash).toLowerCase()));
    for (const name of entries) {
      if (!SHA256_RE.test(name) || referenced.has(name.toLowerCase())) continue;
      const objectPath = path.join(objects, name);
      try {
        const stats = fs.lstatSync(objectPath);
        if (stats.isFile() && !stats.isSymbolicLink()) fs.unlinkSync(objectPath);
      } catch (error) {
        // Startup cleanup is conservative. A locked or otherwise unavailable
        // orphan can be retried on the next launch without affecting metadata.
      }
    }
  }

  _assertOpen() {
    if (this._closed || !this.db || !this.db.open) throw new StoreError('IO', 'The library store is closed.');
  }

  _assertMutationAllowed() {
    if (this._backupActive) throw new StoreError('UNAVAILABLE', 'The library is temporarily locked for backup.');
  }

  _mutate(operation) {
    try {
      return ok(this._mutateRaw(operation));
    } catch (error) {
      return toResult(error);
    }
  }

  _mutateRaw(operation) {
    try {
      this._assertOpen();
      this._assertMutationAllowed();
      const extra = this.db.transaction(operation)();
      if (extra && Array.isArray(extra.gcHashes)) this._garbageCollect(extra.gcHashes);
      return this._snapshotUnsafe();
    } catch (error) {
      throw asStoreError(error);
    }
  }

  _read(operation) {
    try {
      return ok(this._readRaw(operation));
    } catch (error) {
      return toResult(error);
    }
  }

  _readRaw(operation) {
    try {
      this._assertOpen();
      return operation();
    } catch (error) {
      throw asStoreError(error);
    }
  }

  _row(table, id) {
    const normalized = normalizeUuid(id);
    return this.db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(normalized) || null;
  }

  _requireRow(table, id, label) {
    const normalized = normalizeUuid(id);
    const row = this.db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(normalized);
    if (!row) throw new StoreError('NOT_FOUND', `${label || table} was not found.`);
    return row;
  }

  _requireActiveNotebook(id) {
    const row = this._requireRow('notebooks', id, 'Notebook');
    if (row.trashed_at !== null) throw new StoreError('VALIDATION', 'Notebook is in the trash.');
    return row;
  }

  _requireActiveExperiment(id) {
    const row = this._requireRow('experiments', id, 'Experiment');
    if (row.trashed_at !== null) throw new StoreError('VALIDATION', 'Experiment is in the trash.');
    const notebook = this._requireRow('notebooks', row.notebook_id, 'Notebook');
    if (notebook.trashed_at !== null) throw new StoreError('VALIDATION', 'Experiment notebook is in the trash.');
    return row;
  }

  _requireActiveRun(id) {
    const row = this._requireRow('runs', id, 'Run');
    if (row.trashed_at !== null) throw new StoreError('VALIDATION', 'Run is in the trash.');
    const experiment = this._requireRow('experiments', row.experiment_id, 'Experiment');
    const notebook = this._requireRow('notebooks', row.notebook_id, 'Notebook');
    if (experiment.trashed_at !== null || notebook.trashed_at !== null) {
      throw new StoreError('VALIDATION', 'Run has a trashed ancestor.');
    }
    return row;
  }

  _nextNumber(key, table, column, parentColumn, parentId) {
    const counter = this.db.prepare('SELECT next_number FROM counters WHERE key = ?').get(key);
    let candidate = counter ? Number(counter.next_number) : 1;
    if (!Number.isSafeInteger(candidate) || candidate < 1) {
      throw new StoreError('CORRUPT_BACKUP', 'A numbering counter is invalid.');
    }
    const existing = this.db.prepare(`SELECT ${column} AS number FROM ${table} WHERE ${parentColumn} = ? AND ${column} >= ? ORDER BY ${column}`).all(parentId, candidate);
    const used = new Set(existing.map(row => Number(row.number)));
    while (used.has(candidate)) candidate += 1;
    const next = candidate + 1;
    this.db.prepare(`INSERT INTO counters(key, next_number) VALUES(?, ?)
      ON CONFLICT(key) DO UPDATE SET next_number = CASE WHEN counters.next_number < excluded.next_number THEN excluded.next_number ELSE counters.next_number END`).run(key, next);
    return candidate;
  }

  _insertDocuments(runId, documents) {
    const insert = this.db.prepare(
      'INSERT INTO documents(run_id, section_id, document_schema_version, json) VALUES(?, ?, 1, ?)',
    );
    for (const section of SECTION_IDS) insert.run(runId, section, JSON.stringify(documents[section]));
  }

  _readDocuments(runId) {
    const documents = {};
    const rows = this.db.prepare(
      'SELECT section_id, document_schema_version, json FROM documents WHERE run_id = ?',
    ).all(runId);
    for (const row of rows) {
      if (!SECTION_IDS.includes(row.section_id)) throw new StoreError('CORRUPT_BACKUP', 'Run contains an unknown document section.');
      if (Number(row.document_schema_version) !== 1) {
        throw new StoreError('CORRUPT_BACKUP', 'Run contains an unsupported document schema version.');
      }
      try {
        documents[row.section_id] = JSON.parse(row.json);
      } catch (error) {
        throw new StoreError('CORRUPT_BACKUP', 'Run contains invalid document JSON.', error);
      }
    }
    if (SECTION_IDS.some(section => !Object.prototype.hasOwnProperty.call(documents, section))) {
      throw new StoreError('CORRUPT_BACKUP', 'Run is missing one or more section documents.');
    }
    return validateSectionDocuments(documents);
  }

  _snapshotUnsafe() {
    this._assertOpen();
    const notebooks = this.db.prepare(`SELECT * FROM notebooks ORDER BY created_at, id`).all().map(row => ({
      id: row.id,
      name: row.name,
      description: row.description,
      discipline: row.discipline,
      color: row.color,
      revision: Number(row.revision),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      trashedAt: row.trashed_at,
    }));
    const experiments = this.db.prepare(`SELECT * FROM experiments ORDER BY created_at, id`).all().map(row => ({
      id: row.id,
      notebookId: row.notebook_id,
      label: row.label,
      experimentNumber: Number(row.experiment_number),
      revision: Number(row.revision),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      trashedAt: row.trashed_at,
    }));
    const runRows = this.db.prepare(`SELECT * FROM runs ORDER BY created_at, id`).all();
    const runs = runRows.map(row => ({
      id: row.id,
      notebookId: row.notebook_id,
      experimentId: row.experiment_id,
      label: row.label,
      experimentNumber: Number(row.experiment_number),
      runNumber: Number(row.run_number),
      title: row.title,
      date: row.date,
      author: row.author,
      status: row.status,
      documents: this._readDocuments(row.id),
      revision: Number(row.revision),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      trashedAt: row.trashed_at,
    }));
    const attachments = this.db.prepare(`SELECT * FROM attachments ORDER BY created_at, id`).all().map(row => ({
      id: row.id,
      runId: row.run_id,
      name: row.name,
      mime: row.mime,
      size: Number(row.size),
      hash: row.hash,
      caption: row.caption,
      kind: row.kind,
      createdAt: row.created_at,
    }));
    const schemeRows = this.db.prepare(`SELECT * FROM schemes ORDER BY created_at, id`).all();
    const memberRows = this.db.prepare(`SELECT scheme_id, run_id FROM scheme_members ORDER BY scheme_id, position`).all();
    const members = new Map();
    for (const row of memberRows) {
      if (!members.has(row.scheme_id)) members.set(row.scheme_id, []);
      members.get(row.scheme_id).push(row.run_id);
    }
    const schemes = schemeRows.map(row => ({
      id: row.id,
      notebookId: row.notebook_id,
      name: row.name,
      description: row.description,
      runIds: members.get(row.id) || [],
      revision: Number(row.revision),
    }));
    const preferenceRow = this.db.prepare('SELECT appearance, palette, layout, directory_view, sort FROM preferences WHERE id = 1').get();
    if (!preferenceRow) throw new StoreError('CORRUPT_BACKUP', 'Library preferences row is missing.');
    return {
      schemaVersion: SCHEMA_VERSION,
      notebooks,
      experiments,
      runs,
      attachments,
      schemes,
      preferences: {
        appearance: Number(preferenceRow.appearance),
        palette: preferenceRow.palette,
        layout: preferenceRow.layout,
        directoryView: preferenceRow.directory_view,
        sort: preferenceRow.sort,
      },
    };
  }

  snapshot() {
    try {
      this._assertOpen();
      return this._snapshotUnsafe();
    } catch (error) {
      throw asStoreError(error);
    }
  }

  _createNotebook(payload) {
    if (!isPlainObject(payload)) throw new StoreError('VALIDATION', 'Notebook payload must be an object.');
    const name = requireText(payload.name, 'name');
    const description = requireText(payload.description, 'description', { allowEmpty: true });
    const discipline = requireText(payload.discipline, 'discipline', { allowEmpty: true });
    if (!COLORS.has(payload.color)) throw new StoreError('VALIDATION', 'color must be sage, blue, or clay.');
    const id = crypto.randomUUID();
    const timestamp = nowTimestamp();
    this.db.prepare(`INSERT INTO notebooks
      (id, name, description, discipline, color, revision, created_at, updated_at, trashed_at)
      VALUES (?, ?, ?, ?, ?, 1, ?, ?, NULL)`).run(id, name, description, discipline, payload.color, timestamp, timestamp);
  }

  _updateNotebook(payload) {
    if (!isPlainObject(payload)) throw new StoreError('VALIDATION', 'Notebook update payload must be an object.');
    const id = normalizeUuid(payload.id);
    const expectedRevision = validateExpectedRevision(payload.expectedRevision);
    const changes = payload.changes;
    if (!isPlainObject(changes)) throw new StoreError('VALIDATION', 'Notebook changes must be an object.');
    const allowed = new Set(['name', 'description', 'discipline', 'color']);
    const unknown = Object.keys(changes).filter(key => !allowed.has(key));
    if (unknown.length) throw new StoreError('VALIDATION', `Unknown notebook field: ${unknown[0]}.`);
    if (Object.keys(changes).length === 0) throw new StoreError('VALIDATION', 'Notebook update has no changes.');
    const row = this._requireRow('notebooks', id, 'Notebook');
    if (row.revision !== expectedRevision) throw new StoreError('STALE_REVISION', 'Notebook changed since it was loaded.');
    if (row.trashed_at !== null) throw new StoreError('VALIDATION', 'Notebook is in the trash.');
    const next = {
      name: Object.prototype.hasOwnProperty.call(changes, 'name') ? requireText(changes.name, 'name') : row.name,
      description: Object.prototype.hasOwnProperty.call(changes, 'description') ? requireText(changes.description, 'description', { allowEmpty: true }) : row.description,
      discipline: Object.prototype.hasOwnProperty.call(changes, 'discipline') ? requireText(changes.discipline, 'discipline', { allowEmpty: true }) : row.discipline,
      color: Object.prototype.hasOwnProperty.call(changes, 'color') ? changes.color : row.color,
    };
    if (!COLORS.has(next.color)) throw new StoreError('VALIDATION', 'color must be sage, blue, or clay.');
    const timestamp = nowTimestamp();
    const result = this.db.prepare(`UPDATE notebooks SET name=?, description=?, discipline=?, color=?, revision=revision+1, updated_at=?
      WHERE id=? AND revision=? AND trashed_at IS NULL`).run(next.name, next.description, next.discipline, next.color, timestamp, id, expectedRevision);
    if (result.changes !== 1) throw new StoreError('STALE_REVISION', 'Notebook changed since it was loaded.');
  }

  _createExperiment(payload) {
    if (!isPlainObject(payload)) throw new StoreError('VALIDATION', 'Experiment payload must be an object.');
    const notebookId = normalizeUuid(payload.notebookId, 'notebookId');
    const notebook = this._requireActiveNotebook(notebookId);
    const label = requireText(payload.label, 'label');
    const title = requireText(payload.title, 'title');
    const date = validateDate(payload.date);
    const author = requireText(payload.author, 'author');
    const experimentNumber = this._nextNumber(`experiment:${notebookId}`, 'experiments', 'experiment_number', 'notebook_id', notebookId);
    const experimentId = crypto.randomUUID();
    const runId = crypto.randomUUID();
    const timestamp = nowTimestamp();
    this.db.prepare(`INSERT INTO experiments
      (id, notebook_id, label, experiment_number, revision, created_at, updated_at, trashed_at)
      VALUES (?, ?, ?, ?, 1, ?, ?, NULL)`).run(experimentId, notebookId, label, experimentNumber, timestamp, timestamp);
    const runNumber = this._nextNumber(`run:${experimentId}`, 'runs', 'run_number', 'experiment_id', experimentId);
    this.db.prepare(`INSERT INTO runs
      (id, notebook_id, experiment_id, label, experiment_number, run_number, title, date, author, status, revision, created_at, updated_at, trashed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'todo', 1, ?, ?, NULL)`).run(
      runId, notebookId, experimentId, label, experimentNumber, runNumber, title, date, author, timestamp, timestamp,
    );
    this._insertDocuments(runId, Object.fromEntries(SECTION_IDS.map(section => [section, makeEmptyDocument()])));
  }

  _updateExperiment(payload) {
    if (!isPlainObject(payload)) throw new StoreError('VALIDATION', 'Experiment update payload must be an object.');
    const id = normalizeUuid(payload.id);
    const expectedRevision = validateExpectedRevision(payload.expectedRevision);
    const label = requireText(payload.label, 'label');
    const row = this._requireRow('experiments', id, 'Experiment');
    if (row.revision !== expectedRevision) throw new StoreError('STALE_REVISION', 'Experiment changed since it was loaded.');
    this._requireActiveExperiment(id);
    const timestamp = nowTimestamp();
    const result = this.db.prepare(`UPDATE experiments SET label=?, revision=revision+1, updated_at=?
      WHERE id=? AND revision=? AND trashed_at IS NULL`).run(label, timestamp, id, expectedRevision);
    if (result.changes !== 1) throw new StoreError('STALE_REVISION', 'Experiment changed since it was loaded.');
    // Run labels are a denormalized display field. Keep them aligned and bump
    // each affected run revision so an open editor cannot overwrite the rename
    // with a draft loaded before it happened.
    this.db.prepare('UPDATE runs SET label=?, revision=revision+1, updated_at=? WHERE experiment_id=?').run(label, timestamp, id);
  }

  _repeatRun(payload) {
    if (!isPlainObject(payload)) throw new StoreError('VALIDATION', 'Repeat payload must be an object.');
    const sourceId = normalizeUuid(payload.runId, 'runId');
    const date = validateDate(payload.date);
    const source = this._requireActiveRun(sourceId);
    const experiment = this._requireActiveExperiment(source.experiment_id);
    const runId = crypto.randomUUID();
    const timestamp = nowTimestamp();
    const runNumber = this._nextNumber(`run:${experiment.id}`, 'runs', 'run_number', 'experiment_id', experiment.id);
    const sourceDocuments = this._readDocuments(source.id);
    const documents = {
      information: copyWithoutYieldMaterials(sourceDocuments.information),
      method: copyWithoutYieldMaterials(sourceDocuments.method),
      notes: makeEmptyDocument(),
      data: makeEmptyDocument(),
    };
    this.db.prepare(`INSERT INTO runs
      (id, notebook_id, experiment_id, label, experiment_number, run_number, title, date, author, status, revision, created_at, updated_at, trashed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'todo', 1, ?, ?, NULL)`).run(
      runId, source.notebook_id, experiment.id, experiment.label, experiment.experiment_number,
      runNumber, source.title, date, source.author, timestamp, timestamp,
    );
    this._insertDocuments(runId, documents);
  }

  _updateRun(payload) {
    if (!isPlainObject(payload)) throw new StoreError('VALIDATION', 'Run update payload must be an object.');
    const id = normalizeUuid(payload.id);
    const expectedRevision = validateExpectedRevision(payload.expectedRevision);
    const changes = payload.changes;
    if (!isPlainObject(changes)) throw new StoreError('VALIDATION', 'Run changes must be an object.');
    const allowed = new Set(['title', 'date', 'author', 'status']);
    const unknown = Object.keys(changes).filter(key => !allowed.has(key));
    if (unknown.length) throw new StoreError('VALIDATION', `Unknown run field: ${unknown[0]}.`);
    if (Object.keys(changes).length === 0) throw new StoreError('VALIDATION', 'Run update has no changes.');
    const row = this._requireRow('runs', id, 'Run');
    if (row.revision !== expectedRevision) throw new StoreError('STALE_REVISION', 'Run changed since it was loaded.');
    this._requireActiveRun(id);
    const next = {
      title: Object.prototype.hasOwnProperty.call(changes, 'title') ? requireText(changes.title, 'title') : row.title,
      date: Object.prototype.hasOwnProperty.call(changes, 'date') ? validateDate(changes.date) : row.date,
      author: Object.prototype.hasOwnProperty.call(changes, 'author') ? requireText(changes.author, 'author') : row.author,
      status: Object.prototype.hasOwnProperty.call(changes, 'status') ? changes.status : row.status,
    };
    if (!STATUSES.has(next.status)) throw new StoreError('VALIDATION', 'status must be todo, progress, or complete.');
    const timestamp = nowTimestamp();
    const result = this.db.prepare(`UPDATE runs SET title=?, date=?, author=?, status=?, revision=revision+1, updated_at=?
      WHERE id=? AND revision=? AND trashed_at IS NULL`).run(next.title, next.date, next.author, next.status, timestamp, id, expectedRevision);
    if (result.changes !== 1) throw new StoreError('STALE_REVISION', 'Run changed since it was loaded.');
  }

  _saveDocuments(payload) {
    if (!isPlainObject(payload)) throw new StoreError('VALIDATION', 'Document save payload must be an object.');
    const runId = normalizeUuid(payload.runId, 'runId');
    const expectedRevision = validateExpectedRevision(payload.expectedRevision);
    const documents = validateSectionDocuments(payload.documents);
    const run = this._requireActiveRun(runId);
    if (run.revision !== expectedRevision) throw new StoreError('STALE_REVISION', 'Run changed since it was loaded.');
    const timestamp = nowTimestamp();
    const result = this.db.prepare(`UPDATE runs SET revision=revision+1, updated_at=?
      WHERE id=? AND revision=? AND trashed_at IS NULL`).run(timestamp, runId, expectedRevision);
    if (result.changes !== 1) throw new StoreError('STALE_REVISION', 'Run changed since it was loaded.');
    const update = this.db.prepare('UPDATE documents SET json=? WHERE run_id=? AND section_id=?');
    for (const section of SECTION_IDS) {
      const changed = update.run(JSON.stringify(documents[section]), runId, section);
      if (changed.changes !== 1) throw new StoreError('CORRUPT_BACKUP', 'Run is missing a section document.');
    }
  }

  _createScheme(payload) {
    if (!isPlainObject(payload)) throw new StoreError('VALIDATION', 'Scheme payload must be an object.');
    const notebookId = normalizeUuid(payload.notebookId, 'notebookId');
    this._requireActiveNotebook(notebookId);
    const name = requireText(payload.name, 'name');
    const description = requireText(payload.description, 'description', { allowEmpty: true });
    const runIds = Object.prototype.hasOwnProperty.call(payload, 'runIds')
      ? this._validateSchemeRunIds(notebookId, payload.runIds)
      : [];
    const id = crypto.randomUUID();
    const timestamp = nowTimestamp();
    this.db.prepare(`INSERT INTO schemes(id, notebook_id, name, description, revision, created_at)
      VALUES (?, ?, ?, ?, 1, ?)`).run(id, notebookId, name, description, timestamp);
    const insertMember = this.db.prepare(
      'INSERT INTO scheme_members(scheme_id, run_id, position) VALUES (?, ?, ?)',
    );
    runIds.forEach((runId, position) => insertMember.run(id, runId, position));
  }

  _validateSchemeRunIds(notebookId, runIds) {
    if (!Array.isArray(runIds)) throw new StoreError('VALIDATION', 'runIds must be an array.');
    const normalized = runIds.map((runId, index) => normalizeUuid(runId, `runIds[${index}]`));
    if (new Set(normalized).size !== normalized.length) throw new StoreError('VALIDATION', 'A scheme cannot contain a run more than once.');
    if (normalized.length) {
      const rows = this.db.prepare(`SELECT id, notebook_id FROM runs WHERE id IN (${sqlitePlaceholders(normalized.length)})`).all(...normalized);
      const found = new Map(rows.map(row => [row.id, row]));
      for (const runId of normalized) {
        const row = found.get(runId);
        if (!row) throw new StoreError('NOT_FOUND', 'A scheme run was not found.');
        if (row.notebook_id !== notebookId) throw new StoreError('VALIDATION', 'Scheme runs must belong to the same notebook.');
      }
    }
    return normalized;
  }

  _updateScheme(payload) {
    if (!isPlainObject(payload)) throw new StoreError('VALIDATION', 'Scheme update payload must be an object.');
    const id = normalizeUuid(payload.id);
    const expectedRevision = validateExpectedRevision(payload.expectedRevision);
    const row = this._requireRow('schemes', id, 'Scheme');
    if (row.revision !== expectedRevision) throw new StoreError('STALE_REVISION', 'Scheme changed since it was loaded.');
    const hasName = Object.prototype.hasOwnProperty.call(payload, 'name');
    const hasDescription = Object.prototype.hasOwnProperty.call(payload, 'description');
    const hasRunIds = Object.prototype.hasOwnProperty.call(payload, 'runIds');
    if (!hasName && !hasDescription && !hasRunIds) throw new StoreError('VALIDATION', 'Scheme update has no changes.');
    const name = hasName ? requireText(payload.name, 'name') : row.name;
    const description = hasDescription ? requireText(payload.description, 'description', { allowEmpty: true }) : row.description;
    const runIds = hasRunIds ? this._validateSchemeRunIds(row.notebook_id, payload.runIds) : null;
    const timestamp = nowTimestamp();
    const result = this.db.prepare(`UPDATE schemes SET name=?, description=?, revision=revision+1 WHERE id=? AND revision=?`).run(name, description, id, expectedRevision);
    if (result.changes !== 1) throw new StoreError('STALE_REVISION', 'Scheme changed since it was loaded.');
    if (hasRunIds) {
      this.db.prepare('DELETE FROM scheme_members WHERE scheme_id=?').run(id);
      const insert = this.db.prepare('INSERT INTO scheme_members(scheme_id, run_id, position) VALUES (?, ?, ?)');
      runIds.forEach((runId, position) => insert.run(id, runId, position));
    }
  }

  _removeScheme(payload) {
    if (!isPlainObject(payload)) throw new StoreError('VALIDATION', 'Scheme removal payload must be an object.');
    const id = normalizeUuid(payload.id);
    const expectedRevision = validateExpectedRevision(payload.expectedRevision);
    const row = this._requireRow('schemes', id, 'Scheme');
    if (row.revision !== expectedRevision) throw new StoreError('STALE_REVISION', 'Scheme changed since it was loaded.');
    const result = this.db.prepare('DELETE FROM schemes WHERE id=? AND revision=?').run(id, expectedRevision);
    if (result.changes !== 1) throw new StoreError('STALE_REVISION', 'Scheme changed since it was loaded.');
  }

  _updatePreferences(payload) {
    const changes = validatePreferencesChange(payload);
    const keys = Object.keys(changes);
    if (keys.length === 0) throw new StoreError('VALIDATION', 'Preference changes are empty.');
    const current = this.db.prepare('SELECT appearance, palette, layout, directory_view, sort FROM preferences WHERE id=1').get();
    if (!current) throw new StoreError('CORRUPT_BACKUP', 'Library preferences row is missing.');
    const next = {
      appearance: changes.appearance ?? Number(current.appearance),
      palette: changes.palette ?? current.palette,
      layout: changes.layout ?? current.layout,
      directoryView: changes.directoryView ?? current.directory_view,
      sort: changes.sort ?? current.sort,
    };
    this.db.prepare(`UPDATE preferences SET appearance=?, palette=?, layout=?, directory_view=?, sort=? WHERE id=1`).run(
      next.appearance, next.palette, next.layout, next.directoryView, next.sort,
    );
  }

  _trashMove(payload) {
    if (!isPlainObject(payload)) throw new StoreError('VALIDATION', 'Trash move payload must be an object.');
    const kind = payload.kind;
    if (!['notebook', 'experiment', 'run'].includes(kind)) throw new StoreError('VALIDATION', 'Trash kind is invalid.');
    const id = normalizeUuid(payload.id);
    const expectedRevision = validateExpectedRevision(payload.expectedRevision);
    const table = kind === 'notebook' ? 'notebooks' : kind === 'experiment' ? 'experiments' : 'runs';
    const label = kind[0].toUpperCase() + kind.slice(1);
    const row = this._requireRow(table, id, label);
    if (row.revision !== expectedRevision) throw new StoreError('STALE_REVISION', `${label} changed since it was loaded.`);
    if (row.trashed_at !== null) throw new StoreError('VALIDATION', `${label} is already in the trash.`);
    const timestamp = nowTimestamp();
    const result = this.db.prepare(`UPDATE ${table} SET trashed_at=?, revision=revision+1, updated_at=?
      WHERE id=? AND revision=? AND trashed_at IS NULL`).run(timestamp, timestamp, id, expectedRevision);
    if (result.changes !== 1) throw new StoreError('STALE_REVISION', `${label} changed since it was loaded.`);
    // Trash is an independent flag on each record. A parent in the trash
    // hides its descendants in the UI, while descendant trashedAt/revisions
    // remain untouched so restoring the parent preserves each child state.
  }

  _trashRestore(payload) {
    if (!isPlainObject(payload)) throw new StoreError('VALIDATION', 'Trash restore payload must be an object.');
    const kind = payload.kind;
    if (!['notebook', 'experiment', 'run'].includes(kind)) throw new StoreError('VALIDATION', 'Trash kind is invalid.');
    const id = normalizeUuid(payload.id);
    const expectedRevision = validateExpectedRevision(payload.expectedRevision);
    const table = kind === 'notebook' ? 'notebooks' : kind === 'experiment' ? 'experiments' : 'runs';
    const label = kind[0].toUpperCase() + kind.slice(1);
    const row = this._requireRow(table, id, label);
    if (row.revision !== expectedRevision) throw new StoreError('STALE_REVISION', `${label} changed since it was loaded.`);
    if (row.trashed_at === null) throw new StoreError('VALIDATION', `${label} is not in the trash.`);
    if (kind === 'experiment') {
      const notebook = this._requireRow('notebooks', row.notebook_id, 'Notebook');
      if (notebook.trashed_at !== null) throw new StoreError('VALIDATION', 'Restore the notebook before restoring this experiment.');
    } else if (kind === 'run') {
      const experiment = this._requireRow('experiments', row.experiment_id, 'Experiment');
      const notebook = this._requireRow('notebooks', row.notebook_id, 'Notebook');
      if (notebook.trashed_at !== null || experiment.trashed_at !== null) throw new StoreError('VALIDATION', 'Restore the run ancestors first.');
    }
    const timestamp = nowTimestamp();
    const result = this.db.prepare(`UPDATE ${table} SET trashed_at=NULL, revision=revision+1, updated_at=? WHERE id=? AND revision=? AND trashed_at IS NOT NULL`).run(timestamp, id, expectedRevision);
    if (result.changes !== 1) throw new StoreError('STALE_REVISION', `${label} changed since it was loaded.`);
  }

  _trashPurge(payload) {
    if (!isPlainObject(payload)) throw new StoreError('VALIDATION', 'Trash purge payload must be an object.');
    const kind = payload.kind;
    if (!['notebook', 'experiment', 'run'].includes(kind)) throw new StoreError('VALIDATION', 'Trash kind is invalid.');
    const id = normalizeUuid(payload.id);
    const expectedRevision = validateExpectedRevision(payload.expectedRevision);
    const table = kind === 'notebook' ? 'notebooks' : kind === 'experiment' ? 'experiments' : 'runs';
    const label = kind[0].toUpperCase() + kind.slice(1);
    const row = this._requireRow(table, id, label);
    if (row.revision !== expectedRevision) throw new StoreError('STALE_REVISION', `${label} changed since it was loaded.`);
    if (row.trashed_at === null) throw new StoreError('VALIDATION', `${label} must be in the trash before purge.`);

    let experimentIds = [];
    let runIds = [];
    let schemeIds = [];
    if (kind === 'notebook') {
      experimentIds = this.db.prepare('SELECT id FROM experiments WHERE notebook_id=?').all(id).map(item => item.id);
      runIds = this.db.prepare('SELECT id, trashed_at FROM runs WHERE notebook_id=?').all(id).map(item => item);
      schemeIds = this.db.prepare('SELECT id FROM schemes WHERE notebook_id=?').all(id).map(item => item.id);
    } else if (kind === 'experiment') {
      experimentIds = [id];
      runIds = this.db.prepare('SELECT id, trashed_at FROM runs WHERE experiment_id=?').all(id).map(item => item);
    } else {
      runIds = [{ id, trashed_at: row.trashed_at }];
    }
    const runIdValues = runIds.map(item => item.id);
    const hashes = runIdValues.length
      ? this.db.prepare(`SELECT hash FROM attachments WHERE run_id IN (${sqlitePlaceholders(runIdValues.length)})`).all(...runIdValues).map(item => item.hash)
      : [];
    if (runIdValues.length) {
      this.db.prepare(`DELETE FROM attachments WHERE run_id IN (${sqlitePlaceholders(runIdValues.length)})`).run(...runIdValues);
      this.db.prepare(`DELETE FROM scheme_members WHERE run_id IN (${sqlitePlaceholders(runIdValues.length)})`).run(...runIdValues);
      this.db.prepare(`DELETE FROM runs WHERE id IN (${sqlitePlaceholders(runIdValues.length)})`).run(...runIdValues);
    }
    if (kind === 'notebook' && schemeIds.length) {
      this.db.prepare(`DELETE FROM schemes WHERE id IN (${sqlitePlaceholders(schemeIds.length)})`).run(...schemeIds);
    }
    if (kind === 'experiment') {
      this.db.prepare('DELETE FROM experiments WHERE id=?').run(id);
    } else if (kind === 'notebook') {
      if (experimentIds.length) this.db.prepare(`DELETE FROM experiments WHERE id IN (${sqlitePlaceholders(experimentIds.length)})`).run(...experimentIds);
      this.db.prepare('DELETE FROM notebooks WHERE id=?').run(id);
    }
    return { gcHashes: hashes };
  }

  _addAttachment(record) {
    if (!isPlainObject(record)) throw new StoreError('VALIDATION', 'Attachment record must be an object.');
    const id = normalizeUuid(record.id);
    const runId = normalizeUuid(record.runId, 'runId');
    this._requireActiveRun(runId);
    const name = requireText(record.name, 'name');
    const mime = requireText(record.mime, 'mime');
    const size = validateInteger(record.size, 'size', { min: 0 });
    const hash = validateHash(record.hash);
    const caption = requireText(record.caption, 'caption', { allowEmpty: true });
    if (!ATTACHMENT_KINDS.has(record.kind)) throw new StoreError('VALIDATION', 'Attachment kind is invalid.');
    const createdAt = validateTimestamp(record.createdAt);
    if (this.db.prepare('SELECT 1 FROM attachments WHERE id=?').get(id)) {
      throw new StoreError('VALIDATION', 'Attachment id already exists.');
    }
    this.db.prepare(`INSERT INTO attachments
      (id, run_id, name, mime, size, hash, caption, kind, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, runId, name, mime, size, hash, caption, record.kind, createdAt);
  }

  _getAttachmentUnsafe(id) {
    const normalized = normalizeUuid(id);
    const row = this.db.prepare('SELECT * FROM attachments WHERE id=?').get(normalized);
    if (!row) throw new StoreError('NOT_FOUND', 'Attachment was not found.');
    return {
      id: row.id,
      runId: row.run_id,
      name: row.name,
      mime: row.mime,
      size: Number(row.size),
      hash: row.hash,
      caption: row.caption,
      kind: row.kind,
      createdAt: row.created_at,
    };
  }

  _updateAttachment(id, caption) {
    const normalized = normalizeUuid(id);
    const runId = this.db.prepare('SELECT run_id FROM attachments WHERE id=?').get(normalized);
    if (!runId) throw new StoreError('NOT_FOUND', 'Attachment was not found.');
    this._requireActiveRun(runId.run_id);
    const nextCaption = requireText(caption, 'caption', { allowEmpty: true });
    this.db.prepare('UPDATE attachments SET caption=? WHERE id=?').run(nextCaption, normalized);
  }

  _removeAttachment(id) {
    const normalized = normalizeUuid(id);
    const row = this.db.prepare('SELECT run_id, hash FROM attachments WHERE id=?').get(normalized);
    if (!row) throw new StoreError('NOT_FOUND', 'Attachment was not found.');
    this._requireActiveRun(row.run_id);
    const result = this.db.prepare('DELETE FROM attachments WHERE id=?').run(normalized);
    if (result.changes !== 1) throw new StoreError('NOT_FOUND', 'Attachment was not found.');
    return { gcHashes: [row.hash] };
  }

  _garbageCollect(hashes) {
    if (this.backupLocks !== 0 || !Array.isArray(hashes) || hashes.length === 0) return;
    const unique = [...new Set(hashes.map(hash => String(hash).toLowerCase()))];
    for (const hash of unique) {
      if (!SHA256_RE.test(hash)) continue;
      const reference = this.db.prepare('SELECT 1 FROM attachments WHERE hash=? LIMIT 1').get(hash);
      if (reference) continue;
      const objectPath = path.join(this.root, 'objects', hash);
      try {
        const stats = fs.lstatSync(objectPath);
        // Immutable objects must never be followed through a symlink during
        // cleanup. A later startup can inspect the orphan safely.
        if (!stats.isSymbolicLink() && stats.isFile()) fs.unlinkSync(objectPath);
      } catch (error) {
        if (error.code !== 'ENOENT') {
          // Object cleanup is deliberately best effort after metadata commit;
          // leaving an orphan is safer than failing a successful record edit.
        }
      }
    }
  }

  addAttachment(record) {
    return this._mutateRaw(() => this._addAttachment(record));
  }

  getAttachment(id) {
    return this._readRaw(() => this._getAttachmentUnsafe(id));
  }

  updateAttachment(id, caption) {
    return this._mutateRaw(() => this._updateAttachment(id, caption));
  }

  removeAttachment(id) {
    return this._mutateRaw(() => this._removeAttachment(id));
  }

  dispatch(method, payload) {
    try {
      this._assertOpen();
      switch (method) {
        case 'records.snapshot':
          return ok(this._snapshotUnsafe());
        case 'records.createNotebook':
          return this._mutate(() => this._createNotebook(payload));
        case 'records.updateNotebook':
          return this._mutate(() => this._updateNotebook(payload));
        case 'records.createExperiment':
          return this._mutate(() => this._createExperiment(payload));
        case 'records.updateExperiment':
          return this._mutate(() => this._updateExperiment(payload));
        case 'records.repeatRun':
          return this._mutate(() => this._repeatRun(payload));
        case 'records.updateRun':
          return this._mutate(() => this._updateRun(payload));
        case 'documents.save':
          return this._mutate(() => this._saveDocuments(payload));
        case 'schemes.create':
          return this._mutate(() => this._createScheme(payload));
        case 'schemes.update':
          return this._mutate(() => this._updateScheme(payload));
        case 'schemes.remove':
          return this._mutate(() => this._removeScheme(payload));
        case 'preferences.update':
          return this._mutate(() => this._updatePreferences(payload));
        case 'trash.move':
          return this._mutate(() => this._trashMove(payload));
        case 'trash.restore':
          return this._mutate(() => this._trashRestore(payload));
        case 'trash.purge':
          return this._mutate(() => this._trashPurge(payload));
        case 'attachments.update':
          if (!isPlainObject(payload)) return failure('VALIDATION', 'Attachment update payload must be an object.');
          return ok(this.updateAttachment(payload.id, payload.caption));
        case 'attachments.remove':
          if (!isPlainObject(payload)) return failure('VALIDATION', 'Attachment removal payload must be an object.');
          return ok(this.removeAttachment(payload.id));
        case 'attachments.add':
          // Internal convenience operation for the files service; it is not a
          // renderer-facing operation in the shared contract.
          return ok(this.addAttachment(payload));
        case 'attachments.get':
          if (!isPlainObject(payload)) return failure('VALIDATION', 'Attachment lookup payload must be an object.');
          return ok(this.getAttachment(payload.id));
        case 'attachments.import':
        case 'attachments.preview':
        case 'attachments.open':
        case 'exports.write':
        case 'backups.status':
        case 'backups.configure':
        case 'backups.run':
        case 'backups.restore':
        case 'jobs.cancel':
          return failure('UNAVAILABLE', `${method} is handled by another backend service.`);
        default:
          return failure('UNAVAILABLE', `Unknown operation: ${String(method)}.`);
      }
    } catch (error) {
      return toResult(error);
    }
  }

  async backupDatabase(destination) {
    if (typeof destination !== 'string' || destination.trim().length === 0) {
      throw new StoreError('VALIDATION', 'Backup destination must be a non-empty path.');
    }
    let target;
    try {
      this._assertOpen();
      if (this._backupActive) throw new StoreError('UNAVAILABLE', 'A database backup is already running.');
      target = path.resolve(destination);
      if (target === this.databasePath) throw new StoreError('VALIDATION', 'Backup destination must differ from the live database.');
      fs.mkdirSync(path.dirname(target), { recursive: true });
      this._backupActive = true;
      this.backupLocks += 1;
      if (typeof this.db.backup !== 'function') throw new StoreError('UNAVAILABLE', 'better-sqlite3 database backup is unavailable.');
      await this.db.backup(target);
      return { destination: target };
    } catch (error) {
      throw asStoreError(error);
    } finally {
      if (this._backupActive) {
        this._backupActive = false;
        this.backupLocks = Math.max(0, this.backupLocks - 1);
      }
    }
  }

  close() {
    try {
      if (this._backupActive) throw new StoreError('UNAVAILABLE', 'Cannot close while a backup is running.');
      if (!this._closed && this.db) this.db.close();
      this.db = null;
      this._closed = true;
    } catch (error) {
      throw asStoreError(error);
    }
  }

  reopen() {
    try {
      if (this._backupActive) throw new StoreError('UNAVAILABLE', 'Cannot reopen while a backup is running.');
      if (!this._closed && this.db) this.db.close();
      this.db = null;
      this._closed = true;
      this._open();
    } catch (error) {
      throw asStoreError(error);
    }
  }
}

module.exports = {
  LibraryStore,
  StoreError,
  SCHEMA_VERSION,
  EMPTY_DOCUMENT,
  recoverRestoreJournal,
};
