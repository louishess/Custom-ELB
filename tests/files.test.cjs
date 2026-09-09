'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const ExcelJS = require('exceljs');
const { LibraryStore } = require('../electron/backend/store.cjs');
const { createFileService, FileServiceError } = require('../electron/backend/files.cjs');

function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'labmate-files-library-'));
  const sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'labmate-files-source-'));
  const store = new LibraryStore(root);
  t.after(() => {
    try { store.close(); } catch {}
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(sourceRoot, { recursive: true, force: true });
  });
  const notebookResult = store.dispatch('records.createNotebook', {
    name: 'Preview tests', description: 'Disposable attachment test data', discipline: 'Chemistry', color: 'sage',
  });
  assert.equal(notebookResult.ok, true);
  const notebook = notebookResult.value.notebooks[0];
  const experimentResult = store.dispatch('records.createExperiment', {
    notebookId: notebook.id, label: 'Series A', title: 'A test run', date: '2026-09-08', author: 'Tester',
  });
  assert.equal(experimentResult.ok, true);
  const run = experimentResult.value.runs[0];
  return { root, sourceRoot, store, run };
}

function signalContext(jobId = 'test-job') {
  return { signal: new AbortController().signal, onProgress: () => {}, jobId };
}

test('imports a copied attachment through the real LibraryStore and previews, updates, and removes it', async t => {
  const { root, sourceRoot, store, run } = setup(t);
  const source = path.join(sourceRoot, 'measurements.csv');
  const original = 'sample,response\nA,0.82\nB,0.91\n';
  fs.writeFileSync(source, original);
  const service = createFileService(store);

  const snapshot = await service.importFiles({ runId: run.id, paths: [source], jobId: 'import-csv' }, signalContext('import-csv'));
  assert.equal(snapshot.attachments.length, 1);
  const attachment = snapshot.attachments[0];
  assert.equal(attachment.name, 'measurements.csv');
  assert.equal(attachment.kind, 'spreadsheet');
  assert.equal(attachment.hash, crypto.createHash('sha256').update(original).digest('hex'));
  assert.equal(fs.readFileSync(source, 'utf8'), original, 'the native source remains untouched');
  const managedPath = service.getPath(attachment.id);
  assert.equal(path.dirname(managedPath), path.join(root, 'objects'));
  assert.equal(fs.statSync(managedPath).mode & 0o222, 0, 'managed object is immutable');

  const preview = await service.preview({ id: attachment.id, jobId: 'preview-csv' }, signalContext('preview-csv'));
  assert.equal(preview.kind, 'spreadsheet');
  assert.deepEqual(preview.sheets[0].rows.slice(0, 3), [
    ['sample', 'response'], ['A', '0.82'], ['B', '0.91'],
  ]);
  const updated = service.update({ id: attachment.id, caption: 'Raw measurement table' });
  assert.equal(updated.attachments.find(item => item.id === attachment.id).caption, 'Raw measurement table');
  const removed = service.remove({ id: attachment.id });
  assert.equal(removed.attachments.length, 0);
  assert.equal(fs.existsSync(managedPath), false, 'the store garbage-collects an unreferenced object');
});

test('aborting an import removes partial staging data and leaves metadata unchanged', async t => {
  const { root, sourceRoot, store, run } = setup(t);
  const source = path.join(sourceRoot, 'large.csv');
  fs.writeFileSync(source, Buffer.alloc(2 * 1024 * 1024, 0x61));
  const service = createFileService(store);
  const controller = new AbortController();
  let aborted = false;
  const context = {
    signal: controller.signal,
    jobId: 'abort-import',
    onProgress: event => {
      if (!aborted && event.phase === 'copy') {
        aborted = true;
        controller.abort();
      }
    },
  };
  await assert.rejects(
    service.importFiles({ runId: run.id, paths: [source], jobId: 'abort-import' }, context),
    error => error instanceof FileServiceError && error.code === 'CANCELLED',
  );
  assert.equal(aborted, true);
  assert.equal(store.snapshot().attachments.length, 0);
  assert.deepEqual(fs.readdirSync(path.join(root, 'staging')), []);
});

test('duplicate byte imports share one immutable object until the last metadata row is removed', async t => {
  const { root, sourceRoot, store, run } = setup(t);
  const source = path.join(sourceRoot, 'duplicate.csv');
  fs.writeFileSync(source, 'sample,response\nA,0.82\n');
  const service = createFileService(store);
  const first = await service.importFiles({ runId: run.id, paths: [source], jobId: 'duplicate-one' }, signalContext('duplicate-one'));
  const firstAttachment = first.attachments[0];
  const objectPath = service.getPath(firstAttachment.id);
  const second = await service.importFiles({ runId: run.id, paths: [source], jobId: 'duplicate-two' }, signalContext('duplicate-two'));
  assert.equal(second.attachments.length, 2);
  assert.equal(second.attachments[0].hash, second.attachments[1].hash);
  assert.equal(service.getPath(second.attachments[1].id), objectPath);
  assert.equal(fs.readdirSync(path.join(root, 'staging')).length, 0);

  service.remove({ id: firstAttachment.id });
  assert.equal(fs.existsSync(objectPath), true, 'the shared object remains referenced by the second row');
  service.remove({ id: second.attachments[1].id });
  assert.equal(fs.existsSync(objectPath), false, 'the object is collected after the final row is removed');
});

test('rejects source symlinks and protects managed object path traversal', async t => {
  const { root, sourceRoot, store, run } = setup(t);
  const source = path.join(sourceRoot, 'source.txt');
  const alias = path.join(sourceRoot, 'alias.txt');
  fs.writeFileSync(source, 'original');
  fs.symlinkSync(source, alias);
  const service = createFileService(store);
  await assert.rejects(
    service.importFiles({ runId: run.id, paths: [alias], jobId: 'symlink' }, signalContext('symlink')),
    error => error instanceof FileServiceError && error.code === 'VALIDATION',
  );

  const hash = crypto.createHash('sha256').update('object').digest('hex');
  const objectPath = path.join(root, 'objects', hash);
  fs.writeFileSync(objectPath, 'object');
  const addResult = store.addAttachment({
    id: crypto.randomUUID(), runId: run.id, name: 'object.bin', mime: 'application/octet-stream', size: 6,
    hash, caption: '', kind: 'file', createdAt: '2026-09-08T12:00:00.000Z',
  });
  assert.ok(addResult);
  const record = store.snapshot().attachments[0];
  fs.unlinkSync(objectPath);
  fs.symlinkSync(source, objectPath);
  assert.throws(() => service.getPath(record.id), error => error instanceof FileServiceError && error.code === 'CORRUPT');
});

test('returns explanatory outcomes for corrupt PDFs and oversized images before renderer bytes', async t => {
  const { sourceRoot, store, run } = setup(t);
  const pdfSource = path.join(sourceRoot, 'incomplete.pdf');
  fs.writeFileSync(pdfSource, '%PDF-1.7\n1 0 obj\n');
  const imageSource = path.join(sourceRoot, 'large.png');
  const imageHeader = Buffer.alloc(32);
  Buffer.from('\x89PNG\r\n\x1a\n', 'binary').copy(imageHeader, 0);
  imageHeader.writeUInt32BE(100_000, 16);
  imageHeader.writeUInt32BE(100_000, 20);
  fs.writeFileSync(imageSource, imageHeader);
  const service = createFileService(store);
  let snapshot = await service.importFiles({ runId: run.id, paths: [pdfSource, imageSource], jobId: 'limits-import' }, signalContext('limits-import'));
  assert.equal(snapshot.attachments.length, 2);
  const pdf = snapshot.attachments.find(item => item.kind === 'pdf');
  const image = snapshot.attachments.find(item => item.kind === 'image');
  const pdfPreview = await service.preview({ id: pdf.id, jobId: 'pdf' }, signalContext('pdf'));
  assert.equal(pdfPreview.kind, 'unsupported');
  assert.match(pdfPreview.message, /incomplete|corrupt/i);
  const imagePreview = await service.preview({ id: image.id, jobId: 'image' }, signalContext('image'));
  assert.equal(imagePreview.kind, 'unsupported');
  assert.match(imagePreview.message, /50 megapixels/i);
});

test('returns bounded local PDF bytes for the renderer worker', async t => {
  const { sourceRoot, store, run } = setup(t);
  const source = path.join(sourceRoot, 'one-page.pdf');
  const minimalPdf = '%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n';
  fs.writeFileSync(source, minimalPdf);
  const service = createFileService(store);
  const snapshot = await service.importFiles({ runId: run.id, paths: [source], jobId: 'import-pdf' }, signalContext('import-pdf'));
  const attachment = snapshot.attachments[0];
  const preview = await service.preview({ id: attachment.id, jobId: 'preview-pdf' }, signalContext('preview-pdf'));
  assert.equal(preview.kind, 'pdf');
  assert.deepEqual(Buffer.from(preview.bytes).toString('utf8'), minimalPdf);
});

test('parses XLSX cached formula results in an isolated process without exposing formula text', async t => {
  const { sourceRoot, store, run } = setup(t);
  const source = path.join(sourceRoot, 'formula.xlsx');
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Results');
  sheet.addRow(['Input', 'Output']);
  sheet.addRow([2, { formula: 'A2*2', result: 4 }]);
  await workbook.xlsx.writeFile(source);
  const service = createFileService(store);
  const snapshot = await service.importFiles({ runId: run.id, paths: [source], jobId: 'import-xlsx' }, signalContext('import-xlsx'));
  const attachment = snapshot.attachments[0];
  const preview = await service.preview({ id: attachment.id, jobId: 'preview-xlsx' }, signalContext('preview-xlsx'));
  assert.equal(preview.kind, 'spreadsheet');
  const rows = preview.sheets.find(sheetValue => sheetValue.name === 'Results').rows;
  assert.deepEqual(rows.slice(0, 2), [['Input', 'Output'], ['2', '4']]);
  assert.equal(rows.flat().some(cell => cell.includes('A2*2')), false);
});
