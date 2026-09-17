'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {EventEmitter} = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const {CHANNEL, ACCESSIBILITY_NOTIFICATION, appearanceStatus, applyMaterial, installMaterial} = require('../electron/appearance.cjs');

test('native Reduce Motion is independent of Glass accessibility fallbacks', () => {
  const preferences = {getAnimationSettings: () => ({prefersReducedMotion:true})};
  assert.deepEqual(appearanceStatus({}, 'glass', 'darwin', preferences), {
    material:'glass', reducedTransparency:false, highContrast:false, reducedMotion:true,
  });
  for (const flag of ['prefersReducedTransparency', 'shouldUseHighContrastColors']) {
    const status = appearanceStatus({[flag]:true}, 'glass', 'darwin', preferences);
    assert.equal(status.material, 'solid');
    assert.equal(status.reducedMotion, true);
  }
  assert.equal(appearanceStatus({}).reducedMotion, false);
});

test('native motion changes publish without a nativeTheme event and observers stop on close', t => {
  t.mock.timers.enable({apis:['setInterval']});
  const theme = new EventEmitter();
  const window = new EventEmitter();
  window.webContents = new EventEmitter();
  const sent = [];
  window.webContents.send = (channel, value) => sent.push({channel, value});
  window.isDestroyed = () => false;
  let reducedMotion = false, reads = 0, notify, unsubscribed;
  const preferences = {
    getAnimationSettings: () => { reads += 1; return {prefersReducedMotion:reducedMotion}; },
    subscribeWorkspaceNotification: (name, listener) => {
      assert.equal(name, ACCESSIBILITY_NOTIFICATION); notify = listener; return 17;
    },
    unsubscribeWorkspaceNotification: id => { unsubscribed = id; },
  };
  installMaterial(window, theme, preferences);
  applyMaterial(window, theme, 'glass', preferences);
  assert.equal(sent.at(-1).value.reducedMotion, false);
  reducedMotion = true;
  t.mock.timers.tick(1000);
  assert.equal(sent.at(-1).channel, CHANNEL);
  assert.equal(sent.at(-1).value.reducedMotion, true);
  assert.equal(sent.at(-1).value.material, process.platform === 'darwin' ? 'glass' : 'solid');
  const count = sent.length;
  t.mock.timers.tick(3000);
  assert.equal(sent.length, count, 'Unchanged polling must not repeatedly publish or reset vibrancy.');
  if (process.platform === 'darwin') {
    reducedMotion = false; notify();
    assert.equal(sent.at(-1).value.reducedMotion, false);
  }
  reducedMotion = true;
  window.emit('focus');
  assert.equal(sent.at(-1).value.reducedMotion, true);
  theme.prefersReducedTransparency = true;
  theme.emit('updated');
  assert.equal(sent.at(-1).value.material, 'solid');
  assert.equal(sent.at(-1).value.reducedTransparency, true);
  assert.equal(sent.at(-1).value.reducedMotion, true);
  window.emit('closed');
  if (process.platform === 'darwin') assert.equal(unsubscribed, 17);
  assert.equal(theme.listenerCount('updated'), 0);
  assert.equal(window.listenerCount('focus'), 0);
  assert.equal(window.webContents.listenerCount('did-finish-load'), 0);
  const readsAfterClose = reads;
  t.mock.timers.tick(3000);
  assert.equal(reads, readsAfterClose);
});

test('preload forwards only the narrow immutable appearance status including native motion', () => {
  const ipcRenderer = new EventEmitter();
  let api;
  const sandbox = {
    require: name => {
      assert.equal(name, 'electron');
      return {ipcRenderer, contextBridge:{exposeInMainWorld: (_name, value) => { api = value; }}};
    },
    module:{exports:{}},
  };
  vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../electron/preload.cjs'), 'utf8'), sandbox);
  const events = [];
  const unsubscribe = api.onAppearance(value => events.push(value));
  ipcRenderer.emit(CHANNEL, {}, {material:'glass', reducedMotion:true, reducedTransparency:false, highContrast:false, unwanted:'discard'});
  assert.equal(events[0].reducedMotion, true);
  assert.equal(events[0].material, 'glass');
  assert.deepEqual(Object.keys(events[0]).sort(), ['highContrast','material','reducedMotion','reducedTransparency']);
  assert.equal(Object.isFrozen(events[0]), true);
  ipcRenderer.emit(CHANNEL, {}, {material:'solid', reducedMotion:false, reducedTransparency:true, highContrast:true});
  assert.equal(events[1].reducedMotion, false);
  assert.equal(events[1].reducedTransparency, true);
  assert.equal(events[1].highContrast, true);
  unsubscribe();
  ipcRenderer.emit(CHANNEL, {}, {material:'solid', reducedMotion:true});
  assert.equal(events.length, 2);
});

test('renderer honors native reduced motion when Chromium reports false and preserves media-query support', () => {
  const document = {documentElement:{dataset:{}}};
  let mediaMatches = false;
  const window = {matchMedia: query => { assert.equal(query, '(prefers-reduced-motion: reduce)'); return {matches:mediaMatches}; }};
  const source = fs.readFileSync(path.resolve(__dirname, '../src/appearance.ts'), 'utf8');
  const output = ts.transpileModule(source, {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
  const module = {exports:{}};
  new Function('module','exports','document','window', output)(module, module.exports, document, window);
  const {applyNativeAppearance, shouldReduceMotion} = module.exports;
  applyNativeAppearance({material:'glass', reducedMotion:true});
  assert.equal(document.documentElement.dataset.material, 'glass');
  assert.equal(document.documentElement.dataset.reducedMotion, 'true');
  assert.equal(shouldReduceMotion(), true);
  applyNativeAppearance({material:'glass', reducedMotion:false});
  assert.equal(document.documentElement.dataset.reducedMotion, 'false');
  assert.equal(shouldReduceMotion(), false);
  mediaMatches = true;
  assert.equal(shouldReduceMotion(), true);
});
