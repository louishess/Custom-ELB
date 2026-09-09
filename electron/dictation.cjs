'use strict';
const { spawn } = require('node:child_process');
const { existsSync } = require('node:fs');
const { release } = require('node:os');

const STATES = new Set(['preparing', 'ready', 'recording', 'stopped', 'cancelled', 'error']);
function failure(message, code = 'UNAVAILABLE') { return Object.assign(new Error(message), { code }); }
function validateSession(payload, localeRequired = false) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)
      || Object.keys(payload).some(key => !['sessionId', ...(localeRequired ? ['locale'] : [])].includes(key))
      || typeof payload.sessionId !== 'string' || !/^[a-zA-Z0-9-]{1,128}$/.test(payload.sessionId)
      || (localeRequired && (typeof payload.locale !== 'string' || !/^[a-zA-Z0-9_-]{2,64}$/.test(payload.locale)))) {
    throw failure('Invalid dictation request.', 'VALIDATION');
  }
}
function createDictationService({ helperPath, onEvent = () => {}, spawnProcess = spawn,
  supported = process.platform === 'darwin' && Number(release().split('.')[0]) >= 25,
  helperExists = existsSync, timeoutMs = 30_000, prepareTimeoutMs = 15 * 60_000 } = {}) {
  let child = null;
  let activeSession = null;
  let sequence = 0;
  let buffer = '';
  let disposed = false;
  let busy = false;
  let generation = 0;
  const pending = new Map();
  function emit(value) { try { onEvent(value); } catch { /* subscriber must not break cleanup */ } }
  function rejectPending(error) {
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(error); }
    pending.clear();
  }
  function terminate(error, announce = true) {
    const old = child; child = null; buffer = ''; generation += 1;
    rejectPending(error);
    if (announce && activeSession) emit({ sessionId: activeSession, state: 'error', message: error.message });
    activeSession = null; busy = false;
    if (old) old.kill('SIGKILL'); // Also interrupts permission prompts, downloads and stalled audio finalization.
  }
  function ensureChild() {
    if (disposed) throw failure('Dictation is closed.');
    if (!supported) throw failure('Integrated dictation requires macOS 26 or later.');
    if (!helperPath || !helperExists(helperPath)) throw failure('The dictation helper is missing. Reinstall the complete LabMate app.');
    if (child) return child;
    const current = spawnProcess(helperPath, [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    child = current;
    current.stdout.setEncoding('utf8');
    current.stdout.on('data', chunk => {
      if (child !== current) return;
      buffer += chunk;
      if (Buffer.byteLength(buffer) > 2 * 1024 * 1024) { terminate(failure('Dictation returned an oversized response.')); return; }
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        let message;
        try { message = JSON.parse(line); } catch { terminate(failure('Dictation returned an invalid response.')); return; }
        if (message.event) {
          const value = message.event;
          if (value.sessionId !== activeSession || !STATES.has(value.state)) continue;
          const event = { sessionId: value.sessionId, state: value.state };
          if (typeof value.transcript === 'string') event.transcript = value.transcript.slice(0, 1_000_000);
          if (typeof value.final === 'boolean') event.final = value.final;
          if (typeof value.message === 'string') event.message = value.message.slice(0, 4096);
          emit(event);
        } else if (message.id && pending.has(message.id)) {
          const item = pending.get(message.id); pending.delete(message.id); clearTimeout(item.timer);
          if (message.error) item.reject(failure(String(message.error.message || 'Dictation failed.')));
          else item.resolve(message.value);
        } else if (message.fatal) terminate(failure(String(message.fatal)));
      }
    });
    // Drain native diagnostics without persisting potentially sensitive recognition text.
    current.stderr.on('data', () => {});
    current.stdin.on('error', () => { if (child === current) terminate(failure('The dictation helper disconnected.')); });
    current.on('error', () => { if (child === current) terminate(failure('The dictation helper could not start.')); });
    current.on('exit', () => { if (child === current) terminate(failure('The dictation helper stopped unexpectedly. Review the transcript and try again.')); });
    return current;
  }
  function request(operation, payload = {}) {
    const current = ensureChild();
    const id = String(++sequence);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        terminate(failure(operation === 'prepare' ? 'Language preparation timed out. Check the internet connection and try again.' : 'Dictation timed out. Review your transcript and try again.'));
      }, operation === 'prepare' ? prepareTimeoutMs : timeoutMs);
      timer.unref?.();
      pending.set(id, { resolve, reject, timer });
      current.stdin.write(`${JSON.stringify({ id, operation, ...payload })}\n`);
    });
  }
  async function sessionRequest(operation, payload, localeRequired) {
    validateSession(payload, localeRequired);
    if (activeSession && activeSession !== payload.sessionId) throw failure('Another dictation session is active.', 'VALIDATION');
    if (busy) throw failure('Wait for the current dictation operation to finish.', 'VALIDATION');
    activeSession = payload.sessionId; busy = true;
    const requestGeneration = generation;
    try { return await request(operation, payload); }
    catch (error) {
      if (requestGeneration === generation && error.code !== 'CANCELLED') emit({ sessionId: payload.sessionId, state: 'error', message: error.message });
      throw error;
    }
    finally { if (requestGeneration === generation) busy = false; }
  }
  return {
    async capabilities() {
      if (!supported) return { available: false, reason: 'Integrated dictation requires macOS 26 or later.', locales: [] };
      try {
        const result = await request('capabilities');
        if (!result || typeof result.available !== 'boolean' || !Array.isArray(result.locales)) throw failure('Invalid dictation capabilities.');
        return { available: result.available, ...(typeof result.reason === 'string' ? { reason: result.reason } : {}), locales: result.locales.filter(item => item && typeof item.id === 'string' && typeof item.name === 'string' && typeof item.installed === 'boolean').map(({ id, name, installed }) => ({ id, name, installed })) };
      } catch (error) { return { available: false, reason: error.message, locales: [] }; }
    },
    prepare: payload => sessionRequest('prepare', payload, true),
    start: payload => sessionRequest('start', payload, true),
    stop: payload => sessionRequest('stop', payload, false),
    async cancel(payload) {
      validateSession(payload);
      if (activeSession && payload.sessionId !== activeSession) throw failure('This dictation session is no longer active.', 'VALIDATION');
      terminate(failure('Dictation cancelled.', 'CANCELLED'), false);
      emit({ sessionId: payload.sessionId, state: 'cancelled' });
      return { cancelled: true };
    },
    dispose() { disposed = true; terminate(failure('Dictation closed.', 'CANCELLED'), false); },
  };
}
module.exports = { createDictationService, validateSession };
