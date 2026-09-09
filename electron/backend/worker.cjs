/*
 * LabMate's utility-process entry point.
 *
 * The worker owns the database/services, but it does not own renderer trust.
 * Main validates the public payload and adds the few internal values (native
 * paths and decrypted credentials) that a service needs.  The same strict
 * validation is repeated here because a utility process is a separate trust
 * boundary and messages are not implicitly trusted merely because they came
 * from main.
 */

'use strict';

const path = require('node:path');

// zod is a required runtime dependency.  Failing at startup when packaging
// omits it is safer than silently weakening the worker trust boundary.
const z = require('zod');

const SECTION_IDS = Object.freeze(['information', 'method', 'notes', 'data']);
const STATUS_VALUES = Object.freeze(['todo', 'progress', 'complete']);
const COLOR_VALUES = Object.freeze(['sage', 'blue', 'clay']);
const FORMAT_VALUES = Object.freeze(['txt', 'md', 'html', 'rtf', 'docx']);
const SCOPE_VALUES = Object.freeze(['entry', 'selected', 'notebook']);
const ERROR_CODES = Object.freeze(new Set([
  'VALIDATION', 'NOT_FOUND', 'STALE_REVISION', 'IO', 'CANCELLED',
  'UNAVAILABLE', 'CORRUPT_BACKUP',
]));

const WORKER_METHODS = Object.freeze(new Set([
  'records.snapshot',
  'records.createNotebook',
  'records.updateNotebook',
  'records.createExperiment',
  'records.updateExperiment',
  'records.repeatRun',
  'records.updateRun',
  'documents.save',
  'schemes.create',
  'schemes.update',
  'schemes.remove',
  'preferences.update',
  'trash.move',
  'trash.restore',
  'trash.purge',
  'attachments.import',
  'attachments.preview',
  'attachments.path',
  'attachments.openInfo',
  'attachments.update',
  'attachments.remove',
  'exports.write',
  'backups.run',
  'backups.restore',
  'jobs.cancel',
  '__shutdown',
]));

const JOB_METHODS = Object.freeze(new Set([
  'attachments.import',
  'attachments.preview',
  'exports.write',
  'backups.run',
  'backups.restore',
]));

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value, required, optional = []) {
  if (!isPlainObject(value)) return false;
  const allowed = new Set([...required, ...optional]);
  const keys = Object.keys(value);
  return required.every(key => Object.prototype.hasOwnProperty.call(value, key))
    && keys.every(key => allowed.has(key));
}

function isString(value, { min = 0, max = 4096, pattern } = {}) {
  return typeof value === 'string'
    && value.length >= min
    && value.length <= max
    && (!pattern || pattern.test(value));
}

function isSafeIdentifier(value) {
  return isString(value, { min: 1, max: 128, pattern: /^[A-Za-z0-9._:-]+$/ });
}

function isUUID(value) {
  return isString(value, {
    min: 36,
    max: 36,
    pattern: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  });
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function isInteger(value, { min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER } = {}) {
  return Number.isInteger(value) && value >= min && value <= max;
}

function isDate(value) {
  if (!isString(value, { min: 10, max: 10, pattern: /^\d{4}-\d{2}-\d{2}$/ })) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function isStringArray(value, { min = 0, max = 10000, unique = false, item = isString } = {}) {
  if (!Array.isArray(value) || value.length < min || value.length > max || !value.every(item)) return false;
  return !unique || new Set(value).size === value.length;
}

function isJSONValue(value, depth = 0) {
  if (depth > 20) return false;
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.length <= 1000 && value.every(item => isJSONValue(item, depth + 1));
  if (!isPlainObject(value)) return false;
  return Object.keys(value).length <= 1000
    && Object.values(value).every(item => isJSONValue(item, depth + 1));
}

function isDocNode(value, depth = 0) {
  if (!isPlainObject(value) || depth > 100) return false;
  const keys = Object.keys(value);
  if (!keys.every(key => ['type', 'text', 'attrs', 'marks', 'content'].includes(key))) return false;
  if (!isString(value.type, { min: 1, max: 128 })) return false;
  if (value.text !== undefined && !isString(value.text, { max: 1_000_000 })) return false;
  if (value.attrs !== undefined && (!isPlainObject(value.attrs) || !isJSONValue(value.attrs))) return false;
  if (value.marks !== undefined) {
    if (!Array.isArray(value.marks) || value.marks.length > 100) return false;
    if (!value.marks.every(mark => isPlainObject(mark)
      && hasExactKeys(mark, ['type'], ['attrs'])
      && isString(mark.type, { min: 1, max: 128 })
      && (mark.attrs === undefined || (isPlainObject(mark.attrs) && isJSONValue(mark.attrs))))) return false;
  }
  if (value.content !== undefined) {
    if (!Array.isArray(value.content) || value.content.length > 10000) return false;
    if (!value.content.every(child => isDocNode(child, depth + 1))) return false;
  }
  return true;
}

function isSectionDocuments(value) {
  return hasExactKeys(value, SECTION_IDS)
    && SECTION_IDS.every(section => isDocNode(value[section]));
}

function isJobId(value) {
  // Public callers may use a UUID or a short opaque ID generated by a test
  // harness.  Main still guarantees uniqueness before dispatching it.
  return isSafeIdentifier(value);
}

function payloadShapeError(method, payload, internal = true) {
  const fail = message => message;
  switch (method) {
    case 'records.snapshot':
      return payload === undefined ? null : fail('records.snapshot takes no payload');
    case 'records.createNotebook':
      return hasExactKeys(payload, ['name', 'description', 'discipline', 'color'])
        && isString(payload.name, { min: 1, max: 300 })
        && isString(payload.description, { max: 20_000 })
        && isString(payload.discipline, { max: 300 })
        && COLOR_VALUES.includes(payload.color)
        ? null : fail('Invalid createNotebook payload');
    case 'records.updateNotebook':
      return hasExactKeys(payload, ['id', 'expectedRevision', 'changes'])
        && isUUID(payload.id)
        && isInteger(payload.expectedRevision, { min: 0 })
        && isPlainObject(payload.changes)
        && Object.keys(payload.changes).length > 0
        && Object.keys(payload.changes).every(key => ['name', 'description', 'discipline', 'color'].includes(key))
        && (payload.changes.name === undefined || isString(payload.changes.name, { min: 1, max: 300 }))
        && (payload.changes.description === undefined || isString(payload.changes.description, { max: 20_000 }))
        && (payload.changes.discipline === undefined || isString(payload.changes.discipline, { max: 300 }))
        && (payload.changes.color === undefined || COLOR_VALUES.includes(payload.changes.color))
        ? null : fail('Invalid updateNotebook payload');
    case 'records.createExperiment':
      return hasExactKeys(payload, ['notebookId', 'label', 'title', 'date', 'author'])
        && isUUID(payload.notebookId)
        && isString(payload.label, { min: 1, max: 300 })
        && isString(payload.title, { min: 1, max: 1000 })
        && isDate(payload.date)
        && isString(payload.author, { min: 1, max: 300 })
        ? null : fail('Invalid createExperiment payload');
    case 'records.updateExperiment':
      return hasExactKeys(payload, ['id', 'expectedRevision', 'label'])
        && isUUID(payload.id)
        && isInteger(payload.expectedRevision, { min: 0 })
        && isString(payload.label, { min: 1, max: 300 })
        ? null : fail('Invalid updateExperiment payload');
    case 'records.repeatRun':
      return hasExactKeys(payload, ['runId', 'date'])
        && isUUID(payload.runId)
        && isDate(payload.date)
        ? null : fail('Invalid repeatRun payload');
    case 'records.updateRun':
      return hasExactKeys(payload, ['id', 'expectedRevision', 'changes'])
        && isUUID(payload.id)
        && isInteger(payload.expectedRevision, { min: 0 })
        && isPlainObject(payload.changes)
        && Object.keys(payload.changes).length > 0
        && Object.keys(payload.changes).every(key => ['title', 'date', 'author', 'status'].includes(key))
        && (payload.changes.title === undefined || isString(payload.changes.title, { min: 1, max: 1000 }))
        && (payload.changes.date === undefined || isDate(payload.changes.date))
        && (payload.changes.author === undefined || isString(payload.changes.author, { min: 1, max: 300 }))
        && (payload.changes.status === undefined || STATUS_VALUES.includes(payload.changes.status))
        ? null : fail('Invalid updateRun payload');
    case 'documents.save':
      return hasExactKeys(payload, ['runId', 'expectedRevision', 'documents'])
        && isUUID(payload.runId)
        && isInteger(payload.expectedRevision, { min: 0 })
        && isSectionDocuments(payload.documents)
        ? null : fail('Invalid documents.save payload');
    case 'schemes.create':
      return hasExactKeys(payload, ['notebookId', 'name', 'description'], ['runIds'])
        && isUUID(payload.notebookId)
        && isString(payload.name, { min: 1, max: 300 })
        && isString(payload.description, { max: 20_000 })
        && (payload.runIds === undefined || isStringArray(payload.runIds, { unique: true, item: isUUID }))
        ? null : fail('Invalid schemes.create payload');
    case 'schemes.update':
      return hasExactKeys(payload, ['id', 'expectedRevision'], ['name', 'description', 'runIds'])
        && isUUID(payload.id)
        && isInteger(payload.expectedRevision, { min: 0 })
        && (payload.name === undefined || isString(payload.name, { min: 1, max: 300 }))
        && (payload.description === undefined || isString(payload.description, { max: 20_000 }))
        && (payload.runIds === undefined || isStringArray(payload.runIds, { unique: true, item: isUUID }))
        && (payload.name !== undefined || payload.description !== undefined || payload.runIds !== undefined)
        ? null : fail('Invalid schemes.update payload');
    case 'schemes.remove':
      return hasExactKeys(payload, ['id', 'expectedRevision'])
        && isUUID(payload.id)
        && isInteger(payload.expectedRevision, { min: 0 })
        ? null : fail('Invalid schemes.remove payload');
    case 'preferences.update':
      return isPlainObject(payload)
        && Object.keys(payload).length > 0
        && Object.keys(payload).every(key => ['appearance', 'palette', 'layout', 'directoryView', 'sort'].includes(key))
        && (payload.appearance === undefined || isInteger(payload.appearance, { min: 0, max: 100 }))
        && (payload.palette === undefined || ['sage', 'ocean', 'lavender', 'terracotta', 'rose', 'graphite'].includes(payload.palette))
        && (payload.layout === undefined || ['continuous', 'tabs'].includes(payload.layout))
        && (payload.directoryView === undefined || ['grid', 'list'].includes(payload.directoryView))
        && (payload.sort === undefined || isString(payload.sort, { min: 1, max: 128 }))
        ? null : fail('Invalid preferences.update payload');
    case 'trash.move':
    case 'trash.restore':
    case 'trash.purge':
      return hasExactKeys(payload, ['kind', 'id', 'expectedRevision'])
        && ['notebook', 'experiment', 'run'].includes(payload.kind)
        && isUUID(payload.id)
        && isInteger(payload.expectedRevision, { min: 0 })
        ? null : fail(`Invalid ${method} payload`);
    case 'attachments.import':
      return hasExactKeys(payload, internal ? ['runId', 'paths', 'jobId'] : ['runId', 'jobId'])
        && isUUID(payload.runId)
        && isJobId(payload.jobId)
        && (!internal || (isStringArray(payload.paths, { min: 1, max: 256, item: value => isString(value, { min: 1, max: 4096 }) }) && payload.paths.every(pathValue => path.isAbsolute(pathValue))))
        ? null : fail('Invalid attachments.import payload');
    case 'attachments.preview':
      return hasExactKeys(payload, ['id', 'jobId'])
        && isUUID(payload.id)
        && isJobId(payload.jobId)
        ? null : fail('Invalid attachments.preview payload');
    case 'attachments.path':
      return hasExactKeys(payload, ['id']) && isUUID(payload.id)
        ? null : fail('Invalid attachments.path payload');
    case 'attachments.openInfo':
      return hasExactKeys(payload, ['id']) && isUUID(payload.id)
        ? null : fail('Invalid attachments.openInfo payload');
    case 'attachments.update':
      return hasExactKeys(payload, ['id', 'caption'])
        && isUUID(payload.id)
        && isString(payload.caption, { max: 20_000 })
        ? null : fail('Invalid attachments.update payload');
    case 'attachments.remove':
      return hasExactKeys(payload, ['id']) && isUUID(payload.id)
        ? null : fail('Invalid attachments.remove payload');
    case 'exports.write': {
      const required = ['scope', 'notebookId', 'runIds', 'format', 'order', 'sections', 'data', 'jobId'];
      const keys = internal ? [...required, 'destination'] : required;
      const error = hasExactKeys(payload, keys, ['schemeId'])
        && SCOPE_VALUES.includes(payload.scope)
        && isUUID(payload.notebookId)
        && isStringArray(payload.runIds, { max: 10_000, item: isUUID })
        && FORMAT_VALUES.includes(payload.format)
        && isString(payload.order, { min: 1, max: 128 })
        && isStringArray(payload.sections, { max: SECTION_IDS.length, unique: true, item: value => SECTION_IDS.includes(value) })
        && payload.sections.length > 0
        && ['none', 'captions', 'previews'].includes(payload.data)
        && isJobId(payload.jobId)
        && (!internal || (isString(payload.destination, { min: 1, max: 4096 }) && path.isAbsolute(payload.destination)))
        ? null : fail('Invalid exports.write payload');
      if (error) return error;
      if (payload.schemeId !== undefined && !isUUID(payload.schemeId)) return fail('Invalid exports.write schemeId');
      return null;
    }
    case 'backups.run':
      return hasExactKeys(payload, internal ? ['jobId', 'password', 'destination'] : ['jobId'])
        && isJobId(payload.jobId)
        && (!internal || (isString(payload.password, { min: 1, max: 4096 })
          && isString(payload.destination, { min: 1, max: 4096 })
          && path.isAbsolute(payload.destination)))
        ? null : fail('Invalid backups.run payload');
    case 'backups.restore':
      return hasExactKeys(payload, internal ? ['password', 'source', 'jobId'] : ['password', 'jobId'])
        && isString(payload.password, { min: 1, max: 4096 })
        && isJobId(payload.jobId)
        && (!internal || (isString(payload.source, { min: 1, max: 4096 }) && path.isAbsolute(payload.source)))
        ? null : fail('Invalid backups.restore payload');
    case 'jobs.cancel':
      return hasExactKeys(payload, ['jobId']) && isJobId(payload.jobId)
        ? null : fail('Invalid jobs.cancel payload');
    case '__shutdown':
      return payload === undefined ? null : fail('__shutdown takes no payload');
    default:
      return fail('Unknown worker method');
  }
}

/*
 * Use zod as the outer parser with the shape predicate as the single source
 * of truth shared by main and worker. This means a future schema edit cannot
 * accidentally make the two trust boundaries disagree about unknown keys or
 * internal path fields.
 */
function validatePayload(method, payload, { internal = true } = {}) {
  if (!WORKER_METHODS.has(method)) return { ok: false, error: { code: 'VALIDATION', message: 'Unknown worker method' } };
  const shapeError = payloadShapeError(method, payload, internal);
  const schema = z.unknown().superRefine((_value, context) => {
    if (shapeError) context.addIssue({ code: z.ZodIssueCode.custom, message: shapeError });
  });
  const parsed = schema.safeParse(payload);
  if (!parsed.success) return { ok: false, error: { code: 'VALIDATION', message: shapeError || 'Invalid worker payload' } };
  if (shapeError) return { ok: false, error: { code: 'VALIDATION', message: shapeError } };
  return { ok: true, value: payload };
}

function validateMessage(message) {
  if (!isPlainObject(message) || !hasExactKeys(message, ['id', 'method', 'payload'])) {
    return { ok: false, error: { code: 'VALIDATION', message: 'Malformed worker message' } };
  }
  if (!isSafeIdentifier(message.id) || !WORKER_METHODS.has(message.method)) {
    return { ok: false, error: { code: 'VALIDATION', message: 'Malformed worker message' } };
  }
  return { ok: true, value: message };
}

function cancelledError() {
  const error = new Error('Operation cancelled');
  error.code = 'CANCELLED';
  return error;
}

function resultError(code, message) {
  return { ok: false, error: { code: ERROR_CODES.has(code) ? code : 'IO', message: String(message || 'Backend operation failed').slice(0, 500) } };
}

function normalizeResult(value) {
  if (value && typeof value === 'object' && value.ok === true) return { ok: true, value: value.value };
  if (value && typeof value === 'object' && value.ok === false && value.error && typeof value.error === 'object') {
    return resultError(value.error.code, value.error.message);
  }
  return { ok: true, value };
}

function errorToResult(error) {
  if (error && typeof error === 'object' && error.ok === false) return normalizeResult(error);
  const code = error && typeof error.code === 'string' ? error.code : (error && error.name === 'AbortError' ? 'CANCELLED' : 'IO');
  return resultError(code, code === 'CANCELLED' ? 'Operation cancelled' : (error && error.message));
}

function getParentPort() {
  if (process && process.parentPort && typeof process.parentPort.postMessage === 'function') return process.parentPort;
  try {
    const workerThreads = require('node:worker_threads');
    if (workerThreads.parentPort) return workerThreads.parentPort;
  } catch {
    // Plain Node source tests do not need a transport.
  }
  return null;
}

function defaultRoot(argv = process.argv, env = process.env) {
  const explicit = argv.slice(2).find(argument => typeof argument === 'string' && argument.startsWith('--root='));
  const fromArgs = explicit ? explicit.slice('--root='.length) : argv[2];
  const candidate = fromArgs || env.LABMATE_LIBRARY_ROOT || path.join(process.cwd(), 'LabMate');
  return path.resolve(candidate);
}

function loadServices(root, options = {}) {
  if (options.services) return options.services;
  const requireFn = options.requireFn || require;
  try {
    const { LibraryStore } = requireFn('./store.cjs');
    const { createBackupService } = requireFn('./backup.cjs');
    const { createFileService } = requireFn('./files.cjs');
    const { createExportService } = requireFn('./exports.cjs');
    const store = new LibraryStore(root);
    const fileService = createFileService(store);
    return {
      store,
      fileService,
      backupService: createBackupService(store),
      exportService: createExportService(store, fileService),
    };
  } catch (error) {
    const unavailable = new Error('Backend services are unavailable');
    unavailable.code = 'UNAVAILABLE';
    unavailable.cause = error;
    throw unavailable;
  }
}

function serviceMethod(services, method, payload, context) {
  if (method === 'records.snapshot') return services.store.snapshot();
  if (method.startsWith('records.') || method === 'documents.save' || method.startsWith('schemes.')
    || method === 'preferences.update' || method.startsWith('trash.')) {
    return services.store.dispatch(method, payload);
  }
  if (method === 'attachments.import') return services.fileService.importFiles(payload, context);
  if (method === 'attachments.preview') return services.fileService.preview(payload, context);
  if (method === 'attachments.path') return services.fileService.getPath(payload.id);
  if (method === 'attachments.openInfo') {
    const record = services.store.getAttachment(payload.id);
    const managedPath = services.fileService.getPath(payload.id);
    return { path: managedPath, name: record.name, mime: record.mime };
  }
  if (method === 'attachments.update') return services.fileService.update(payload);
  if (method === 'attachments.remove') return services.fileService.remove(payload);
  if (method === 'exports.write') return services.exportService.write(payload, context);
  if (method === 'backups.run') return services.backupService.create(payload, context);
  if (method === 'backups.restore') return services.backupService.restore(payload, context);
  throw Object.assign(new Error('Unknown worker method'), { code: 'VALIDATION' });
}

function createWorkerRuntime(options = {}) {
  const transport = options.parentPort || getParentPort();
  const root = path.resolve(options.root || defaultRoot(options.argv, options.env));
  let services = options.services || null;
  let serviceError = null;
  let closed = false;
  let queue = Promise.resolve();
  const activeJobs = new Map();
  const queuedJobs = new Set();
  const cancelledJobs = new Set();
  const knownJobs = new Set();
  const replies = new Map();

  const send = value => {
    if (transport && typeof transport.postMessage === 'function') {
      try { transport.postMessage(value); } catch { /* utility process is closing */ }
    }
  };

  const sendReply = (id, result) => {
    if (typeof id === 'string') send({ id, result: normalizeResult(result) });
  };

  const ensureServices = () => {
    if (services) return services;
    if (serviceError) throw serviceError;
    try {
      services = loadServices(root, options);
      return services;
    } catch (error) {
      serviceError = error;
      throw error;
    }
  };

  const closeServices = async () => {
    if (!services || !services.store || typeof services.store.close !== 'function') return;
    await services.store.close();
  };

  const execute = async (message, validation) => {
    if (closed && message.method !== '__shutdown') return resultError('UNAVAILABLE', 'Backend worker is closed');
    const payload = message.payload;
    const jobId = JOB_METHODS.has(message.method) ? payload.jobId : null;
    if (jobId) queuedJobs.delete(jobId);
    if (jobId && cancelledJobs.has(jobId)) {
      cancelledJobs.delete(jobId);
      knownJobs.delete(jobId);
      return resultError('CANCELLED', 'Operation cancelled');
    }

    if (message.method === '__shutdown') {
      closed = true;
      await closeServices();
      return { ok: true, value: { closed: true } };
    }

    const controller = jobId ? new AbortController() : null;
    if (jobId) activeJobs.set(jobId, controller);
    const context = controller ? {
      signal: controller.signal,
      onProgress: event => {
        if (controller.signal.aborted) throw cancelledError();
        if (!event || typeof event !== 'object') return;
        send({ event: 'progress', value: {
          jobId,
          operation: message.method,
          phase: typeof event.phase === 'string' ? event.phase : 'working',
          ...(Number.isFinite(event.completed) ? { completed: event.completed } : {}),
          ...(Number.isFinite(event.total) ? { total: event.total } : {}),
          ...(typeof event.message === 'string' ? { message: event.message.slice(0, 500) } : {}),
        } });
      },
    } : { signal: new AbortController().signal };

    try {
      if (controller && controller.signal.aborted) throw cancelledError();
      const result = await serviceMethod(ensureServices(), message.method, payload, context);
      if (controller && controller.signal.aborted) throw cancelledError();
      return normalizeResult(result);
    } catch (error) {
      return errorToResult(error);
    } finally {
      if (jobId) activeJobs.delete(jobId);
      if (jobId) knownJobs.delete(jobId);
    }
  };

  const cancel = message => {
    const payloadCheck = validatePayload('jobs.cancel', message.payload, { internal: false });
    if (!payloadCheck.ok) return payloadCheck;
    const jobId = message.payload.jobId;
    const active = activeJobs.get(jobId);
    if (active) {
      active.abort();
      return { ok: true, value: { cancelled: true } };
    }
    if (queuedJobs.has(jobId)) {
      cancelledJobs.add(jobId);
      return { ok: true, value: { cancelled: true } };
    }
    return { ok: true, value: { cancelled: false } };
  };

  const receive = incoming => {
    // Electron utility processes deliver a MessageEvent (`event.data`), while
    // worker_threads and the tiny test transports deliver the raw object.
    const message = incoming
      && (typeof incoming === 'object' || typeof incoming === 'function')
      && 'data' in incoming
      && !('id' in incoming)
      ? incoming.data
      : incoming;
    const messageCheck = validateMessage(message);
    if (!messageCheck.ok) {
      if (message && typeof message.id === 'string') sendReply(message.id, messageCheck);
      return;
    }
    if (message.method === 'jobs.cancel') {
      sendReply(message.id, cancel(message));
      return;
    }
    const payloadCheck = validatePayload(message.method, message.payload, { internal: true });
    if (!payloadCheck.ok) {
      sendReply(message.id, payloadCheck);
      return;
    }

    const jobId = JOB_METHODS.has(message.method) ? message.payload.jobId : null;
    if (jobId) {
      if (knownJobs.has(jobId)) {
        sendReply(message.id, resultError('VALIDATION', 'Job ID is already in use'));
        return;
      }
      knownJobs.add(jobId);
      queuedJobs.add(jobId);
    }
    const task = queue.then(async () => {
      const result = await execute(message, payloadCheck);
      sendReply(message.id, result);
      replies.delete(message.id);
      return result;
    }, async () => {
      const result = await execute(message, payloadCheck);
      sendReply(message.id, result);
      replies.delete(message.id);
      return result;
    });
    // A failed task must not permanently poison the serial queue.  The reply
    // itself is sent by the task, so no mutation is replayed after a worker
    // restart.
    queue = task.catch(() => undefined);
    replies.set(message.id, task);
  };

  if (transport && typeof transport.on === 'function') transport.on('message', receive);

  return {
    root,
    receive,
    send,
    ensureServices,
    close: closeServices,
    activeJobs,
    queuedJobs,
    cancelledJobs,
    knownJobs,
    get services() { return services; },
    get serviceError() { return serviceError; },
    get closed() { return closed; },
    waitForIdle: () => queue,
  };
}

const runtime = getParentPort() ? createWorkerRuntime() : null;

module.exports = {
  SECTION_IDS,
  WORKER_METHODS,
  JOB_METHODS,
  isPlainObject,
  hasExactKeys,
  isUUID,
  isDate,
  payloadShapeError,
  validatePayload,
  validateMessage,
  normalizeResult,
  errorToResult,
  defaultRoot,
  loadServices,
  createWorkerRuntime,
  get runtime() { return runtime; },
};
