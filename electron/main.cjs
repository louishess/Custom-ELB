/*
 * LabMate desktop process.
 *
 * Renderer input is treated as hostile even though the renderer is loaded from
 * our own local protocol. The renderer can ask for an allowlisted operation;
 * main validates that request, obtains native paths/confirmation when needed,
 * and passes a narrowly shaped internal message to the utility worker.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');

let electron = {};
try { electron = require('electron'); } catch { /* source-only tests */ }

const {
  app,
  BrowserWindow,
  Menu,
  protocol,
  net,
  session,
  ipcMain,
  dialog,
  shell,
  clipboard,
  safeStorage,
  utilityProcess,
} = electron;

let workerContract = {};
try { workerContract = require('./backend/worker.cjs'); } catch { /* source-only boot */ }

// zod is required at runtime. A missing dependency must fail packaging/startup
// rather than silently weakening validation at the renderer boundary.
const z = require('zod');
const { createDictationService, validateSession } = require('./dictation.cjs');
const { calculateMarkedYield, validateManualMaterial } = require('../shared/material-yield.cjs');

const INVOKE_CHANNEL = 'labmate:invoke';
const PROGRESS_CHANNEL = 'labmate:progress';
const DICTATION_CHANNEL = 'labmate:dictation';
const CLOSE_LISTENER_CHANNEL = 'labmate:close-listener-registered';
const CLOSE_REQUEST_CHANNEL = 'labmate:before-close';
const CLOSE_RESULT_CHANNEL = 'labmate:before-close-result';

const PUBLIC_METHODS = Object.freeze(new Set([
  'records.snapshot',
  'records.createNotebook',
  'records.updateNotebook',
  'records.createExperiment',
  'records.updateExperiment',
  'records.repeatRun',
  'records.updateRun',
  'documents.save',
  'yield.copy',
  'schemes.create',
  'schemes.update',
  'schemes.remove',
  'preferences.update',
  'trash.move',
  'trash.restore',
  'trash.purge',
  'attachments.import',
  'attachments.preview',
  'attachments.open',
  'attachments.update',
  'attachments.remove',
  'exports.write',
  'backups.status',
  'backups.configure',
  'backups.changeDestination',
  'backups.revealDestination',
  'backups.run',
  'backups.restore',
  'jobs.cancel',
  'dictation.capabilities', 'dictation.prepare', 'dictation.start', 'dictation.stop', 'dictation.cancel',
]));

const JOB_METHODS = Object.freeze(new Set([
  'attachments.import',
  'attachments.preview',
  'exports.write',
  'backups.run',
  'backups.restore',
]));

const ERROR_CODES = Object.freeze(new Set([
  'VALIDATION', 'NOT_FOUND', 'STALE_REVISION', 'IO', 'CANCELLED',
  'UNAVAILABLE', 'CORRUPT_BACKUP',
]));

const DEFAULT_CLOSE_TIMEOUT_MS = 2_000;
const DEFAULT_WORKER_CLOSE_TIMEOUT_MS = 3_000;
const DAILY_BACKUP_INTERVAL_MS = 60 * 60 * 1_000;
const OPEN_CACHE_MAX_ENTRIES = 64;
const OPEN_CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1_000;

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function resultError(code, message) {
  return {
    ok: false,
    error: {
      code: ERROR_CODES.has(code) ? code : 'IO',
      message: String(message || 'Desktop operation failed').slice(0, 500),
    },
  };
}

function normalizeResult(result) {
  if (result && typeof result === 'object' && result.ok === true) return { ok: true, value: result.value };
  if (result && typeof result === 'object' && result.ok === false && result.error && typeof result.error === 'object') {
    return resultError(result.error.code, result.error.message);
  }
  return resultError('IO', 'Malformed backend result');
}

function unavailableResult(message = 'Backend worker unavailable') {
  return resultError('UNAVAILABLE', message);
}

function cancelledResult(message = 'Operation cancelled') {
  return resultError('CANCELLED', message);
}

function isAllowedAppURL(value) {
  if (typeof value !== 'string' || value.length > 4_096) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'elb:' && url.hostname === 'app'
      && url.username === '' && url.password === '' && url.port === '';
  } catch {
    return false;
  }
}

function isAllowedResourceURL(value) {
  if (isAllowedAppURL(value)) return true;
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    // PDF/image previews may use an object URL whose embedded origin is the
    // local app.  Keep http(s), data, file, and foreign blob origins denied.
    return url.protocol === 'blob:' && isAllowedAppURL(url.pathname);
  } catch {
    return false;
  }
}

function isAllowedTopFrame(event) {
  if (!event || !event.sender || !event.senderFrame) return false;
  const sender = event.sender;
  const frame = event.senderFrame;
  if (sender.mainFrame && frame !== sender.mainFrame) return false;
  let frameURL;
  try { frameURL = frame.url; } catch { return false; }
  if (!isAllowedAppURL(frameURL)) return false;
  if (typeof sender.getURL === 'function') {
    let senderURL;
    try { senderURL = sender.getURL(); } catch { return false; }
    if (senderURL && !isAllowedAppURL(senderURL)) return false;
  }
  return true;
}

function isSafeJobId(value) {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 128
    && /^[A-Za-z0-9._:-]+$/.test(value);
}

function publicPayloadError(method, payload) {
  if (!PUBLIC_METHODS.has(method)) return 'Unknown desktop method';
  if (method === 'yield.copy') return isPlainObject(payload) && Object.keys(payload).length === 2
    && ['starting', 'product'].every(key => isPlainObject(payload[key]) && Object.keys(payload[key]).every(field => ['text','manual'].includes(field))
      && typeof payload[key].text === 'string' && payload[key].text.length > 0 && payload[key].text.length <= 10000
      && (payload[key].manual === undefined || validateManualMaterial(payload[key].manual)))
    ? null : 'Copy Yield requires two marked material descriptions.';
  if (method === 'attachments.open') {
    return isPlainObject(payload) && Object.keys(payload).length === 1
      && typeof payload.id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(payload.id)
      ? null : 'Invalid attachments.open payload';
  }
  if (['backups.status', 'backups.changeDestination', 'backups.revealDestination'].includes(method)) return payload === undefined ? null : `${method} takes no payload`;
  if (method === 'dictation.capabilities') return payload === undefined ? null : 'Dictation capabilities takes no payload';
  if (method.startsWith('dictation.')) {
    try { validateSession(payload, ['dictation.prepare', 'dictation.start'].includes(method)); return null; }
    catch { return 'Invalid dictation payload'; }
  }
  if (method === 'backups.configure') {
    return isPlainObject(payload) && Object.keys(payload).length === 1
      && typeof payload.password === 'string' && payload.password.length >= 1 && payload.password.length <= 4_096
      ? null : 'Invalid backups.configure payload';
  }
  if (typeof workerContract.payloadShapeError === 'function') {
    const error = workerContract.payloadShapeError(method, payload, false);
    return error || null;
  }
  if (method === 'jobs.cancel') return isPlainObject(payload) && Object.keys(payload).length === 1 && isSafeJobId(payload.jobId)
    ? null : 'Invalid jobs.cancel payload';
  return null;
}

function validateRendererPayload(method, payload) {
  const shapeError = publicPayloadError(method, payload);
  const schema = z.unknown().superRefine((_value, context) => {
    if (shapeError) context.addIssue({ code: z.ZodIssueCode.custom, message: shapeError });
  });
  const parsed = schema.safeParse(payload);
  if (!parsed.success) return resultError('VALIDATION', shapeError || 'Invalid renderer payload');
  return shapeError ? resultError('VALIDATION', shapeError) : { ok: true, value: payload };
}

function validateJobEvent(value) {
  if (!isPlainObject(value)) return false;
  return typeof value.jobId === 'string'
    && typeof value.operation === 'string'
    && typeof value.phase === 'string'
    && (value.completed === undefined || (typeof value.completed === 'number' && Number.isFinite(value.completed)))
    && (value.total === undefined || (typeof value.total === 'number' && Number.isFinite(value.total)))
    && (value.message === undefined || typeof value.message === 'string');
}

function cloneJobEvent(value) {
  if (!validateJobEvent(value)) return null;
  const event = { jobId: value.jobId, operation: value.operation, phase: value.phase };
  if (value.completed !== undefined) event.completed = value.completed;
  if (value.total !== undefined) event.total = value.total;
  if (value.message !== undefined) event.message = value.message.slice(0, 500);
  return event;
}

function resolveBackendRoot(appApi = app, env = process.env) {
  const override = env && typeof env.LABMATE_LIBRARY_ROOT === 'string' && env.LABMATE_LIBRARY_ROOT.trim()
    ? env.LABMATE_LIBRARY_ROOT.trim()
    : null;
  if (override) return path.resolve(override);
  const appData = appApi && typeof appApi.getPath === 'function' ? appApi.getPath('appData') : process.cwd();
  return path.join(appData, 'LabMate');
}

function configureTestProfile(appApi = app, env = process.env) {
  if (!appApi || typeof appApi.setPath !== 'function') return null;
  const explicit = env && typeof env.LABMATE_TEST_PROFILE === 'string' && env.LABMATE_TEST_PROFILE.trim()
    ? env.LABMATE_TEST_PROFILE.trim()
    : null;
  const libraryOverride = env && typeof env.LABMATE_LIBRARY_ROOT === 'string' && env.LABMATE_LIBRARY_ROOT.trim()
    ? env.LABMATE_LIBRARY_ROOT.trim()
    : null;
  if (!explicit && !libraryOverride) return null;
  const profile = path.resolve(explicit || path.join(libraryOverride, 'profile'));
  try {
    appApi.setPath('userData', profile);
    appApi.setPath('sessionData', path.join(profile, 'session'));
    return profile;
  } catch {
    return null;
  }
}

function safeHomePath(appApi = app, env = process.env) {
  if (appApi && typeof appApi.getPath === 'function') {
    try {
      const home = appApi.getPath('home');
      if (typeof home === 'string' && home) return home;
    } catch { /* test doubles may omit the home path */ }
  }
  if (env && typeof env.HOME === 'string' && env.HOME) return env.HOME;
  return process.env.HOME || process.cwd();
}

function detectBoxDrivePaths(homeDirectory, fsApi = fs) {
  if (typeof homeDirectory !== 'string' || !path.isAbsolute(homeDirectory)) return [];
  const candidates = [
    path.join(homeDirectory, 'Library', 'CloudStorage', 'Box-Box'),
    path.join(homeDirectory, 'Library', 'CloudStorage', 'Box'),
    path.join(homeDirectory, 'Box'),
  ];
  return candidates.filter(candidate => {
    try { return fsApi.statSync(candidate).isDirectory(); } catch { return false; }
  });
}

function noNulAbsolute(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 4_096
    && path.isAbsolute(value) && !value.includes('\0');
}

function realpath(fsApi, value) {
  if (fsApi.realpathSync && typeof fsApi.realpathSync.native === 'function') return fsApi.realpathSync.native(value);
  return fsApi.realpathSync(value);
}

function validateExistingFile(value, fsApi = fs) {
  if (!noNulAbsolute(value)) return { ok: false, error: 'Selected file path is invalid' };
  try {
    const lstat = fsApi.lstatSync(value);
    if (lstat.isSymbolicLink() || !lstat.isFile()) return { ok: false, error: 'Selected file is not a regular file' };
    const resolved = realpath(fsApi, value);
    const stat = fsApi.statSync(resolved);
    return stat.isFile() ? { ok: true, value: resolved } : { ok: false, error: 'Selected file is not a regular file' };
  } catch {
    return { ok: false, error: 'Selected file is unavailable' };
  }
}

function validateExistingDirectory(value, fsApi = fs, { writable = false } = {}) {
  if (!noNulAbsolute(value)) return { ok: false, error: 'Selected folder path is invalid' };
  try {
    const lstat = fsApi.lstatSync(value);
    if (lstat.isSymbolicLink() || !lstat.isDirectory()) return { ok: false, error: 'Selected destination is not a regular folder' };
    const resolved = realpath(fsApi, value);
    const stat = fsApi.statSync(resolved);
    if (!stat.isDirectory()) return { ok: false, error: 'Selected destination is not a regular folder' };
    if (writable && fsApi.accessSync) fsApi.accessSync(resolved, fs.constants.W_OK);
    return { ok: true, value: resolved };
  } catch {
    return { ok: false, error: writable ? 'Selected destination is not writable' : 'Selected folder is unavailable' };
  }
}

function validateSaveDestination(value, fsApi = fs) {
  if (!noNulAbsolute(value)) return { ok: false, error: 'Save path is invalid' };
  try {
    const parent = path.dirname(value);
    const parentCheck = validateExistingDirectory(parent, fsApi);
    if (!parentCheck.ok) return { ok: false, error: 'Save folder is unavailable' };
    const base = path.basename(value);
    if (!base || base === '.' || base === path.sep) return { ok: false, error: 'Save filename is invalid' };
    if (fsApi.existsSync(value)) {
      const info = fsApi.lstatSync(value);
      if (info.isSymbolicLink() || info.isDirectory()) return { ok: false, error: 'Save path is not a regular file' };
    }
    return { ok: true, value: path.join(parentCheck.value, base) };
  } catch {
    return { ok: false, error: 'Save path is unavailable' };
  }
}

function openCacheDirectory(appApi = app) {
  let base;
  try {
    base = appApi && typeof appApi.getPath === 'function' ? appApi.getPath('cache') : null;
  } catch { base = null; }
  if (!base) {
    try { base = appApi && typeof appApi.getPath === 'function' ? appApi.getPath('userData') : null; }
    catch { base = null; }
  }
  return path.join(base || path.join(process.cwd(), '.labmate-cache'), 'LabMate', 'attachment-open');
}

function sanitizeAttachmentFilename(name, mime) {
  const extensionByMime = {
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'application/pdf': '.pdf',
    'text/csv': '.csv',
    'text/tab-separated-values': '.tsv',
  };
  let value = typeof name === 'string' ? name : 'attachment';
  value = value.replace(/[\\/\0\u0000-\u001f<>:"|?*]/g, '_').trim();
  value = value.replace(/\.{2,}/g, '_').replace(/^\.+/, '').replace(/\.+$/, '');
  if (!value) value = 'attachment';
  let extension = path.extname(value).replace(/[^A-Za-z0-9.]/g, '').slice(0, 20);
  if (!extension) extension = extensionByMime[mime] || '';
  let stem = extension ? value.slice(0, -extension.length) : value;
  stem = stem.replace(/\.{2,}/g, '_').replace(/^\.+/, '').replace(/\.+$/, '').slice(0, 120) || 'attachment';
  return `${stem}${extension.toLowerCase()}`;
}

function isWithinDirectory(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function cleanAttachmentOpenCache(appApi = app, fsApi = fs, { now = Date.now(), maxEntries = OPEN_CACHE_MAX_ENTRIES, maxAgeMs = OPEN_CACHE_MAX_AGE_MS } = {}) {
  const directory = openCacheDirectory(appApi);
  try {
    const entries = fsApi.readdirSync(directory, { withFileTypes: true })
      .map(entry => {
        const filePath = path.join(directory, entry.name);
        try { return { entry, filePath, stat: fsApi.lstatSync(filePath) }; } catch { return null; }
      })
      .filter(Boolean)
      .filter(item => item.stat.isFile() && !item.entry.isSymbolicLink())
      .sort((left, right) => right.stat.mtimeMs - left.stat.mtimeMs);
    for (const [index, item] of entries.entries()) {
      if (index >= maxEntries || now - item.stat.mtimeMs > maxAgeMs) {
        try { fsApi.unlinkSync(item.filePath); } catch { /* bounded cleanup is best effort */ }
      }
    }
  } catch { /* cache may not exist on first launch */ }
  return directory;
}

function copyAttachmentForOpen(info, { appApi = app, fsApi = fs, root } = {}) {
  if (!isPlainObject(info) || typeof info.path !== 'string') return resultError('IO', 'Attachment path is invalid');
  const source = validateExistingFile(info.path, fsApi);
  if (!source.ok) return resultError('NOT_FOUND', 'Attachment file is unavailable');
  if (root) {
    let objectsRoot = path.join(root, 'objects');
    try { objectsRoot = realpath(fsApi, objectsRoot); } catch { objectsRoot = path.resolve(objectsRoot); }
    if (!isWithinDirectory(objectsRoot, source.value)) return resultError('VALIDATION', 'Attachment path is outside the managed object store');
  }
  const directory = cleanAttachmentOpenCache(appApi, fsApi);
  const filename = `${Date.now()}-${crypto.randomUUID()}-${sanitizeAttachmentFilename(info.name, info.mime)}`;
  const target = path.join(directory, filename);
  try {
    fsApi.mkdirSync(directory, { recursive: true, mode: 0o700 });
    fsApi.copyFileSync(source.value, target, fs.constants.COPYFILE_EXCL);
    return { ok: true, value: target };
  } catch {
    return resultError('IO', 'Attachment could not be prepared for opening');
  }
}

function destinationLabel(destination) {
  const label = path.basename(destination || '');
  return label && label !== path.sep ? label : 'Selected folder';
}

function isValidStoredConfig(value) {
  return isPlainObject(value)
    && Object.keys(value).every(key => ['version', 'destination', 'encryptedPassword', 'lastBackupAt', 'lastAttemptAt', 'lastFailure'].includes(key))
    && value.version === 1
    && typeof value.destination === 'string'
    && noNulAbsolute(value.destination)
    && typeof value.encryptedPassword === 'string'
    && value.encryptedPassword.length > 0
    && value.encryptedPassword.length <= 16_384
    && (value.lastBackupAt == null || typeof value.lastBackupAt === 'string')
    && (value.lastAttemptAt == null || (typeof value.lastAttemptAt === 'string' && Number.isFinite(Date.parse(value.lastAttemptAt))))
    && (value.lastFailure == null || (isPlainObject(value.lastFailure)
      && Object.keys(value.lastFailure).every(key => ['at', 'message'].includes(key))
      && typeof value.lastFailure.at === 'string' && Number.isFinite(Date.parse(value.lastFailure.at))
      && typeof value.lastFailure.message === 'string' && value.lastFailure.message.length <= 500));
}

function atomicWriteJSON(fsApi, target, value) {
  const directory = path.dirname(target);
  fsApi.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    fsApi.writeFileSync(temporary, JSON.stringify(value), { encoding: 'utf8', mode: 0o600 });
    fsApi.renameSync(temporary, target);
  } catch (error) {
    try { fsApi.unlinkSync(temporary); } catch { /* best effort cleanup */ }
    throw error;
  }
}

class LocalConfigStore {
  constructor({ appApi = app, safeStorageApi = safeStorage, fsApi = fs, env = process.env } = {}) {
    this.appApi = appApi;
    this.safeStorageApi = safeStorageApi;
    this.fsApi = fsApi;
    this.env = env;
  }

  get filePath() {
    let userData;
    try {
      userData = this.appApi && typeof this.appApi.getPath === 'function'
        ? this.appApi.getPath('userData')
        : path.join(process.cwd(), '.labmate-user-data');
    } catch {
      userData = path.join(process.cwd(), '.labmate-user-data');
    }
    return path.join(userData, 'labmate-config.json');
  }

  isEncryptionAvailable() {
    try {
      return !!this.safeStorageApi
        && typeof this.safeStorageApi.isEncryptionAvailable === 'function'
        && this.safeStorageApi.isEncryptionAvailable()
        && typeof this.safeStorageApi.encryptString === 'function'
        && typeof this.safeStorageApi.decryptString === 'function';
    } catch {
      return false;
    }
  }

  readRaw() {
    try {
      const text = this.fsApi.readFileSync(this.filePath, 'utf8');
      const value = JSON.parse(text);
      return isValidStoredConfig(value) ? { ok: true, value } : resultError('CORRUPT_BACKUP', 'Local backup settings are invalid');
    } catch (error) {
      if (error && error.code === 'ENOENT') return { ok: true, value: null };
      return resultError('IO', 'Local backup settings could not be read');
    }
  }

  decrypt(value) {
    if (!this.isEncryptionAvailable()) return unavailableResult('Secure Keychain storage is unavailable; retry backup setup');
    try {
      const password = this.safeStorageApi.decryptString(Buffer.from(value.encryptedPassword, 'base64'));
      if (typeof password !== 'string' || password.length === 0) return unavailableResult('Stored backup password is unavailable; retry backup setup');
      return { ok: true, value: { ...value, password } };
    } catch {
      return unavailableResult('Stored backup password is unavailable; retry backup setup');
    }
  }

  readUsable() {
    const raw = this.readRaw();
    if (!raw.ok) return raw;
    if (!raw.value) return { ok: true, value: null };
    const decrypted = this.decrypt(raw.value);
    if (!decrypted.ok) return decrypted;
    const folder = validateExistingDirectory(decrypted.value.destination, this.fsApi, { writable: true });
    if (!folder.ok) return unavailableResult('Backup destination is unavailable; retry backup setup');
    return { ok: true, value: { ...decrypted.value, destination: folder.value } };
  }

  readStatus() {
    const raw = this.readRaw();
    if (!raw.ok || !raw.value) return raw;
    const decrypted = this.decrypt(raw.value);
    if (!decrypted.ok) return decrypted;
    const folder = validateExistingDirectory(raw.value.destination, this.fsApi, { writable: true });
    return { ok: true, value: { ...raw.value, destinationAvailable: folder.ok } };
  }

  changeDestination(destination) {
    const raw = this.readRaw();
    if (!raw.ok || !raw.value) return raw.ok ? unavailableResult('Set up a backup password first') : raw;
    const decrypted = this.decrypt(raw.value);
    if (!decrypted.ok) return decrypted;
    const folder = validateExistingDirectory(destination, this.fsApi, { writable: true });
    if (!folder.ok) return resultError('VALIDATION', folder.error);
    const same = folder.value === raw.value.destination;
    try {
      const config = { ...raw.value, destination: folder.value, lastBackupAt: same ? raw.value.lastBackupAt : null,
        lastAttemptAt: same ? raw.value.lastAttemptAt : null, lastFailure: same ? raw.value.lastFailure : null };
      atomicWriteJSON(this.fsApi, this.filePath, config);
      return { ok: true, value: config };
    } catch { return resultError('IO', 'Backup destination could not be saved'); }
  }

  recordAttempt(timestamp, failure) {
    const raw = this.readRaw();
    if (!raw.ok || !raw.value) return raw.ok ? unavailableResult('Backup settings are not configured') : raw;
    try {
      atomicWriteJSON(this.fsApi, this.filePath, { ...raw.value, lastAttemptAt: timestamp,
        ...(failure ? { lastFailure: { at: new Date().toISOString(), message: String(failure).slice(0, 500) } } : {}) });
      return { ok: true, value: timestamp };
    } catch { return resultError('IO', 'Backup attempt could not be recorded'); }
  }

  configure(destination, password) {
    if (!this.isEncryptionAvailable()) return unavailableResult('Secure Keychain storage is unavailable; retry backup setup');
    if (typeof password !== 'string' || password.length === 0) return resultError('VALIDATION', 'Backup password is required');
    const folder = validateExistingDirectory(destination, this.fsApi, { writable: true });
    if (!folder.ok) return resultError('VALIDATION', folder.error);
    const canonicalDestination = folder.value;
    const raw = this.readRaw();
    const previous = raw.ok && raw.value ? raw.value : null;
    try {
      const encrypted = this.safeStorageApi.encryptString(password);
      if (!Buffer.isBuffer(encrypted) || encrypted.length === 0) return unavailableResult('Backup password could not be secured; retry setup');
      const config = {
        version: 1,
        destination: canonicalDestination,
        encryptedPassword: encrypted.toString('base64'),
        lastBackupAt: previous && previous.destination === canonicalDestination ? (previous.lastBackupAt || null) : null,
      };
      atomicWriteJSON(this.fsApi, this.filePath, config);
      return { ok: true, value: config };
    } catch {
      return resultError('IO', 'Backup settings could not be saved');
    }
  }

  recordBackupSuccess(timestamp) {
    const raw = this.readRaw();
    if (!raw.ok || !raw.value) return raw.ok ? unavailableResult('Backup settings are not configured') : raw;
    try {
      atomicWriteJSON(this.fsApi, this.filePath, { ...raw.value, lastBackupAt: timestamp, lastFailure: null });
      return { ok: true, value: timestamp };
    } catch {
      return resultError('IO', 'Backup completion could not be recorded');
    }
  }
}

function randomJobId() {
  return crypto.randomUUID();
}

class WorkerClient {
  constructor({
    utilityProcessApi = utilityProcess,
    workerPath = path.join(__dirname, 'backend', 'worker.cjs'),
    root,
    onProgress = () => {},
    onExit = () => {},
  } = {}) {
    this.utilityProcessApi = utilityProcessApi;
    this.workerPath = workerPath;
    this.root = root || resolveBackendRoot();
    this.onProgress = onProgress;
    this.onExit = onExit;
    this.worker = null;
    this.failed = false;
    this.closing = false;
    this.pending = new Map();
  }

  start() {
    if (this.worker && !this.failed) return { ok: true, value: true };
    if (!this.utilityProcessApi || typeof this.utilityProcessApi.fork !== 'function') {
      return unavailableResult('Utility worker is unavailable');
    }
    try {
      const child = this.utilityProcessApi.fork(this.workerPath, [this.root], { serviceName: 'LabMate backend' });
      this.worker = child;
      this.failed = false;
      if (typeof child.on === 'function') {
        child.on('message', message => this.handleMessage(message));
        child.on('exit', code => this.handleExit(code));
        child.on('error', () => this.handleExit(-1));
      }
      return { ok: true, value: true };
    } catch {
      this.worker = null;
      this.failed = true;
      return unavailableResult('Utility worker could not be started');
    }
  }

  handleMessage(message) {
    if (message && (typeof message === 'object' || typeof message === 'function')
      && 'data' in message && !('id' in message)) message = message.data;
    if (message && message.event === 'progress') {
      const event = cloneJobEvent(message.value);
      if (event) this.onProgress(event);
      return;
    }
    if (!message || typeof message.id !== 'string') return;
    const entry = this.pending.get(message.id);
    if (!entry) return;
    this.pending.delete(message.id);
    entry.resolve(normalizeResult(message.result));
  }

  handleExit(code) {
    this.worker = null;
    this.failed = true;
    const message = code === 0 ? 'Backend worker stopped' : 'Backend worker stopped unexpectedly';
    for (const entry of this.pending.values()) entry.resolve(unavailableResult(message));
    this.pending.clear();
    this.onExit(code);
  }

  request(method, payload) {
    const started = this.start();
    if (!started.ok) return Promise.resolve(started);
    if (!this.worker || typeof this.worker.postMessage !== 'function') return Promise.resolve(unavailableResult());
    const id = randomJobId();
    return new Promise(resolve => {
      this.pending.set(id, { resolve, method });
      try {
        this.worker.postMessage({ id, method, payload });
      } catch {
        this.pending.delete(id);
        resolve(unavailableResult('Backend worker could not receive the request'));
      }
    });
  }

  async close(timeoutMs = DEFAULT_WORKER_CLOSE_TIMEOUT_MS) {
    if (!this.worker) return { ok: true, value: true };
    this.closing = true;
    const worker = this.worker;
    const response = this.request('__shutdown', undefined);
    let result;
    try {
      result = await Promise.race([
        response,
        new Promise(resolve => setTimeout(() => resolve(unavailableResult('Timed out closing backend worker')), timeoutMs)),
      ]);
    } catch {
      result = unavailableResult('Timed out closing backend worker');
    }
    try { if (worker && typeof worker.kill === 'function') worker.kill(); } catch { /* best effort */ }
    this.worker = null;
    this.failed = true;
    this.closing = false;
    return result;
  }

  restart() {
    const old = this.worker;
    this.worker = null;
    this.failed = true;
    try { if (old && typeof old.kill === 'function') old.kill(); } catch { /* best effort */ }
    return this.start();
  }
}

function dialogResultCancelled() {
  return cancelledResult('Picker cancelled');
}

function getWindowForEvent(event, BrowserWindowApi = BrowserWindow) {
  if (!event || !event.sender) return null;
  if (BrowserWindowApi && typeof BrowserWindowApi.fromWebContents === 'function') {
    try {
      const window = BrowserWindowApi.fromWebContents(event.sender);
      if (window) return window;
    } catch { /* test doubles may not implement this helper */ }
  }
  return event.sender.__labmateWindow || null;
}

function makeBackupStatus(configResult, running, message) {
  if (!configResult.ok) return { configured: false, running: !!running, message: message || configResult.error.message };
  const config = configResult.value;
  if (!config) return { configured: false, running: !!running, ...(message ? { message } : {}) };
  return {
    configured: true,
    destinationLabel: destinationLabel(config.destination),
    destinationAvailable: config.destinationAvailable !== false,
    ...(config.lastAttemptAt ? { lastAttemptAt: config.lastAttemptAt } : {}),
    ...(config.lastFailure ? { lastFailure: config.lastFailure } : {}),
    ...(config.lastBackupAt ? { lastBackupAt: config.lastBackupAt } : {}),
    ...(running ? { running: true } : {}),
    ...(message ? { message } : {}),
  };
}

function isDailyBackupDue(lastBackupAt, now = Date.now()) {
  if (!lastBackupAt || typeof lastBackupAt !== 'string') return true;
  const parsed = Date.parse(lastBackupAt);
  if (!Number.isFinite(parsed)) return true;
  const current = new Date(now);
  const previous = new Date(parsed);
  return current.getFullYear() !== previous.getFullYear()
    || current.getMonth() !== previous.getMonth()
    || current.getDate() !== previous.getDate();
}

function createBridgeRuntime({
  appApi = app,
  BrowserWindowApi = BrowserWindow,
  dialogApi = dialog,
  shellApi = shell,
  clipboardApi = clipboard,
  safeStorageApi = safeStorage,
  utilityProcessApi = utilityProcess,
  fsApi = fs,
  env = process.env,
  root = resolveBackendRoot(appApi, env),
  workerPath = path.join(__dirname, 'backend', 'worker.cjs'),
  closeTimeoutMs = DEFAULT_CLOSE_TIMEOUT_MS,
  workerCloseTimeoutMs = DEFAULT_WORKER_CLOSE_TIMEOUT_MS,
  dictationFactory = createDictationService,
  } = {}) {
  const configStore = new LocalConfigStore({ appApi, safeStorageApi, fsApi, env });
  cleanAttachmentOpenCache(appApi, fsApi);
  const registeredCloseListeners = new Set();
  const closeWaiters = new Map();
  const allowedCloseWindows = new WeakSet();
  const jobWindows = new Map();
  const activeJobs = new Map();
  let backupInFlight = null;
  let backupTimer = null;
  let backupRunning = false;
  let backupMessage = '';
  let backupProgress = null;
  let shuttingDown = false;
  let allowWindowClose = false;

  const runtime = {
    root,
    configStore,
    activeJobs,
    jobWindows,
    worker: null,
    get allowWindowClose() { return allowWindowClose; },
    set allowWindowClose(value) { allowWindowClose = !!value; },
  };

  const speechOwners = new Map();
  const speech = dictationFactory({
    helperPath: appApi?.isPackaged
      ? path.join(process.resourcesPath, 'LabMate Speech.app', 'Contents', 'MacOS', 'LabMate Speech')
      : path.join(__dirname, '..', 'artifacts', 'LabMate Speech.app', 'Contents', 'MacOS', 'LabMate Speech'),
    onEvent: event => {
      const owner = speechOwners.get(event.sessionId);
      try { if (owner && !owner.isDestroyed?.()) owner.send(DICTATION_CHANNEL, event); } catch { /* closing renderer */ }
    },
  });
  runtime.speech = speech;
  runtime.cancelWindowDictation = contents => {
    for (const [sessionId, owner] of speechOwners) {
      if (owner === contents) { void speech.cancel({sessionId}).catch(() => {}); speechOwners.delete(sessionId); }
    }
  };
  async function invokeDictation(event, method, payload) {
    const operation = method.slice('dictation.'.length);
    if (operation === 'capabilities') return {ok: true, value: await speech.capabilities()};
    const owner = speechOwners.get(payload.sessionId);
    if (owner && owner !== event.sender) return resultError('VALIDATION', 'This dictation session belongs to another window');
    if (!owner) {
      if (speechOwners.size) return unavailableResult('Another dictation session is active');
      if (!['prepare', 'start', 'cancel'].includes(operation)) return resultError('VALIDATION', 'Dictation session is not active');
      speechOwners.set(payload.sessionId, event.sender);
    }
    try { return {ok: true, value: await speech[operation](payload)}; }
    finally { if (operation === 'cancel') speechOwners.delete(payload.sessionId); }
  }

  const forwardProgress = event => {
    if (activeJobs.get(event.jobId)?.method?.startsWith('backups.')) backupProgress = event;
    const targetId = jobWindows.get(event.jobId);
    let targets = [];
    if (targetId !== undefined && BrowserWindowApi && typeof BrowserWindowApi.fromId === 'function') {
      try {
        const target = BrowserWindowApi.fromId(targetId);
        if (target) targets = [target];
      } catch { /* window was closed */ }
    }
    if (targets.length === 0 && BrowserWindowApi && typeof BrowserWindowApi.getAllWindows === 'function') {
      try { targets = BrowserWindowApi.getAllWindows(); } catch { targets = []; }
    }
    for (const target of targets) {
      try { target.webContents.send(PROGRESS_CHANNEL, event); } catch { /* renderer is closing */ }
    }
  };

  const worker = new WorkerClient({
    utilityProcessApi,
    workerPath,
    root,
    onProgress: forwardProgress,
    onExit: () => { backupMessage = 'Backend worker stopped; retry the operation'; },
  });
  runtime.worker = worker;

  function reserveJob(requestedJobId, window) {
    const jobId = requestedJobId || randomJobId();
    if (!isSafeJobId(jobId)) return resultError('VALIDATION', 'Invalid job ID');
    if (activeJobs.has(jobId)) return resultError('VALIDATION', 'Job ID is already in use');
    activeJobs.set(jobId, { method: null, windowId: window && window.id });
    if (window && Number.isInteger(window.id)) jobWindows.set(jobId, window.id);
    return { ok: true, value: jobId };
  }

  function releaseJob(jobId) {
    activeJobs.delete(jobId);
    jobWindows.delete(jobId);
  }

  async function requestRendererFlush(window) {
    if (!window || !window.webContents) return true;
    const webContentsId = Number.isInteger(window.webContents.id) ? window.webContents.id : window.id;
    if (!Number.isInteger(webContentsId) || !registeredCloseListeners.has(webContentsId)) return true;
    const requestId = randomJobId();
    const promise = new Promise(resolve => closeWaiters.set(requestId, { resolve, webContentsId }));
    try {
      window.webContents.send(CLOSE_REQUEST_CHANNEL, requestId);
    } catch {
      closeWaiters.delete(requestId);
      return false;
    }
    const response = await Promise.race([
      promise,
      new Promise(resolve => setTimeout(() => resolve(false), closeTimeoutMs)),
    ]);
    closeWaiters.delete(requestId);
    return response === true;
  }

  async function runBackup(jobId, window, automatic = false) {
    if (backupInFlight) return unavailableResult('A backup or restore is already running');
    const attemptedAt = new Date().toISOString();
    const config = configStore.readUsable();
    if (!config.ok) {
      backupMessage = config.error.message;
      configStore.recordAttempt(attemptedAt, backupMessage);
      return config;
    }
    if (!config.value) return unavailableResult('Backup is not configured');
    const reserved = reserveJob(jobId, window);
    if (!reserved.ok) return reserved;
    const effectiveJobId = reserved.value;
    activeJobs.get(effectiveJobId).method = 'backups.run';
    backupRunning = true;
    backupMessage = automatic ? 'Running scheduled backup' : 'Creating encrypted backup';
    backupProgress = null;
    const attempted = configStore.recordAttempt(attemptedAt);
    if (!attempted.ok) { backupRunning = false; releaseJob(effectiveJobId); return attempted; }
    const operation = (async () => {
      try {
        const result = await runtime.worker.request('backups.run', {
          jobId: effectiveJobId,
          password: config.value.password,
          destination: config.value.destination,
        });
        if (!result.ok) {
          backupMessage = result.error.message;
          configStore.recordAttempt(attemptedAt, backupMessage);
          return result;
        }
        const workerValue = result.value && typeof result.value === 'object' ? result.value : {};
        const completedAt = typeof workerValue.createdAt === 'string' ? workerValue.createdAt : new Date().toISOString();
        const recorded = configStore.recordBackupSuccess(completedAt);
        if (!recorded.ok) {
          backupMessage = recorded.error.message;
          configStore.recordAttempt(attemptedAt, backupMessage);
          return recorded;
        }
        backupMessage = typeof workerValue.message === 'string' ? workerValue.message : 'Backup completed';
        return { ok: true, value: makeBackupStatus(configStore.readStatus(), false, backupMessage) };
      } catch (error) {
        backupMessage = 'Backup could not complete; retry the operation';
        configStore.recordAttempt(attemptedAt, backupMessage);
        return resultError('IO', backupMessage);
      } finally {
        backupRunning = false;
        backupProgress = null;
        releaseJob(effectiveJobId);
        backupInFlight = null;
      }
    })();
    backupInFlight = operation;
    return operation;
  }

  async function runRestore(payload, window) {
    if (backupInFlight) return unavailableResult('A backup or restore is already running');
    const reserved = reserveJob(payload.jobId, window);
    if (!reserved.ok) return reserved;
    const jobId = reserved.value;
    activeJobs.get(jobId).method = 'backups.restore';
    backupRunning = true;
    const operation = (async () => {
      try {
        // Flush before opening the native picker so the restore invariant is
        // owned by main even when a renderer calls this method directly.
        if (!(await requestRendererFlush(window))) return cancelledResult('Current edits could not be saved');
        const selected = await dialogApi.showOpenDialog(window, {
          title: 'Choose a LabMate backup',
          properties: ['openFile'],
          filters: [{ name: 'LabMate backup', extensions: ['labmatebackup', 'labmate', 'backup', 'zip'] }],
        });
        if (!selected || selected.canceled || !Array.isArray(selected.filePaths) || selected.filePaths.length !== 1) return dialogResultCancelled();
        const source = validateExistingFile(selected.filePaths[0], fsApi);
        if (!source.ok) return resultError('VALIDATION', source.error);

        const confirmation = await dialogApi.showMessageBox(window, {
          type: 'warning',
          title: 'Restore LabMate backup?',
          message: 'Restoring replaces the current library with this backup.',
          detail: 'The current library is retained as a rollback copy, but restore cannot be undone from the app menu.',
          buttons: ['Cancel', 'Restore'],
          defaultId: 0,
          cancelId: 0,
          noLink: true,
        });
        if (!confirmation || confirmation.response !== 1) return dialogResultCancelled();
        return runtime.worker.request('backups.restore', { password: payload.password, source: source.value, jobId });
      } finally {
        backupRunning = false;
        releaseJob(jobId);
        backupInFlight = null;
      }
    })();
    backupInFlight = operation;
    return operation;
  }

  async function importAttachments(payload, window) {
    const reserved = reserveJob(payload.jobId, window);
    if (!reserved.ok) return reserved;
    const jobId = reserved.value;
    activeJobs.get(jobId).method = 'attachments.import';
    try {
      const selected = await dialogApi.showOpenDialog(window, {
        title: 'Import attachment',
        properties: ['openFile', 'multiSelections'],
      });
      if (!selected || selected.canceled || !Array.isArray(selected.filePaths) || selected.filePaths.length === 0) return dialogResultCancelled();
      const paths = [];
      for (const candidate of selected.filePaths) {
        const checked = validateExistingFile(candidate, fsApi);
        if (!checked.ok) return resultError('VALIDATION', checked.error);
        if (!paths.includes(checked.value)) paths.push(checked.value);
      }
      return runtime.worker.request('attachments.import', { runId: payload.runId, paths, jobId });
    } finally {
      releaseJob(jobId);
    }
  }

  async function previewAttachment(payload, window) {
    const reserved = reserveJob(payload.jobId, window);
    if (!reserved.ok) return reserved;
    const jobId = reserved.value;
    activeJobs.get(jobId).method = 'attachments.preview';
    try {
      return await runtime.worker.request('attachments.preview', { id: payload.id, jobId });
    } finally {
      releaseJob(jobId);
    }
  }

  const exportExtensions = Object.freeze({ txt: 'txt', md: 'md', html: 'html', rtf: 'rtf', docx: 'docx' });

  async function writeExport(payload, window) {
    const reserved = reserveJob(payload.jobId, window);
    if (!reserved.ok) return reserved;
    const jobId = reserved.value;
    activeJobs.get(jobId).method = 'exports.write';
    try {
      const extension = exportExtensions[payload.format] || payload.format;
      const selected = await dialogApi.showSaveDialog(window, {
        title: 'Export LabMate entry',
        defaultPath: path.join(safeHomePath(appApi, env), `LabMate export.${extension}`),
        filters: [{ name: payload.format.toUpperCase(), extensions: [extension] }],
      });
      if (!selected || selected.canceled || typeof selected.filePath !== 'string') return dialogResultCancelled();
      const destination = validateSaveDestination(selected.filePath, fsApi);
      if (!destination.ok) return resultError('VALIDATION', destination.error);
      if (fsApi.existsSync(destination.value)) {
        const overwrite = await dialogApi.showMessageBox(window, {
          type: 'warning',
          title: 'Replace existing export?',
          message: 'A file with that name already exists.',
          buttons: ['Cancel', 'Replace'],
          defaultId: 0,
          cancelId: 0,
          noLink: true,
        });
        if (!overwrite || overwrite.response !== 1) return dialogResultCancelled();
      }
      return runtime.worker.request('exports.write', { ...payload, jobId, destination: destination.value });
    } finally {
      releaseJob(jobId);
    }
  }

  async function chooseBackupDestination(window) {
    const defaults = detectBoxDrivePaths(safeHomePath(appApi, env), fsApi);
    if (!defaults.length) return unavailableResult('Box Drive was not found. Install or open Box Drive, then retry setup.');
    const selected = await dialogApi.showOpenDialog(window, {
      title: 'Choose a Box Drive backup folder', defaultPath: defaults[0],
      properties: ['openDirectory', 'createDirectory'],
      message: 'Choose a folder inside Box Drive for completed encrypted archives.',
    });
    if (!selected || selected.canceled || !Array.isArray(selected.filePaths) || selected.filePaths.length !== 1) return dialogResultCancelled();
    const destination = validateExistingDirectory(selected.filePaths[0], fsApi, { writable: true });
    if (!destination.ok) return resultError('VALIDATION', destination.error);
    const insideBox = defaults.some(folder => {
      try { return isWithinDirectory(realpath(fsApi, folder), destination.value); } catch { return false; }
    });
    if (!insideBox) return resultError('VALIDATION', 'Choose a folder inside the detected Box Drive directory');
    return destination;
  }

  async function configureBackups(payload, window, changeOnly = false) {
    if (backupInFlight) return unavailableResult('Wait for the current backup or restore to finish');
    if (!configStore.isEncryptionAvailable()) return unavailableResult('Secure Keychain storage is unavailable; retry backup setup');
    const destination = await chooseBackupDestination(window);
    if (!destination.ok) return destination;
    // A scheduled backup can start while the native picker is open.
    if (backupInFlight) return unavailableResult('Wait for the current backup or restore to finish');
    const saved = changeOnly ? configStore.changeDestination(destination.value) : configStore.configure(destination.value, payload.password);
    if (!saved.ok) return saved;
    const verified = configStore.readStatus();
    if (!verified.ok) return verified;
    if (!verified.value) return unavailableResult('Backup configuration could not be verified; retry setup');
    backupMessage = 'Destination ready. Create a first backup to verify your copy.';
    return { ok: true, value: makeBackupStatus(verified, false, backupMessage) };
  }

  async function revealBackupDestination() {
    const config = configStore.readRaw();
    if (!config.ok) return config;
    if (!config.value) return unavailableResult('Backup is not configured');
    const folder = validateExistingDirectory(config.value.destination, fsApi);
    if (!folder.ok) return unavailableResult('Backup destination is unavailable');
    if (!shellApi || typeof shellApi.openPath !== 'function') return unavailableResult('Finder is unavailable');
    const error = await shellApi.openPath(folder.value);
    return error ? resultError('IO', 'Backup destination could not be opened') : { ok: true, value: { opened: true } };
  }

  async function status() {
    return { ok: true, value: { ...makeBackupStatus(configStore.readStatus(), backupRunning, backupMessage || undefined),
      ...(backupRunning && backupProgress ? { progress: backupProgress } : {}) } };
  }

  async function handleInvoke(event, method, payload) {
    try {
      if (!isAllowedTopFrame(event)) return resultError('VALIDATION', 'Requesting frame is not allowed');
      const validation = validateRendererPayload(method, payload);
      if (!validation.ok) return validation;
      const window = getWindowForEvent(event, BrowserWindowApi);
      if (method.startsWith('dictation.')) return await invokeDictation(event, method, payload);
      switch (method) {
        case 'yield.copy': {
          const documents = Object.fromEntries(['starting', 'product'].map(role => [role, {type:'doc', content:[{type:'paragraph', content:[{type:'text', text:payload[role].text, marks:[{type:'yieldMaterial', attrs:{role,id:role,...(payload[role].manual ? {manual:payload[role].manual} : {})}}]}]}]}]));
          const result = calculateMarkedYield(documents);
          if (result.status !== 'valid') return resultError('VALIDATION', result.message);
          if (!clipboardApi || typeof clipboardApi.writeText !== 'function') return unavailableResult('The clipboard is unavailable.');
          clipboardApi.writeText(result.summary);
          return {ok:true, value:{copied:true, summary:result.summary}};
        }
        case 'backups.status': return status();
        case 'backups.configure': return configureBackups(payload, window);
        case 'backups.changeDestination': return configureBackups(undefined, window, true);
        case 'backups.revealDestination': return revealBackupDestination();
        case 'backups.run': return runBackup(payload.jobId, window);
        case 'backups.restore': return runRestore(payload, window);
        case 'attachments.import': return importAttachments(payload, window);
        case 'attachments.preview': return previewAttachment(payload, window);
        case 'exports.write': return writeExport(payload, window);
        case 'attachments.open': {
          const attachment = await runtime.worker.request('attachments.openInfo', { id: payload.id });
          if (!attachment.ok) return attachment;
          const prepared = copyAttachmentForOpen(attachment.value, { appApi, fsApi, root });
          if (!prepared.ok) return prepared;
          if (!shellApi || typeof shellApi.openPath !== 'function') return unavailableResult('Native file opener is unavailable');
          try {
            const openError = await shellApi.openPath(prepared.value);
            if (openError) return resultError('IO', openError);
            return { ok: true, value: { opened: true } };
          } catch { return resultError('IO', 'Attachment could not be opened'); }
        }
        case 'jobs.cancel':
          return runtime.worker.request('jobs.cancel', payload);
        default:
          return runtime.worker.request(method, payload);
      }
    } catch (error) {
      const code = error && typeof error.code === 'string' && ERROR_CODES.has(error.code) ? error.code : 'IO';
      return resultError(code, error && error.message);
    }
  }

  function registerCloseListener(event) {
    if (!isAllowedTopFrame(event)) return;
    if (event.sender && Number.isInteger(event.sender.id)) registeredCloseListeners.add(event.sender.id);
  }

  function receiveCloseResult(event, requestId, ok) {
    if (!isAllowedTopFrame(event) || typeof requestId !== 'string' || typeof ok !== 'boolean') return;
    const waiter = closeWaiters.get(requestId);
    if (!waiter || waiter.webContentsId !== event.sender.id) return;
    waiter.resolve(ok);
  }

  async function closeWindow(event, window) {
    if (shuttingDown || (window && allowedCloseWindows.has(window))) return;
    event.preventDefault();
    const flushed = await requestRendererFlush(window);
    if (!flushed) return;
    runtime.cancelWindowDictation(window?.webContents);
    if (window && typeof window === 'object') allowedCloseWindows.add(window);
    allowWindowClose = true;
    if (BrowserWindowApi && typeof BrowserWindowApi.getAllWindows === 'function') {
      let count = 1;
      try { count = BrowserWindowApi.getAllWindows().length; } catch { /* safe default */ }
      if (count <= 1) await runtime.worker.close(workerCloseTimeoutMs);
    }
    try { window.close(); } catch { /* native close event may already be completing */ }
  }

  async function closeApplication(event) {
    if (shuttingDown) return;
    if (event && typeof event.preventDefault === 'function') event.preventDefault();
    shuttingDown = true;
    let flushed = true;
    let windows = [];
    if (BrowserWindowApi && typeof BrowserWindowApi.getAllWindows === 'function') {
      try { windows = BrowserWindowApi.getAllWindows(); } catch { windows = []; }
    }
    for (const window of windows) {
      if (!(await requestRendererFlush(window))) flushed = false;
    }
    if (!flushed) {
      shuttingDown = false;
      return false;
    }
    allowWindowClose = true;
    speech.dispose(); speechOwners.clear();
    await runtime.worker.close(workerCloseTimeoutMs);
    if (appApi && typeof appApi.quit === 'function') appApi.quit();
    return true;
  }

  function startDailyBackup() {
    if (backupTimer) return;
    const catchUp = async () => {
      const config = configStore.readRaw();
      if (!config.ok || !config.value || !isDailyBackupDue(config.value.lastBackupAt)) return;
      await runBackup(randomJobId(), null, true);
    };
    void catchUp();
    backupTimer = setInterval(() => { void catchUp(); }, DAILY_BACKUP_INTERVAL_MS);
    if (backupTimer && typeof backupTimer.unref === 'function') backupTimer.unref();
  }

  function stopDailyBackup() {
    if (!backupTimer) return;
    clearInterval(backupTimer);
    backupTimer = null;
  }

  function installIPC() {
    if (!ipcMain || typeof ipcMain.handle !== 'function') return false;
    ipcMain.handle(INVOKE_CHANNEL, (event, method, payload) => handleInvoke(event, method, payload));
    if (typeof ipcMain.on === 'function') {
      ipcMain.on(CLOSE_LISTENER_CHANNEL, event => registerCloseListener(event));
      ipcMain.on(CLOSE_RESULT_CHANNEL, (event, requestId, ok) => receiveCloseResult(event, requestId, ok));
    }
    return true;
  }

  runtime.handleInvoke = handleInvoke;
  runtime.requestRendererFlush = requestRendererFlush;
  runtime.closeApplication = closeApplication;
  runtime.closeWindow = closeWindow;
  runtime.registerCloseListener = registerCloseListener;
  runtime.receiveCloseResult = receiveCloseResult;
  runtime.startDailyBackup = startDailyBackup;
  runtime.stopDailyBackup = stopDailyBackup;
  runtime.installIPC = installIPC;
  runtime.status = status;
  runtime.runBackup = runBackup;
  runtime.forwardProgress = forwardProgress;
  return runtime;
}

function createWindow(runtime) {
  if (!BrowserWindow) throw new Error('BrowserWindow is unavailable');
  const window = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 1000,
    minHeight: 700,
    title: 'LabMate',
    backgroundColor: '#f9f1df',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 20, y: 20 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      spellcheck: false,
      partition: 'elb-preview',
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.on('will-attach-webview', event => event.preventDefault());
  window.webContents.on('render-process-gone', () => runtime.cancelWindowDictation(window.webContents));
  window.webContents.on('destroyed', () => runtime.cancelWindowDictation(window.webContents));
  if (typeof window.on === 'function') window.on('close', event => { void runtime.closeWindow(event, window); });
  if (window.webContents) window.webContents.__labmateWindow = window;
  const demoQuery = process.env.LABMATE_DEMO_MODE === '1' ? '?demo=1' : '';
  window.loadURL(`elb://app/index.html${demoQuery}`);
  return window;
}

function installProtocolAndRestrictions() {
  if (!protocol || !session || !app) return;
  const previewSession = session.fromPartition('elb-preview');
  previewSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  previewSession.setPermissionCheckHandler(() => false);
  previewSession.webRequest.onBeforeRequest((details, callback) => {
    callback({ cancel: !isAllowedResourceURL(details.url) });
  });
  previewSession.protocol.handle('elb', request => {
    let url;
    try { url = new URL(request.url); } catch { return new Response('Invalid URL', { status: 400 }); }
    if (url.protocol !== 'elb:' || url.hostname !== 'app' || url.username || url.password || url.port) return new Response('Not found', { status: 404 });
    let relativePath;
    try { relativePath = decodeURIComponent(url.pathname).replace(/^\/+/, ''); }
    catch { return new Response('Invalid path', { status: 400 }); }
    const root = path.resolve(app.getAppPath(), 'dist');
    const filePath = path.resolve(root, relativePath || 'index.html');
    if (filePath !== root && !filePath.startsWith(`${root}${path.sep}`)) return new Response('Not found', { status: 404 });
    return net.fetch(pathToFileURL(filePath).toString());
  });
}

function installMenu() {
  if (!Menu || typeof Menu.setApplicationMenu !== 'function') return;
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'LabMate', submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit' }] },
    { role: 'editMenu' },
    { label: 'View', submenu: [{ role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' }] },
    { role: 'windowMenu' },
  ]));
}

function acquireSingleInstance(appApi = app, BrowserWindowApi = BrowserWindow) {
  if (!appApi || typeof appApi.requestSingleInstanceLock !== 'function') return true;
  let acquired = true;
  try { acquired = appApi.requestSingleInstanceLock(); } catch { acquired = true; }
  if (!acquired) {
    if (typeof appApi.quit === 'function') appApi.quit();
    return false;
  }
  if (typeof appApi.on === 'function') {
    appApi.on('second-instance', () => {
      if (!BrowserWindowApi || typeof BrowserWindowApi.getAllWindows !== 'function') return;
      const windows = BrowserWindowApi.getAllWindows();
      const window = windows[0];
      if (!window) return;
      if (window.isMinimized && window.isMinimized()) window.restore();
      if (typeof window.focus === 'function') window.focus();
    });
  }
  return true;
}

function setupElectron() {
  if (!app || !BrowserWindow) return null;
  // Test profiles are applied before locking the process and before creating
  // LocalConfigStore, so automated runs cannot read live Keychain config or
  // target a real Box folder. A library override without an explicit profile
  // gets an isolated profile beside that disposable library.
  const profileRequested = (typeof process.env.LABMATE_TEST_PROFILE === 'string' && process.env.LABMATE_TEST_PROFILE.trim())
    || (typeof process.env.LABMATE_LIBRARY_ROOT === 'string' && process.env.LABMATE_LIBRARY_ROOT.trim());
  if (profileRequested && !configureTestProfile(app, process.env)) {
    if (typeof app.quit === 'function') app.quit();
    return null;
  }
  if (!acquireSingleInstance(app, BrowserWindow)) return null;
  if (protocol && typeof protocol.registerSchemesAsPrivileged === 'function') {
    protocol.registerSchemesAsPrivileged([
      { scheme: 'elb', privileges: { standard: true, secure: true, supportFetchAPI: true } },
    ]);
  }
  const runtime = createBridgeRuntime({ appApi: app });
  runtime.installIPC();
  app.whenReady().then(() => {
    installProtocolAndRestrictions();
    installMenu();
    runtime.worker.start();
    createWindow(runtime);
    runtime.startDailyBackup();
    app.on('activate', () => {
      if (!BrowserWindow.getAllWindows().length) createWindow(runtime);
    });
  });
  app.on('before-quit', event => { void runtime.closeApplication(event); });
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin' && typeof app.quit === 'function') app.quit();
  });
  return runtime;
}

const runtime = setupElectron();

module.exports = {
  INVOKE_CHANNEL,
  PROGRESS_CHANNEL,
  CLOSE_LISTENER_CHANNEL,
  CLOSE_REQUEST_CHANNEL,
  CLOSE_RESULT_CHANNEL,
  PUBLIC_METHODS,
  JOB_METHODS,
  isPlainObject,
  resultError,
  normalizeResult,
  isAllowedAppURL,
  isAllowedResourceURL,
  isAllowedTopFrame,
  validateRendererPayload,
  detectBoxDrivePaths,
  validateExistingFile,
  validateExistingDirectory,
  validateSaveDestination,
  openCacheDirectory,
  sanitizeAttachmentFilename,
  cleanAttachmentOpenCache,
  copyAttachmentForOpen,
  destinationLabel,
  resolveBackendRoot,
  configureTestProfile,
  LocalConfigStore,
  WorkerClient,
  createBridgeRuntime,
  isDailyBackupDue,
  acquireSingleInstance,
  createWindow,
  installProtocolAndRestrictions,
  setupElectron,
  get runtime() { return runtime; },
};
