'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { parseDelimited } = require('../electron/backend/parser.cjs');
const { resolveParserNodePath, resolveParserPath } = require('../electron/backend/files.cjs');

test('maps an asar parser path to its unpacked executable location', () => {
  assert.equal(
    resolveParserPath('/Applications/LabMate.app/Contents/Resources/app.asar/electron/backend'),
    '/Applications/LabMate.app/Contents/Resources/app.asar.unpacked/electron/backend/parser.cjs',
  );
  assert.equal(
    resolveParserNodePath('/Applications/LabMate.app/Contents/Resources/app.asar.unpacked/electron/backend/parser.cjs'),
    '/Applications/LabMate.app/Contents/Resources/app.asar/node_modules',
  );
});

test('keeps a development parser path outside an asar archive', () => {
  assert.equal(resolveParserPath('/tmp/labmate/electron/backend'), '/tmp/labmate/electron/backend/parser.cjs');
});

test('surfaces malformed delimited quoting as a corrupt preview', async () => {
  await assert.rejects(
    parseDelimited('sample,"unterminated', ',', new AbortController().signal),
    error => error?.code === 'CORRUPT' && /delimited file/i.test(error.message),
  );
});
