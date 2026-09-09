'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {createBridgeRuntime, validateRendererPayload} = require('../electron/main.cjs');
const {isAllowedMethod} = require('../electron/preload.cjs');

test('dictation bridge validates payloads, isolates session owners and cleans up a closed renderer', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'labmate-speech-bridge-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  let emit;
  const calls = [];
  const runtime = createBridgeRuntime({root, env: {}, appApi: {getPath: () => root}, dictationFactory: ({onEvent}) => {
    emit = onEvent;
    return {capabilities: async () => ({available: true, locales: []}), start: async p => {calls.push(['start',p.sessionId]); return {started:true};}, stop: async p => {calls.push(['stop',p.sessionId]); return {stopped:true};}, cancel: async p => {calls.push(['cancel',p.sessionId]); return {cancelled:true};}, dispose() {}};
  }});
  const messages = [[], []];
  const event = i => {const frame = {url:'elb://app/index.html'}; return {senderFrame:frame, sender:{id:i,mainFrame:frame,getURL:()=>frame.url,send:(...v)=>messages[i].push(v)}};};
  const first = event(0), second = event(1);
  assert.equal(isAllowedMethod('dictation.start'), true);
  for (const input of [{sessionId:'x',locale:'en-US',path:'/etc'}, {sessionId:'../x',locale:'en-US'}, {sessionId:'x'}, null]) assert.equal(validateRendererPayload('dictation.start',input).ok,false);
  assert.equal(validateRendererPayload('dictation.capabilities',{}).ok,false);
  assert.equal((await runtime.handleInvoke(first,'dictation.start',{sessionId:'first',locale:'en-US'})).ok,true);
  emit({sessionId:'first',state:'recording',transcript:'hello'});
  assert.equal(messages[0].length,1); assert.equal(messages[1].length,0);
  assert.equal((await runtime.handleInvoke(second,'dictation.stop',{sessionId:'first'})).ok,false);
  assert.equal((await runtime.handleInvoke(second,'dictation.start',{sessionId:'second',locale:'en-US'})).ok,false);
  runtime.cancelWindowDictation(first.sender);
  assert.deepEqual(calls.at(-1),['cancel','first']);
  assert.equal((await runtime.handleInvoke(second,'dictation.start',{sessionId:'second',locale:'en-US'})).ok,true);
  await runtime.handleInvoke(second,'dictation.cancel',{sessionId:'second'});
});
