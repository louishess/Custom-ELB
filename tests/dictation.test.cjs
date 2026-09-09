'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createDictationService, validateSession } = require('../electron/dictation.cjs');
function setup(options = {}) {
  const children = []; const events = [];
  const spawnProcess = () => {
    const process = new EventEmitter();
    process.stdout = new EventEmitter(); process.stdout.setEncoding = () => {};
    process.stderr = new EventEmitter(); process.stdin = new EventEmitter();
    process.commands = []; process.killed = false;
    process.stdin.write = input => process.commands.push(JSON.parse(input));
    process.kill = signal => { process.killed = signal; process.emit('exit', null, signal); };
    process.respond = (command, value) => process.stdout.emit('data', JSON.stringify({ id: command.id, value }) + '\n');
    children.push(process); return process;
  };
  return { children, events, service: createDictationService({ helperPath: '/fake/helper', helperExists: () => true, supported: true, spawnProcess, onEvent: event => events.push(event), ...options }) };
}
test('capabilities are unavailable without spawning on older macOS', async () => {
  const { service, children } = setup({ supported: false });
  assert.equal((await service.capabilities()).available, false); assert.equal(children.length, 0);
});
test('capabilities validate and limit fields returned by native helper', async () => {
  const { service, children } = setup(); const promise = service.capabilities();
  children[0].respond(children[0].commands[0], { available: true, locales: [{ id: 'en-US', name: 'English', installed: true, secret: 'omit' }, {}] });
  assert.deepEqual(await promise, { available: true, locales: [{ id: 'en-US', name: 'English', installed: true }] }); service.dispose();
});
test('events are session-scoped and late child messages are ignored after cancellation', async () => {
  const { service, children, events } = setup();
  const preparation = service.prepare({ sessionId: 'session-1', locale: 'en-US' }); const child = children[0];
  child.stdout.emit('data', JSON.stringify({ event: { sessionId: 'other', state: 'recording', transcript: 'wrong' } }) + '\n');
  child.respond(child.commands[0], { ready: true }); await preparation;
  const start = service.start({ sessionId: 'session-1', locale: 'en-US' }); child.respond(child.commands[1], { started: true }); await start;
  const event = { sessionId: 'session-1', state: 'recording', transcript: 'partial', final: false };
  const serialized = JSON.stringify({ event }) + '\n'; child.stdout.emit('data', serialized.slice(0, 12)); child.stdout.emit('data', serialized.slice(12));
  assert.deepEqual(events, [event]);
  await service.cancel({ sessionId: 'session-1' });
  child.stdout.emit('data', serialized); assert.equal(events.length, 2); assert.equal(child.killed, 'SIGKILL');
  service.dispose();
});
test('stop waits for the helper finalization response and forwards finalized text', async () => {
  const { service, children, events } = setup(); const start = service.start({ sessionId: 'one', locale: 'en-US' }); const child = children[0];
  child.respond(child.commands[0], { started: true }); await start;
  const stop = service.stop({ sessionId: 'one' });
  child.stdout.emit('data', JSON.stringify({ event: { sessionId: 'one', state: 'stopped', transcript: 'Final words.', final: true } }) + '\n');
  child.respond(child.commands[1], { stopped: true }); assert.deepEqual(await stop, { stopped: true });
  assert.equal(events.at(-1).transcript, 'Final words.'); service.dispose();
});
test('cancellation interrupts a pending download and permits a fresh session', async () => {
  const { service, children } = setup(); const prepare = service.prepare({ sessionId: 'one', locale: 'en-US' });
  const rejected = assert.rejects(prepare, { code: 'CANCELLED' }); await service.cancel({ sessionId: 'one' }); await rejected;
  const retry = service.prepare({ sessionId: 'two', locale: 'en-US' }); assert.equal(children.length, 2);
  children[1].respond(children[1].commands[0], { ready: true }); assert.deepEqual(await retry, { ready: true }); service.dispose();
});
test('helper exit rejects pending request and reports retained-session error', async () => {
  const { service, children, events } = setup(); const start = service.start({ sessionId: 'one', locale: 'en-US' });
  const rejected = assert.rejects(start, /stopped unexpectedly/); children[0].emit('exit', 1); await rejected;
  assert.equal(events.at(-1).state, 'error'); service.dispose();
});
test('operation timeout terminates microphone process', async () => {
  const { service, children } = setup({ timeoutMs: 15 }); const start = service.start({ sessionId: 'one', locale: 'en-US' });
  // Keep event loop alive because production timeout intentionally uses unref.
  const keepAlive = setTimeout(() => {}, 1000);
  try { await assert.rejects(start, /timed out/); assert.equal(children[0].killed, 'SIGKILL'); }
  finally { clearTimeout(keepAlive); service.dispose(); }
});
test('only exact session payloads and active ownership are accepted', async () => {
  assert.throws(() => validateSession({ sessionId: 'one', path: '/anything' }), { code: 'VALIDATION' });
  assert.throws(() => validateSession({ sessionId: 'one', locale: '../escape' }, true), { code: 'VALIDATION' });
  const { service, children } = setup(); const start = service.start({ sessionId: 'one', locale: 'en-US' });
  await assert.rejects(service.start({ sessionId: 'two', locale: 'en-US' }), /Another dictation/);
  await assert.rejects(service.cancel({ sessionId: 'two' }), /no longer active/);
  children[0].respond(children[0].commands[0], { started: true }); await start; service.dispose();
});
test('malformed helper output fails closed and kills the process', async () => {
  const { service, children } = setup(); const prepare = service.prepare({ sessionId: 'one', locale: 'en-US' });
  const rejected = assert.rejects(prepare, /invalid response/); children[0].stdout.emit('data', 'not json\n'); await rejected;
  assert.equal(children[0].killed, 'SIGKILL'); service.dispose();
});
test('permission and missing-model errors are exposed without fabricating a transcript', async () => {
  for (const message of ['Microphone access was denied.', 'Prepare the selected language before recording.']) {
    const { service, children, events } = setup();
    const start = service.start({ sessionId: 'one', locale: 'en-US' });
    const rejected = assert.rejects(start, error => error.code === 'UNAVAILABLE' && error.message === message);
    children[0].stdout.emit('data', JSON.stringify({ id: children[0].commands[0].id, error: { code: 'UNAVAILABLE', message } }) + '\n');
    await rejected; assert.deepEqual(events.at(-1), { sessionId: 'one', state: 'error', message }); service.dispose();
  }
});
test('disposing rejects work and prevents further native launches', async () => {
  const { service, children } = setup();
  const prepare = service.prepare({ sessionId: 'one', locale: 'en-US' });
  const rejected = assert.rejects(prepare, { code: 'CANCELLED' }); service.dispose(); await rejected;
  assert.equal(children[0].killed, 'SIGKILL');
  await assert.rejects(service.start({ sessionId: 'two', locale: 'en-US' }), /closed/);
  assert.equal(children.length, 1);
});
