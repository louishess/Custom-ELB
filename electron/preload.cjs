/*
 * The preload is deliberately boring.  It is the only object the renderer
 * receives from the desktop process, and every callable method has a matching
 * entry in shared/contracts.ts.  Do not add a generic ipcRenderer or file
 * system escape hatch here.
 */

let contextBridge;
let ipcRenderer;
try {
  ({ contextBridge, ipcRenderer } = require('electron'));
} catch {
  // Keeping the module require-able in a plain Node test is useful for the
  // pure allowlist helpers below.  Electron itself always supplies both.
}

const INVOKE_CHANNEL = 'labmate:invoke';
const PROGRESS_CHANNEL = 'labmate:progress';
const DICTATION_CHANNEL = 'labmate:dictation';
const CLOSE_LISTENER_CHANNEL = 'labmate:close-listener-registered';
const CLOSE_REQUEST_CHANNEL = 'labmate:before-close';
const CLOSE_RESULT_CHANNEL = 'labmate:before-close-result';

const NAMESPACE_METHODS = Object.freeze({
  records: Object.freeze(['snapshot', 'createNotebook', 'updateNotebook', 'createExperiment', 'updateExperiment', 'repeatRun', 'updateRun']),
  documents: Object.freeze(['save']),
  schemes: Object.freeze(['create', 'update', 'remove']),
  preferences: Object.freeze(['update']),
  trash: Object.freeze(['move', 'restore', 'purge']),
  attachments: Object.freeze(['import', 'preview', 'open', 'update', 'remove']),
  exports: Object.freeze(['write']),
  backups: Object.freeze(['status', 'configure', 'changeDestination', 'revealDestination', 'run', 'restore']),
  jobs: Object.freeze(['cancel']),
  dictation: Object.freeze(['capabilities', 'prepare', 'start', 'stop', 'cancel']),
});

const ALLOWED_METHODS = new Set(
  Object.entries(NAMESPACE_METHODS).flatMap(([namespace, methods]) => methods.map(method => `${namespace}.${method}`)),
);

function isAllowedMethod(method) {
  return typeof method === 'string' && ALLOWED_METHODS.has(method);
}

function isJobEvent(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return typeof value.jobId === 'string'
    && typeof value.operation === 'string'
    && typeof value.phase === 'string'
    && (value.completed === undefined || Number.isFinite(value.completed))
    && (value.total === undefined || Number.isFinite(value.total))
    && (value.message === undefined || typeof value.message === 'string');
}

function cloneJobEvent(value) {
  if (!isJobEvent(value)) return null;
  const event = { jobId: value.jobId, operation: value.operation, phase: value.phase };
  if (value.completed !== undefined) event.completed = value.completed;
  if (value.total !== undefined) event.total = value.total;
  if (value.message !== undefined) event.message = value.message;
  return Object.freeze(event);
}

function unavailableResult(error) {
  const message = error instanceof Error && error.message ? error.message : 'Desktop bridge unavailable';
  return { ok: false, error: { code: 'UNAVAILABLE', message } };
}

function exposeBridge() {
  if (!contextBridge || !ipcRenderer) return false;

  const progressListeners = new Set();
  const closeListeners = new Set();
  const dictationListeners = new Set();
  let closeListenerRegistered = false;

  ipcRenderer.on(PROGRESS_CHANNEL, (_event, value) => {
    const event = cloneJobEvent(value);
    if (!event) return;
    for (const listener of [...progressListeners]) {
      try { listener(event); } catch { /* one renderer listener cannot break the bridge */ }
    }
  });

  ipcRenderer.on(DICTATION_CHANNEL, (_event, value) => {
    if (!value || typeof value.sessionId !== 'string' || !['preparing', 'ready', 'recording', 'stopped', 'cancelled', 'error'].includes(value.state)) return;
    const event = {sessionId: value.sessionId, state: value.state};
    if (typeof value.transcript === 'string') event.transcript = value.transcript;
    if (typeof value.final === 'boolean') event.final = value.final;
    if (typeof value.message === 'string') event.message = value.message;
    Object.freeze(event);
    for (const listener of [...dictationListeners]) { try { listener(event); } catch { /* isolated listener */ } }
  });
  ipcRenderer.on(CLOSE_REQUEST_CHANNEL, (_event, requestId) => {
    if (typeof requestId !== 'string' || requestId.length === 0 || requestId.length > 128) return;
    void (async () => {
      let ok = true;
      for (const listener of [...closeListeners]) {
        try {
          if (!(await listener())) ok = false;
        } catch {
          ok = false;
        }
      }
      try { ipcRenderer.send(CLOSE_RESULT_CHANNEL, requestId, ok); } catch { /* closing renderer */ }
    })();
  });

  const api = {};
  for (const [namespace, methods] of Object.entries(NAMESPACE_METHODS)) {
    const namespaceApi = {};
    for (const method of methods) {
      const qualified = `${namespace}.${method}`;
      namespaceApi[method] = (input) => {
        if (!isAllowedMethod(qualified)) return Promise.resolve(unavailableResult());
        return ipcRenderer.invoke(INVOKE_CHANNEL, qualified, input).catch(unavailableResult);
      };
    }
    api[namespace] = Object.freeze(namespaceApi);
  }

  api.onProgress = (listener) => {
    if (typeof listener !== 'function') return () => {};
    progressListeners.add(listener);
    return () => { progressListeners.delete(listener); };
  };

  api.onDictation = listener => {
    if (typeof listener !== 'function') return () => {};
    dictationListeners.add(listener);
    return () => dictationListeners.delete(listener);
  };
  api.onBeforeClose = (listener) => {
    if (typeof listener !== 'function') return () => {};
    closeListeners.add(listener);
    if (!closeListenerRegistered) {
      closeListenerRegistered = true;
      try { ipcRenderer.send(CLOSE_LISTENER_CHANNEL); } catch { /* the window is already closing */ }
    }
    return () => { closeListeners.delete(listener); };
  };

  contextBridge.exposeInMainWorld('labmate', Object.freeze(api));
  return true;
}

exposeBridge();

module.exports = {
  INVOKE_CHANNEL,
  PROGRESS_CHANNEL,
  CLOSE_LISTENER_CHANNEL,
  CLOSE_REQUEST_CHANNEL,
  CLOSE_RESULT_CHANNEL,
  NAMESPACE_METHODS,
  ALLOWED_METHODS,
  isAllowedMethod,
  isJobEvent,
  cloneJobEvent,
  exposeBridge,
};
