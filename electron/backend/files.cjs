'use strict';

/*
 * Attachment ownership and preview service.
 *
 * A selected source path is accepted only at this private main/worker
 * boundary.  After import, the only file identity exposed to the renderer is
 * the UUID in AttachmentRecord.  Bytes live at objects/<sha256>; metadata is
 * owned by LibraryStore.
 */

const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const crypto = require('node:crypto');
const { fork } = require('node:child_process');
const { once } = require('node:events');

const MAX_PDF_BYTES = 200 * 1024 * 1024;
const MAX_SPREADSHEET_BYTES = 25 * 1024 * 1024;
const MAX_DISPLAYED_CELLS = 100_000;
const MAX_IMAGE_PIXELS = 50_000_000;
const MAX_IMAGE_BYTES = 512 * 1024 * 1024;
const MAX_IMAGE_HEADER_BYTES = 8 * 1024 * 1024;
const PARSER_TIMEOUT_MS = 30_000;
const READ_FLAGS = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HASH_RE = /^[0-9a-f]{64}$/;
const STAGING_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.part$/i;

const IMAGE_EXTENSIONS = new Map([
  ['.png', { mime: 'image/png', kind: 'image' }],
  ['.jpg', { mime: 'image/jpeg', kind: 'image' }],
  ['.jpeg', { mime: 'image/jpeg', kind: 'image' }],
]);
const SCIENTIFIC_EXTENSIONS = new Set([
  '.fid', '.jdx', '.dx', '.spc', '.raw', '.mzml', '.cdf', '.abf', '.wiff', '.bruker',
]);

class FileServiceError extends Error {
  constructor(code, message, cause) {
    super(message);
    this.name = 'FileServiceError';
    this.code = code;
    if (cause) this.cause = cause;
  }
}

function fail(code, message, cause) {
  throw new FileServiceError(code, message, cause);
}

function checkCancelled(context) {
  if (context?.signal?.aborted) fail('CANCELLED', 'Attachment operation cancelled.');
}

function report(context, event) {
  try { context?.onProgress?.(event); } catch { /* progress listeners must not break file operations */ }
}

function isWithin(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function safeId(id) {
  if (typeof id !== 'string' || !UUID_RE.test(id)) fail('VALIDATION', 'Attachment IDs must be UUIDs.');
  return id;
}

function safeJobId(jobId) {
  if (typeof jobId !== 'string' || jobId.length < 1 || jobId.length > 200 || jobId.includes('\0')) fail('VALIDATION', 'A valid job ID is required.');
  return jobId;
}

function safeCaption(caption) {
  if (typeof caption !== 'string' || caption.length > 100_000) fail('VALIDATION', 'Attachment captions must be text of at most 100,000 characters.');
  return caption;
}

function normalizeContext(context, fallbackJobId) {
  const value = context && typeof context === 'object' ? context : {};
  return {
    signal: value.signal,
    onProgress: value.onProgress,
    jobId: fallbackJobId || value.jobId || 'attachment-operation',
  };
}

function operationEvent(context, operation, phase, extra = {}) {
  return { jobId: context.jobId, operation, phase, ...extra };
}

function resolveParserPath(baseDirectory = __dirname) {
  const candidate = path.join(baseDirectory, 'parser.cjs');
  const marker = candidate.indexOf('.asar/');
  if (marker < 0) return candidate;
  // child_process.fork cannot execute a script from inside an asar archive.
  // scripts/package.mjs unpacks the backend worker files beside app.asar.
  return `${candidate.slice(0, marker)}.asar.unpacked/${candidate.slice(marker + '.asar/'.length)}`;
}

function resolveParserNodePath(parserPath) {
  const marker = parserPath.indexOf('.asar.unpacked');
  if (marker >= 0) return path.join(`${parserPath.slice(0, marker)}.asar`, 'node_modules');
  return path.join(process.cwd(), 'node_modules');
}

function requireStore(store) {
  if (!store || typeof store.root !== 'string' || typeof store.getAttachment !== 'function' || typeof store.addAttachment !== 'function') {
    fail('VALIDATION', 'A compatible LibraryStore is required.');
  }
  return store;
}

function unwrapStoreValue(value, operation) {
  // Current LibraryStore direct methods return raw values and throw.  Accept
  // the earlier Result envelope as a narrow compatibility shim for isolated
  // test stores and for a store that is still being migrated.
  if (value && typeof value === 'object' && value.ok === true && Object.prototype.hasOwnProperty.call(value, 'value')) return value.value;
  if (value && typeof value === 'object' && value.ok === false && value.error) {
    throw new FileServiceError(value.error.code || 'IO', value.error.message || `${operation} failed.`);
  }
  return value;
}

function lstatOrNull(filePath) {
  try { return fs.lstatSync(filePath); }
  catch (error) { if (error?.code === 'ENOENT') return null; throw error; }
}

function ensureDirectorySync(directory, label) {
  const stat = lstatOrNull(directory);
  if (!stat) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    return;
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) fail('IO', `${label} is not a safe directory.`);
}

function ensureManagedDirectories(root) {
  ensureDirectorySync(root, 'The library root');
  ensureDirectorySync(path.join(root, 'objects'), 'The attachment object directory');
  ensureDirectorySync(path.join(root, 'staging'), 'The attachment staging directory');
}

function removeStaleStagingSync(root) {
  const staging = path.join(root, 'staging');
  const stat = lstatOrNull(staging);
  if (!stat) return;
  if (stat.isSymbolicLink() || !stat.isDirectory()) fail('IO', 'The attachment staging path is not safe.');
  for (const entry of fs.readdirSync(staging, { withFileTypes: true })) {
    if (!STAGING_RE.test(entry.name)) continue;
    const entryPath = path.join(staging, entry.name);
    const entryStat = lstatOrNull(entryPath);
    if (entryStat?.isFile() && !entryStat.isSymbolicLink()) {
      try { fs.unlinkSync(entryPath); } catch (error) { fail('IO', `Stale attachment staging data could not be removed: ${error.message}`, error); }
    }
  }
}

function safeManagedDirectory(root, name) {
  const directory = path.resolve(root, name);
  const rootResolved = path.resolve(root);
  if (!isWithin(rootResolved, directory) || directory === rootResolved) fail('IO', 'Managed attachment path escaped the library root.');
  const stat = lstatOrNull(directory);
  if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) fail('IO', `The managed ${name} directory is unavailable.`);
  return directory;
}

function safeObjectPath(root, hash) {
  if (typeof hash !== 'string' || !HASH_RE.test(hash)) fail('CORRUPT', 'Attachment metadata contains an invalid object hash.');
  const objects = safeManagedDirectory(root, 'objects');
  const objectPath = path.resolve(objects, hash);
  if (!isWithin(objects, objectPath) || objectPath === objects) fail('CORRUPT', 'Attachment object path escaped the managed directory.');
  return objectPath;
}

function validateObjectFile(root, hash, expectedSize) {
  const objectPath = safeObjectPath(root, hash);
  const stat = lstatOrNull(objectPath);
  if (!stat) fail('CORRUPT', 'The managed attachment object is missing.');
  if (stat.isSymbolicLink() || !stat.isFile()) fail('CORRUPT', 'The managed attachment object is not a regular file.');
  if (typeof expectedSize === 'number' && stat.size !== expectedSize) fail('CORRUPT', 'The managed attachment object size does not match its metadata.');
  return { path: objectPath, stat };
}

function classifyFile(name, head) {
  const extension = path.extname(name).toLowerCase();
  if (head.length >= 8 && head.subarray(0, 8).equals(Buffer.from('\x89PNG\r\n\x1a\n', 'binary'))) return { kind: 'image', mime: 'image/png', format: 'image' };
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return { kind: 'image', mime: 'image/jpeg', format: 'image' };
  if (head.length >= 5 && head.subarray(0, 5).toString('ascii') === '%PDF-') return { kind: 'pdf', mime: 'application/pdf', format: 'pdf' };
  if (extension === '.pdf') return { kind: 'pdf', mime: 'application/pdf', format: 'pdf' };
  if (extension === '.csv') return { kind: 'spreadsheet', mime: 'text/csv', format: 'csv' };
  if (extension === '.tsv') return { kind: 'spreadsheet', mime: 'text/tab-separated-values', format: 'tsv' };
  if (extension === '.xlsx') return { kind: 'spreadsheet', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', format: 'xlsx' };
  if (extension === '.xlsm') return { kind: 'file', mime: 'application/vnd.ms-excel.sheet.macroEnabled.12', format: null };
  const image = IMAGE_EXTENSIONS.get(extension);
  if (image) return { ...image, format: 'image' };
  if (SCIENTIFIC_EXTENSIONS.has(extension) || extension === '.fid') return { kind: 'scientific', mime: 'application/octet-stream', format: null };
  return { kind: 'file', mime: 'application/octet-stream', format: null };
}

async function readHead(filePath, size = 512) {
  let handle;
  try {
    handle = await fsp.open(filePath, READ_FLAGS);
    const buffer = Buffer.alloc(size);
    const result = await handle.read(buffer, 0, size, 0);
    return buffer.subarray(0, result.bytesRead);
  } catch (error) {
    fail('IO', `The selected file could not be inspected: ${error.message}`, error);
  } finally {
    await handle?.close().catch(() => {});
  }
}

function validateSourcePath(root, sourcePath) {
  if (typeof sourcePath !== 'string' || !path.isAbsolute(sourcePath) || sourcePath.includes('\0')) fail('VALIDATION', 'Attachment source paths must be absolute native-picker paths.');
  const resolved = path.resolve(sourcePath);
  const rootResolved = path.resolve(root);
  const objectsResolved = path.resolve(rootResolved, 'objects');
  const stagingResolved = path.resolve(rootResolved, 'staging');
  if (isWithin(objectsResolved, resolved) || isWithin(stagingResolved, resolved)) fail('VALIDATION', 'Managed attachment files cannot be imported as new source files.');
  let stat;
  try { stat = fs.lstatSync(resolved); }
  catch (error) { fail(error?.code === 'ENOENT' ? 'NOT_FOUND' : 'IO', `The selected file could not be read: ${error.message}`, error); }
  if (stat.isSymbolicLink()) fail('VALIDATION', 'Symbolic-link source files are not imported. Choose the original file.');
  if (!stat.isFile()) fail('VALIDATION', 'Only regular files can be attached.');
  let realPath;
  try { realPath = fs.realpathSync(resolved); }
  catch (error) { fail('IO', `The selected file path could not be resolved: ${error.message}`, error); }
  if (isWithin(objectsResolved, realPath) || isWithin(stagingResolved, realPath)) fail('VALIDATION', 'Managed attachment files cannot be imported as new source files.');
  return { path: resolved, stat, realPath };
}

function throwForAbort(context) {
  checkCancelled(context);
}

async function copyAndHash(source, destination, context, index, total) {
  let input;
  let output;
  let bytes = 0;
  const hash = crypto.createHash('sha256');
  try {
    input = fs.createReadStream(source.path, { flags: READ_FLAGS });
    output = fs.createWriteStream(destination, { flags: 'wx', mode: 0o600 });
    const finish = once(output, 'finish');
    input.on('error', error => output.destroy(error));
    for await (const chunk of input) {
      throwForAbort(context);
      hash.update(chunk);
      bytes += chunk.length;
      if (!output.write(chunk)) await once(output, 'drain');
      report(context, operationEvent(context, 'attachments.import', 'copy', { completed: bytes, total: source.stat.size, message: `Copying ${path.basename(source.path)} (${index + 1} of ${total}).` }));
    }
    output.end();
    await finish;
    throwForAbort(context);
    const after = fs.statSync(source.path);
    if (after.size !== source.stat.size || after.mtimeMs !== source.stat.mtimeMs) fail('IO', `The source file changed while it was being imported: ${path.basename(source.path)}.`);
    const handle = await fsp.open(destination, 'r+');
    try { await handle.sync(); } finally { await handle.close(); }
    return { hash: hash.digest('hex'), size: bytes };
  } catch (error) {
    input?.destroy();
    output?.destroy();
    throw error instanceof FileServiceError ? error : new FileServiceError('IO', `The selected file could not be copied: ${error.message}`, error);
  }
}

async function removeIfRegular(filePath) {
  try {
    const stat = await fsp.lstat(filePath);
    if (stat.isFile() && !stat.isSymbolicLink()) await fsp.unlink(filePath);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

async function hashFile(filePath, context, expectedSize) {
  const hash = crypto.createHash('sha256');
  let bytes = 0;
  const input = fs.createReadStream(filePath, { flags: READ_FLAGS });
  try {
    for await (const chunk of input) {
      checkCancelled(context);
      hash.update(chunk);
      bytes += chunk.length;
      if (expectedSize !== undefined && bytes > expectedSize) fail('CORRUPT', 'The managed attachment changed while it was being read.');
    }
  } catch (error) {
    if (error instanceof FileServiceError) throw error;
    const code = error?.code === 'ENOENT' ? 'NOT_FOUND' : 'IO';
    throw new FileServiceError(code, `The managed attachment could not be read: ${error.message}`, error);
  } finally {
    input.destroy();
  }
  if (expectedSize !== undefined && bytes !== expectedSize) fail('CORRUPT', 'The managed attachment size does not match its metadata.');
  return hash.digest('hex');
}

async function finalizeObject(root, stagedPath, hash, size, context) {
  const objectPath = safeObjectPath(root, hash);
  const staged = lstatOrNull(stagedPath);
  if (!staged || staged.isSymbolicLink() || !staged.isFile() || staged.size !== size) fail('CORRUPT', 'The staged attachment is missing or unsafe.');
  const existing = lstatOrNull(objectPath);
  if (existing) {
    if (existing.isSymbolicLink() || !existing.isFile()) fail('CORRUPT', 'A managed attachment object path is occupied by an unsafe file.');
    if (existing.size !== size) fail('CORRUPT', 'A managed attachment object hash path contains a different object.');
    const existingHash = await hashFile(objectPath, context, size);
    if (existingHash !== hash) fail('CORRUPT', 'A managed attachment object failed its hash check.');
    await removeIfRegular(stagedPath);
    return objectPath;
  }

  try {
    // A hard link is an atomic create-without-replace on the same filesystem.
    // rename() would silently replace a destination that appeared between the
    // lstat above and the finalize step.
    await fsp.link(stagedPath, objectPath);
    try { await fsp.chmod(objectPath, 0o444); } catch (error) { fail('IO', `The attachment object could not be made immutable: ${error.message}`, error); }
    await removeIfRegular(stagedPath);
    report(context, operationEvent(context, 'attachments.import', 'finalize', { message: `Finalized ${hash}.` }));
    return objectPath;
  } catch (error) {
    if (error?.code !== 'EEXIST') throw new FileServiceError('IO', `The attachment object could not be finalized: ${error.message}`, error);
    const raced = lstatOrNull(objectPath);
    if (!raced || raced.isSymbolicLink() || !raced.isFile() || raced.size !== size) fail('CORRUPT', 'A concurrent attachment object could not be validated.');
    if (await hashFile(objectPath, context, size) !== hash) fail('CORRUPT', 'A concurrent attachment object failed its hash check.');
    await removeIfRegular(stagedPath);
  }
  report(context, operationEvent(context, 'attachments.import', 'finalize', { message: `Finalized ${hash}.` }));
  return objectPath;
}

function getStoreAttachment(store, id) {
  safeId(id);
  let record;
  try { record = unwrapStoreValue(store.getAttachment(id), 'Attachment metadata lookup'); }
  catch (error) {
    if (error instanceof FileServiceError) throw error;
    const code = typeof error?.code === 'string' && /^[A-Z_]+$/.test(error.code) ? error.code : 'IO';
    throw new FileServiceError(code, `Attachment metadata could not be read: ${error.message}`, error);
  }
  if (!record) fail('NOT_FOUND', 'The attachment no longer exists.');
  return record;
}

function getFormat(record) {
  if (record?.kind === 'spreadsheet') {
    const extension = path.extname(record.name || '').toLowerCase();
    const byName = extension === '.csv' ? 'csv' : extension === '.tsv' ? 'tsv' : extension === '.xlsx' ? 'xlsx' : null;
    const byMime = record.mime === 'text/csv' ? 'csv' : record.mime === 'text/tab-separated-values' ? 'tsv' : record.mime === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ? 'xlsx' : null;
    if (byName && byMime && byName !== byMime) return null;
    return byMime || byName;
  }
  return null;
}

function unsupported(record, message) {
  return { kind: 'unsupported', mime: record?.mime, message };
}

function pngDimensions(bytes) {
  if (bytes.length < 24 || !bytes.subarray(0, 8).equals(Buffer.from('\x89PNG\r\n\x1a\n', 'binary'))) return null;
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  if (!width || !height) return null;
  return { mime: 'image/png', width, height };
}

function jpegDimensions(bytes) {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 3 < bytes.length) {
    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
    if (offset >= bytes.length) break;
    const marker = bytes[offset];
    offset += 1;
    if (marker === 0xd9 || marker === 0xda) break;
    if (marker >= 0xd0 && marker <= 0xd7) continue;
    if (offset + 1 >= bytes.length) return null;
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || offset + length > bytes.length) return null;
    const isFrame = (marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) || (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf);
    if (isFrame && length >= 7) {
      const height = bytes.readUInt16BE(offset + 3);
      const width = bytes.readUInt16BE(offset + 5);
      if (!width || !height) return null;
      return { mime: 'image/jpeg', width, height };
    }
    offset += length;
  }
  return null;
}

function imageInfo(bytes) {
  return pngDimensions(bytes) || jpegDimensions(bytes);
}

function pngIsStructurallyValid(bytes) {
  if (bytes.length < 33 || !bytes.subarray(0, 8).equals(Buffer.from('\x89PNG\r\n\x1a\n', 'binary'))) return false;
  let offset = 8;
  let hasHeader = false;
  let hasEnd = false;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const end = offset + 12 + length;
    if (end > bytes.length) return false;
    const type = bytes.subarray(offset + 4, offset + 8).toString('ascii');
    if (type === 'IHDR') {
      if (length !== 13 || hasHeader) return false;
      hasHeader = true;
    } else if (type === 'IEND') {
      if (length !== 0) return false;
      hasEnd = true;
      break;
    }
    offset = end;
  }
  return hasHeader && hasEnd;
}

function jpegIsStructurallyValid(bytes) {
  return bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[bytes.length - 2] === 0xff && bytes[bytes.length - 1] === 0xd9;
}

function imageIsStructurallyValid(bytes) {
  if (bytes.subarray(0, 8).equals(Buffer.from('\x89PNG\r\n\x1a\n', 'binary'))) return pngIsStructurallyValid(bytes);
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return jpegIsStructurallyValid(bytes);
  return false;
}

async function readManagedPrefix(objectPath, size, context) {
  let handle;
  try {
    handle = await fsp.open(objectPath, READ_FLAGS);
    const buffer = Buffer.alloc(size);
    const result = await handle.read(buffer, 0, size, 0);
    checkCancelled(context);
    return buffer.subarray(0, result.bytesRead);
  } catch (error) {
    if (error instanceof FileServiceError) throw error;
    throw new FileServiceError('IO', `The image preview header could not be read: ${error.message}`, error);
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function readManagedBytes(record, objectPath, context, limit) {
  if (record.size > limit) fail('LIMIT', `This preview is limited to ${Math.round(limit / (1024 * 1024))} MiB.`);
  const chunks = [];
  let length = 0;
  const input = fs.createReadStream(objectPath, { flags: READ_FLAGS });
  try {
    for await (const chunk of input) {
      checkCancelled(context);
      length += chunk.length;
      if (length > limit) fail('LIMIT', 'The preview exceeds its safety limit.');
      chunks.push(chunk);
      report(context, operationEvent(context, 'attachments.preview', 'read', { completed: length, total: record.size, message: record.name }));
    }
  } catch (error) {
    if (error instanceof FileServiceError) throw error;
    const code = error?.code === 'ENOENT' ? 'NOT_FOUND' : 'IO';
    throw new FileServiceError(code, `The managed attachment could not be read: ${error.message}`, error);
  } finally {
    input.destroy();
  }
  const bytes = Buffer.concat(chunks, length);
  if (crypto.createHash('sha256').update(bytes).digest('hex') !== record.hash) fail('CORRUPT', 'The managed attachment failed its integrity check.');
  return bytes;
}

function parseResultError(error) {
  const code = error?.code || 'IO';
  const message = error?.message || 'The spreadsheet preview failed.';
  return new FileServiceError(code, message, error);
}

async function runSpreadsheetParser(parserPath, objectPath, format, context) {
  checkCancelled(context);
  const parser = fork(parserPath, [], {
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      NODE_PATH: [resolveParserNodePath(parserPath), process.env.NODE_PATH].filter(Boolean).join(path.delimiter),
    },
  });
  const requestId = crypto.randomUUID();
  let finished = false;
  let timeout;
  let abortListener;
  const promise = new Promise((resolve, reject) => {
    const rejectOnce = error => { if (!finished) { finished = true; reject(error); } };
    parser.once('error', error => rejectOnce(new FileServiceError('IO', `The spreadsheet parser stopped: ${error.message}`, error)));
    parser.once('exit', (code, signal) => {
      if (!finished) rejectOnce(new FileServiceError('IO', `The spreadsheet parser stopped before returning a result (${signal || code || 'unknown'}).`));
    });
    parser.on('message', message => {
      if (!message || message.id !== requestId || finished) return;
      if (message.result?.ok) {
        finished = true;
        resolve(message.result.value);
      } else {
        finished = true;
        reject(parseResultError(message.result?.error));
      }
    });
    abortListener = () => {
      if (finished) return;
      try { parser.send({ id: requestId, method: 'cancel' }); } catch { /* process may have exited */ }
      setTimeout(() => { if (!finished) parser.kill('SIGKILL'); }, 100);
      rejectOnce(new FileServiceError('CANCELLED', 'Preview cancelled.'));
    };
    context.signal?.addEventListener('abort', abortListener, { once: true });
    timeout = setTimeout(() => {
      if (finished) return;
      parser.kill('SIGKILL');
      rejectOnce(new FileServiceError('IO', 'The spreadsheet preview timed out.'));
    }, PARSER_TIMEOUT_MS);
    report(context, operationEvent(context, 'attachments.preview', 'parse', { message: 'Parsing spreadsheet in an isolated process.' }));
    try { parser.send({ id: requestId, method: 'parse', payload: { path: objectPath, format } }); }
    catch (error) { rejectOnce(new FileServiceError('IO', `The spreadsheet parser could not start: ${error.message}`, error)); }
  });
  try {
    const result = await promise;
    if (finished && context.signal?.aborted) fail('CANCELLED', 'Preview cancelled.');
    return result;
  } finally {
    if (!finished) finished = true;
    if (timeout) clearTimeout(timeout);
    if (abortListener) context.signal?.removeEventListener('abort', abortListener);
    if (parser.connected) parser.disconnect();
    if (!parser.killed) parser.kill();
  }
}

function corruptionPreview(record, error) {
  if (error?.code === 'LIMIT') return unsupported(record, error.message);
  if (error?.code === 'UNSUPPORTED') return unsupported(record, error.message);
  if (error?.code === 'CORRUPT') return unsupported(record, `This ${record.kind === 'spreadsheet' ? 'spreadsheet' : 'attachment'} could not be previewed because it appears to be corrupt.`);
  throw error;
}

function createFileService(store) {
  requireStore(store);
  const root = path.resolve(store.root);
  ensureManagedDirectories(root);
  removeStaleStagingSync(root);
  const parserPath = resolveParserPath();

  function getPath(id) {
    const record = getStoreAttachment(store, id);
    return validateObjectFile(root, record.hash, record.size).path;
  }

  async function importFiles(input, context) {
    if (!input || typeof input !== 'object' || !Array.isArray(input.paths) || input.paths.length === 0 || input.paths.length > 100) fail('VALIDATION', 'Choose between one and 100 files to import.');
    safeJobId(input.jobId);
    if (typeof input.runId !== 'string' || !input.runId) fail('VALIDATION', 'A run ID is required to import attachments.');
    const operationContext = normalizeContext(context, input.jobId);
    checkCancelled(operationContext);
    ensureManagedDirectories(root);
    const staged = [];
    const added = [];
    try {
      for (let index = 0; index < input.paths.length; index += 1) {
        checkCancelled(operationContext);
        const source = validateSourcePath(root, input.paths[index]);
        const head = await readHead(source.path);
        const classification = classifyFile(path.basename(source.path), head);
        const stagePath = path.join(root, 'staging', `${crypto.randomUUID()}.part`);
        report(operationContext, operationEvent(operationContext, 'attachments.import', 'stage', { completed: index, total: input.paths.length, message: `Staging ${path.basename(source.path)}.` }));
        const stagedItem = { stagePath, source, classification };
        // Register the stage before copying so cancellation or an I/O error
        // during the copy can remove the partially written file as well.
        staged.push(stagedItem);
        const copied = await copyAndHash(source, stagePath, operationContext, index, input.paths.length);
        Object.assign(stagedItem, copied);
      }

      for (let index = 0; index < staged.length; index += 1) {
        checkCancelled(operationContext);
        const item = staged[index];
        await finalizeObject(root, item.stagePath, item.hash, item.size, operationContext);
        const record = {
          id: crypto.randomUUID(),
          runId: input.runId,
          name: path.basename(item.source.path),
          mime: item.classification.mime,
          size: item.size,
          hash: item.hash,
          caption: '',
          kind: item.classification.kind,
          createdAt: new Date().toISOString(),
        };
        try { unwrapStoreValue(store.addAttachment(record), 'Attachment metadata save'); }
        catch (error) {
          if (error instanceof FileServiceError) throw error;
          const code = typeof error?.code === 'string' && /^[A-Z_]+$/.test(error.code) ? error.code : 'IO';
          throw new FileServiceError(code, `Attachment metadata could not be saved: ${error.message}`, error);
        }
        added.push(record.id);
        report(operationContext, operationEvent(operationContext, 'attachments.import', 'metadata', { completed: index + 1, total: staged.length, message: `Added ${record.name}.` }));
      }
      report(operationContext, operationEvent(operationContext, 'attachments.import', 'complete', { completed: staged.length, total: staged.length, message: 'Attachment import complete.' }));
      return unwrapStoreValue(store.snapshot(), 'Attachment snapshot');
    } catch (error) {
      for (const id of added.reverse()) {
        try { store.removeAttachment?.(id); } catch { /* keep the recovery path safe if a store is closing */ }
      }
      for (const item of staged) {
        try { await removeIfRegular(item.stagePath); } catch { /* stale staging is recovered on next startup */ }
      }
      throw error instanceof FileServiceError ? error : new FileServiceError(error?.code || 'IO', error?.message || 'Attachment import failed.', error);
    }
  }

  async function preview(input, context) {
    if (!input || typeof input !== 'object') fail('VALIDATION', 'Attachment preview input is required.');
    const id = safeId(input.id);
    const jobId = safeJobId(input.jobId);
    const operationContext = normalizeContext(context, jobId);
    checkCancelled(operationContext);
    const record = getStoreAttachment(store, id);
    const object = validateObjectFile(root, record.hash, record.size);
    report(operationContext, operationEvent(operationContext, 'attachments.preview', 'start', { message: record.name }));

    try {
      if (record.kind === 'image') {
        if (record.size > MAX_IMAGE_BYTES) return unsupported(record, 'This image is too large to load safely.');
        // Inspect dimensions from a bounded prefix before allocating the full
        // image byte payload.  A malicious 50+ megapixel image is rejected
        // without being handed to the renderer.
        const prefix = await readManagedPrefix(object.path, Math.min(record.size, MAX_IMAGE_HEADER_BYTES), operationContext);
        const info = imageInfo(prefix);
        if (!info) return unsupported(record, 'This image appears to be corrupt or is not a supported PNG/JPEG image.');
        if (record.mime !== info.mime) return unsupported(record, 'The image MIME type does not match its file signature.');
        if (info.width * info.height > MAX_IMAGE_PIXELS) return unsupported(record, 'Image previews are limited to 50 megapixels.');
        const bytes = await readManagedBytes(record, object.path, operationContext, MAX_IMAGE_BYTES);
        if (!imageIsStructurallyValid(bytes)) return unsupported(record, 'This image appears to be corrupt or is not a supported PNG/JPEG image.');
        return { kind: 'image', mime: info.mime, bytes: new Uint8Array(bytes) };
      }
      if (record.kind === 'pdf') {
        if (record.mime !== 'application/pdf') return unsupported(record, 'The PDF MIME type does not match its attachment metadata.');
        const bytes = await readManagedBytes(record, object.path, operationContext, MAX_PDF_BYTES);
        if (bytes.length < 8 || bytes.subarray(0, 5).toString('ascii') !== '%PDF-') return unsupported(record, 'This PDF appears to be corrupt or is not a PDF document.');
        const tail = bytes.subarray(Math.max(0, bytes.length - 1_000_000)).toString('latin1');
        if (!tail.includes('%%EOF')) return unsupported(record, 'This PDF appears to be incomplete and cannot be previewed.');
        return { kind: 'pdf', mime: 'application/pdf', bytes: new Uint8Array(bytes) };
      }
      const format = getFormat(record);
      if (record.kind === 'spreadsheet' && format) {
        if (record.size > MAX_SPREADSHEET_BYTES) return unsupported(record, 'Spreadsheet previews are limited to 25 MiB.');
        const verifiedHash = await hashFile(object.path, operationContext, record.size);
        if (verifiedHash !== record.hash) return unsupported(record, 'This spreadsheet failed its integrity check and cannot be previewed.');
        const parsed = await runSpreadsheetParser(parserPath, object.path, format, operationContext);
        return { kind: 'spreadsheet', mime: record.mime, sheets: parsed.sheets || [], message: parsed.message };
      }
      return unsupported(record, 'This file format does not have a safe preview yet.');
    } catch (error) {
      return corruptionPreview(record, error);
    }
  }

  function update(input) {
    if (!input || typeof input !== 'object') fail('VALIDATION', 'Attachment update input is required.');
    const id = safeId(input.id);
    const caption = safeCaption(input.caption);
    try { return unwrapStoreValue(store.updateAttachment(id, caption), 'Attachment metadata update'); }
    catch (error) { throw error instanceof FileServiceError ? error : new FileServiceError(error?.code || 'IO', error?.message || 'Attachment metadata could not be updated.', error); }
  }

  function remove(input) {
    if (!input || typeof input !== 'object') fail('VALIDATION', 'Attachment removal input is required.');
    const id = safeId(input.id);
    try { return unwrapStoreValue(store.removeAttachment(id), 'Attachment metadata removal'); }
    catch (error) { throw error instanceof FileServiceError ? error : new FileServiceError(error?.code || 'IO', error?.message || 'Attachment metadata could not be removed.', error); }
  }

  return { importFiles, preview, getPath, update, remove };
}

module.exports = {
  MAX_PDF_BYTES,
  MAX_SPREADSHEET_BYTES,
  MAX_DISPLAYED_CELLS,
  MAX_IMAGE_PIXELS,
  FileServiceError,
  resolveParserPath,
  resolveParserNodePath,
  createFileService,
};
