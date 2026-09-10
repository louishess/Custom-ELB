'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const JSZip = require('jszip');
const { LibraryStore, EMPTY_DOCUMENT } = require('../electron/backend/store.cjs');
const { createBackupService } = require('../electron/backend/backup.cjs');
const { resolveExportDocument, renderExportDocument } = require('../electron/backend/exports.cjs');
const { DEFAULT_YIELD_INPUTS } = require('../shared/yield.cjs');

const materialMark = (role, id = `${role}-material`) => ({ type: 'yieldMaterial', attrs: { role, id } });
const text = (value, marks = []) => ({ type: 'text', text: value, ...(marks.length ? { marks } : {}) });
const paragraph = content => ({ type: 'paragraph', content });
const document = content => ({ type: 'doc', content });
function materialDocuments(run) {
  return {
    ...run.documents,
    information: document([paragraph([
      text('Use '), text('Substrate', [materialMark('starting'), { type: 'bold' }, { type: 'highlight', attrs: { color: '#ff0000' } }]),
      text(' (0.2g, 2  mmol, 2 equiv.)', [materialMark('starting')]),
      text(' with catalyst.', [{ type: 'italic' }]),
    ])]),
    method: document([{ type: 'table', content: [{ type: 'tableRow', content: [{
      type: 'tableCell', attrs: { colspan: 1, rowspan: 1, colwidth: [180] },
      content: [paragraph([text('Product <sample> (150mg, 750µmol, 1 eq.)', [materialMark('product')])])],
    }] }] }]),
    data: document([{ type: 'yieldCalculation', attrs: { ...DEFAULT_YIELD_INPUTS } }]),
  };
}
function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'labmate-material-persistence-'));
  const store = new LibraryStore(root);
  t.after(() => { store.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const notebook = store.dispatch('records.createNotebook', { name: 'Material test', description: '', discipline: 'Chemistry', color: 'sage' }).value.notebooks[0];
  const run = store.dispatch('records.createExperiment', { notebookId: notebook.id, label: 'Yield', title: 'Material recovery', date: '2026-09-09', author: 'Test' }).value.runs[0];
  return { root, store, run };
}
function save(store, run, documents) {
  return store.dispatch('documents.save', { runId: run.id, expectedRevision: run.revision, documents });
}
function value(result) {
  assert.equal(result.ok, true, JSON.stringify(result.error));
  return result.value;
}

test('yield material marks reject malformed attrs atomically without changing existing documents', t => {
  const { store, run } = setup(t);
  for (const attrs of [undefined, {}, { role: 'starting' }, { role: 'reactant', id: 'm' },
    { role: 'product', id: '' }, { role: 'starting', id: 'm'.repeat(129) },
    { role: 'product', id: '" onclick="bad' }, { role: 'product', id: 'm', percentage: 999 },
    { role: 'product', id: 12 }, { role: 'product', id: 'm', __proto__: null, color: 'red' }]) {
    const mark = { type: 'yieldMaterial', ...(attrs === undefined ? {} : { attrs }) };
    const result = save(store, run, { ...run.documents, information: document([paragraph([text('Substrate (1g, 1mmol, 1eq.)', [mark])])]) });
    assert.equal(result.ok, false, JSON.stringify(attrs));
    assert.equal(result.error.code, 'VALIDATION');
    assert.deepEqual(store.snapshot().runs[0], run);
  }
});

test('material role selections and existing yield cards survive save, reopen and encrypted recovery', async t => {
  const { root, store, run } = setup(t);
  const documents = materialDocuments(run);
  const saved = value(save(store, run, documents)).runs[0];
  store.close(); store.reopen();
  assert.deepEqual(store.snapshot().runs[0].documents, documents);
  const backup = createBackupService(store);
  const archive = await backup.create({ password: 'Synthetic material recovery password', jobId: 'material-backup' }, {});
  value(save(store, saved, { ...documents, information: EMPTY_DOCUMENT, method: EMPTY_DOCUMENT, data: EMPTY_DOCUMENT }));
  const restored = await backup.restore({ password: 'Synthetic material recovery password', source: path.join(root, 'backups', archive.name), jobId: 'material-restore' }, {});
  assert.deepEqual(restored.runs[0].documents, documents);
  store.close(); store.reopen();
  assert.deepEqual(store.snapshot().runs[0].documents, documents);
});

test('manual material fallback persists through reopening and encrypted recovery without replacing the original text', async t => {
  const { root, store, run } = setup(t);
  const sourceText = 'Unusual product description (isolated as oil)';
  const manual = { version: 1, sourceText, label: 'Product oil', molarAmount: '750', molarUnit: 'µmol', equivalents: '1' };
  const mark = { type: 'yieldMaterial', attrs: { role: 'product', id: 'manual-product', manual } };
  const documents = { ...run.documents, data: document([paragraph([text(sourceText, [mark])])]) };
  const saved = value(save(store, run, documents)).runs[0];
  store.close(); store.reopen();
  assert.deepEqual(store.snapshot().runs[0].documents, documents);
  const backup = createBackupService(store);
  const archive = await backup.create({ password: 'Synthetic manual recovery password', jobId: 'manual-backup' }, {});
  value(save(store, saved, { ...documents, data: EMPTY_DOCUMENT }));
  const restored = await backup.restore({ password: 'Synthetic manual recovery password', source: path.join(root, 'backups', archive.name), jobId: 'manual-restore' }, {});
  assert.deepEqual(restored.runs[0].documents, documents);
});

test('manual material fallback rejects malformed or future inputs without updating the run', t => {
  const { store, run } = setup(t);
  const manual = { version: 1, sourceText: 'Product', label: 'Product', molarAmount: '1', molarUnit: 'mmol', equivalents: '1' };
  for (const invalid of [false, { ...manual, version: 2 }, { ...manual, molarUnit: 'g' },
    { ...manual, molarAmount: 1 }, { ...manual, sourceText: 'x'.repeat(10001) },
    { ...manual, label: 'x'.repeat(501) }, { ...manual, result: 80 }]) {
    const mark = { type: 'yieldMaterial', attrs: { role: 'product', id: 'manual-product', manual: invalid } };
    const result = save(store, run, { ...run.documents, data: document([paragraph([text('Product', [mark])])]) });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'VALIDATION');
    assert.deepEqual(store.snapshot().runs[0], run);
  }
});

test('repeat clears material roles recursively while preserving prose, other formatting and table widths', t => {
  const { store, run } = setup(t);
  const documents = materialDocuments(run);
  value(save(store, run, documents));
  const snapshot = value(store.dispatch('records.repeatRun', { runId: run.id, date: '2026-09-10' }));
  const repeated = snapshot.runs.find(item => item.id !== run.id);
  assert.deepEqual(snapshot.runs.find(item => item.id === run.id).documents, documents);
  assert.doesNotMatch(JSON.stringify(repeated.documents), /yieldMaterial|yieldCalculation/);
  assert.deepEqual(repeated.documents.notes, EMPTY_DOCUMENT);
  assert.deepEqual(repeated.documents.data, EMPTY_DOCUMENT);
  assert.deepEqual(repeated.documents.information.content[0].content[1], text('Substrate', [{ type: 'bold' }, { type: 'highlight', attrs: { color: '#ff0000' } }]));
  assert.deepEqual(repeated.documents.information.content[0].content[2], text(' (0.2g, 2  mmol, 2 equiv.)'));
  assert.deepEqual(repeated.documents.information.content[0].content[3], text(' with catalyst.', [{ type: 'italic' }]));
  assert.deepEqual(repeated.documents.method.content[0].content[0].content[0].attrs.colwidth, [180]);
  assert.equal(repeated.documents.method.content[0].content[0].content[0].content[0].content[0].text, 'Product <sample> (150mg, 750µmol, 1 eq.)');
});

async function exported(store, run, format) {
  const model = await resolveExportDocument(store, null, { scope: 'entry', notebookId: run.notebookId, runIds: [run.id], format, order: 'newest', sections: ['information', 'method'], data: 'none', jobId: 'material-export' });
  const result = await renderExportDocument(model);
  return { model, text: format === 'docx' ? await (await JSZip.loadAsync(result.bytes)).file('word/document.xml').async('string') : result.bytes.toString('utf8') };
}

test('all exports retain one role label across formatting splits and rich formats preserve distinct highlights', async t => {
  const { store, run } = setup(t);
  value(save(store, run, materialDocuments(run)));
  for (const format of ['txt', 'md', 'html', 'rtf', 'docx']) {
    const result = await exported(store, run, format);
    assert.equal((result.text.match(/Starting material/g) || []).length, format === 'html' ? 3 : 1, format);
    assert.match(result.text, /Substrate/);
    assert.match(result.text, /Product/);
    assert.ok(!result.model.warnings.some(item => item.includes('yieldMaterial')));
    assert.doesNotMatch(result.text, /starting-material|product-material/, 'internal selection identifiers are not exported');
    if (format === 'html') {
      assert.match(result.text, /title="Starting material" style="background-color:#d5efd8"/);
      assert.match(result.text, /title="Product" style="background-color:#d6e6ff"/);
      assert.match(result.text, /Product &lt;sample&gt;/);
      assert.doesNotMatch(result.text, /<sample>/);
      assert.doesNotMatch(result.text, /background-color:#ff0000/);
    } else if (format === 'rtf') {
      assert.match(result.text, /\\red213\\green239\\blue216/);
      assert.match(result.text, /\\red214\\green230\\blue255/);
      assert.match(result.text, /\\highlight1/);
      assert.match(result.text, /\\highlight2/);
    } else if (format === 'docx') {
      assert.match(result.text, /w:fill="D5EFD8"/);
      assert.match(result.text, /w:fill="D6E6FF"/);
    }
  }
});

test('export flattens unsafe material attributes and never treats ordinary highlight attributes as role metadata', async () => {
  const run = { id: 'r', notebookId: 'n', experimentId: 'e', experimentNumber: 1, runNumber: 1, title: 'Unsafe attrs', date: '2026-09-09', author: 'Test', documents: {
    information: document([paragraph([
      text('<script>alert(1)</script>', [{ type: 'yieldMaterial', attrs: { role: 'product', id: '" onload="bad' } }]),
      text('ordinary highlight', [{ type: 'highlight', attrs: { color: '#d5efd8', materialRole: 'starting' } }]),
    ])]), method: EMPTY_DOCUMENT,
  } };
  const snapshot = { notebooks: [{ id: 'n', name: 'Test', discipline: 'Chemistry' }], experiments: [{ id: 'e', notebookId: 'n', label: 'Test' }], runs: [run], attachments: [], schemes: [] };
  const result = await exported({ snapshot: () => snapshot }, run, 'html');
  assert.doesNotMatch(result.text, /onload|title="Starting material"|\[Product\]|<script>/);
  assert.match(result.text, /&lt;script&gt;/);
  assert.ok(result.model.warnings.some(item => item.includes('Invalid yield material')));
});
