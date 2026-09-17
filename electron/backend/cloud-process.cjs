'use strict';
const path = require('node:path');
const fs = require('node:fs').promises;
const os = require('node:os');
const { fork } = require('node:child_process');

const DELIVERY_TIMEOUT_MS = 120_000;
const PROBE_TIMEOUT_MS = 3_000;

// Provider I/O has its own process and filesystem thread pool. This process
// never receives credentials or permission to change the local catalog/library.
function runCloudProcess(payload, { signal, onProgress, timeoutMs = DELIVERY_TIMEOUT_MS, forkProcess = fork } = {}) {
  return new Promise((resolve, reject) => {
    let filename = path.join(__dirname, 'cloud-worker.cjs');
    filename = filename.replace('.asar/', '.asar.unpacked/');
    let child, timer, settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      // Only this disposable provider process is killed. It never captures,
      // commits, restores, or deletes local recovery material.
      try { child?.kill('SIGKILL'); } catch {}
      if (error) reject(error); else resolve(value);
    };
    const abort = () => finish(Object.assign(new Error('Box delivery deferred.'), { code: 'CANCELLED' }));
    if (signal?.aborted) return abort();
    try {
      child = forkProcess(filename, [], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'], env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
      child.once('error', error => finish(error));
      child.once('exit', () => finish(Object.assign(new Error('The Box operation stopped before completion.'), { code: 'IO' })));
      child.on('message', message => {
        if (settled || !message || typeof message !== 'object') return;
        if (message.progress) { try { onProgress?.(message.progress); } catch { abort(); } }
        else if (message.error) finish(Object.assign(new Error(String(message.error.message || 'Box is unavailable.')), { code: 'IO' }));
        else if (Object.hasOwn(message, 'result')) finish(null, message.result);
      });
      signal?.addEventListener('abort', abort, { once: true });
      timer = setTimeout(() => finish(Object.assign(new Error('Box did not respond in time. Delivery will retry automatically.'), { code: 'UNAVAILABLE' })), timeoutMs);
      child.send(payload, error => { if (error) finish(error); });
    } catch (error) { finish(error); }
  });
}

async function probeCloudDestination(home, destination, options = {}) {
  try {
    const result = await runCloudProcess({ operation: 'probe', home, destination }, { timeoutMs: PROBE_TIMEOUT_MS, ...options });
    if (!result || !Array.isArray(result.roots) || !result.roots.every(p => typeof p === 'string' && path.isAbsolute(p))
      || typeof result.available !== 'boolean' || (result.destination !== undefined && (typeof result.destination !== 'string' || !path.isAbsolute(result.destination)))) throw new Error('Invalid destination probe response.');
    return result;
  } catch (error) { return { roots: [], available: false, message: error.message }; }
}

async function stageCloudBackup(source, options = {}) {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'labmate-incoming-'));
  const destination = path.join(folder, 'incoming.labmatebackup');
  const cleanup = () => fs.rm(folder, { recursive: true, force: true }).catch(() => {});
  try {
    const result = await runCloudProcess({ operation: 'stage', source, destination }, options);
    if (!result || result.file !== destination) throw new Error('Selected backup file could not be prepared.');
    return { source: destination, cleanup };
  } catch (error) {
    await cleanup();
    if (error.code === 'UNAVAILABLE') error.message = 'The selected backup file did not respond in time. Retry after downloading it to this Mac.';
    if (error.code === 'CANCELLED') error.message = 'Backup preparation cancelled.';
    throw error;
  }
}

module.exports = { DELIVERY_TIMEOUT_MS, PROBE_TIMEOUT_MS, runCloudProcess, probeCloudDestination, stageCloudBackup };
