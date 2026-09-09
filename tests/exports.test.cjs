'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = fs.promises;
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const JSZip = require('jszip');

const {
  createExportService,
  resolveExportDocument,
} = require('../electron/backend/exports.cjs');
const { LibraryStore } = require('../electron/backend/store.cjs');
const { createFileService } = require('../electron/backend/files.cjs');

const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

function emptyDocument() {
  return { type: 'doc', content: [{ type: 'paragraph' }] };
}

function documents() {
  return {
    information: {
      type: 'doc',
      content: [{ type: 'heading', attrs: { level: 2, textAlign: 'center' }, content: [{ type: 'text', text: 'Información' }] }],
    },
    method: {
      type: 'doc',
      content: [{
        type: 'bulletList',
        content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [
          { type: 'text', text: 'Bold', marks: [{ type: 'bold' }] },
          { type: 'text', text: ' and highlighted', marks: [{ type: 'highlight', attrs: { color: '#ffcc00' } }] },
        ] }] }],
      }],
    },
    notes: {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Unicode αβγ — note' }] }],
    },
    data: {
      type: 'doc',
      content: [{
        type: 'table',
        content: [
          { type: 'tableRow', content: [
            { type: 'tableHeader', content: [{ type: 'text', text: 'Sample' }] },
            { type: 'tableHeader', content: [{ type: 'text', text: 'Value' }] },
          ] },
          { type: 'tableRow', content: [
            { type: 'tableCell', content: [{ type: 'text', text: 'α' }] },
            { type: 'tableCell', content: [{ type: 'text', text: '1.25' }] },
          ] },
        ],
      }],
    },
  };
}

async function makeRealLibrary(t) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'labmate-export-test-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const store = new LibraryStore(root);
  t.after(() => store.close());
  const notebookResult = store.dispatch('records.createNotebook', {
    name: 'Unicode Notebook', description: 'Export fixture', discipline: 'Chemistry', color: 'sage',
  });
  assert.equal(notebookResult.ok, true);
  const notebook = store.snapshot().notebooks[0];
  const experimentResult = store.dispatch('records.createExperiment', {
    notebookId: notebook.id, label: 'Series', title: 'Export run', date: '2026-09-08', author: 'A. Researcher',
  });
  assert.equal(experimentResult.ok, true);
  let snapshot = store.snapshot();
  const run = snapshot.runs[0];
  const saveResult = store.dispatch('documents.save', {
    runId: run.id, expectedRevision: run.revision, documents: documents(),
  });
  assert.equal(saveResult.ok, true);

  const sourceDirectory = await fsp.mkdtemp(path.join(root, 'source-'));
  const source = path.join(sourceDirectory, 'shared-preview.png');
  await fsp.writeFile(source, PNG_1X1, { flag: 'wx' });
  t.after(() => fsp.rm(sourceDirectory, { recursive: true, force: true }));
  const fileService = createFileService(store);
  const importResult = await fileService.importFiles({ runId: run.id, paths: [source], jobId: 'import-1' }, {});
  assert.equal(importResult.runs.length, 1);
  const attachment = store.snapshot().attachments[0];
  assert.equal(attachment.runId, run.id);
  return { root, store, fileService, notebook, run: store.snapshot().runs[0], attachment, source };
}

function request(notebookId, runIds, format, destination, overrides = {}) {
  return {
    scope: runIds.length === 1 ? 'entry' : 'selected', notebookId, runIds, format,
    order: 'newest', sections: ['information', 'method', 'notes', 'data'], data: 'previews',
    jobId: `export-${format}`, destination, ...overrides,
  };
}

test('resolver preserves Tiptap order, selection, scheme order, and formatting metadata', async () => {
  const base = {
    notebooks: [{ id: 'notebook', name: 'Notebook', discipline: 'Chemistry', trashedAt: null }],
    experiments: [{ id: 'experiment-1', notebookId: 'notebook', label: 'Series' }],
    runs: [
      { id: 'run-1', notebookId: 'notebook', experimentId: 'experiment-1', label: 'Series', experimentNumber: 1, runNumber: 1, title: 'First', date: '2026-09-01', author: 'A', trashedAt: null, documents: documents() },
      { id: 'run-2', notebookId: 'notebook', experimentId: 'experiment-1', label: 'Series', experimentNumber: 1, runNumber: 2, title: 'Second', date: '2026-09-02', author: 'A', trashedAt: null, documents: documents() },
    ],
    attachments: [],
    schemes: [{ id: 'scheme', notebookId: 'notebook', name: 'Ordered scheme', runIds: ['run-2', 'run-1'] }],
  };
  const model = await resolveExportDocument({ snapshot: () => base }, null, {
    scope: 'selected', notebookId: 'notebook', runIds: ['run-1', 'run-2'], format: 'html', order: 'scheme', schemeId: 'scheme',
    sections: ['notes', 'information'], data: 'none', jobId: 'job', destination: '/tmp/export.html',
  });
  assert.deepEqual(model.entries.map(entry => entry.id), ['run-2', 'run-1']);
  assert.deepEqual(model.entries[0].sections.map(section => section.id), ['notes', 'information']);
  assert.ok(model.warnings.some(message => message.includes('unsupported rich-text nodes')));
  assert.ok(model.entries[0].sections[1].document.content[0].attrs.align === 'center');
  await assert.rejects(
    resolveExportDocument({ snapshot: () => ({ ...base, runs: [...base.runs, { ...base.runs[0], id: 'run-3' }], schemes: base.schemes }) }, null, {
      scope: 'selected', notebookId: 'notebook', runIds: ['run-1', 'run-3'], format: 'txt', order: 'scheme', schemeId: 'scheme',
      sections: ['notes'], data: 'none', jobId: 'job', destination: '/tmp/export.txt',
    }),
    error => error.code === 'VALIDATION' && /outside scheme/.test(error.message),
  );
});

test('PDF preview bytes are discarded and reported as caption fallback', async () => {
  const snapshot = {
    notebooks: [{ id: 'notebook', name: 'Notebook', discipline: 'Chemistry', trashedAt: null }],
    experiments: [{ id: 'experiment', notebookId: 'notebook', label: 'Series' }],
    runs: [{
      id: 'run', notebookId: 'notebook', experimentId: 'experiment', label: 'Series', experimentNumber: 1,
      runNumber: 1, title: 'PDF run', date: '2026-09-08', author: 'A', trashedAt: null, documents: documents(),
    }],
    attachments: [{ id: 'pdf', runId: 'run', name: 'report.pdf', mime: 'application/pdf', size: 8, caption: 'Report', kind: 'pdf', hash: 'a'.repeat(64) }],
    schemes: [],
  };
  const model = await resolveExportDocument(
    { snapshot: () => snapshot },
    { preview: async () => ({ kind: 'pdf', mime: 'application/pdf', bytes: Buffer.from('%PDF-1.4') }) },
    { scope: 'entry', notebookId: 'notebook', runIds: ['run'], format: 'html', order: 'newest', sections: ['data'], data: 'previews', jobId: 'pdf-export', destination: '/tmp/report.html' },
  );
  assert.equal(model.entries[0].attachments[0].preview.kind, 'pdf');
  assert.equal(model.entries[0].attachments[0].preview.bytes, undefined);
  assert.ok(model.warnings.some(message => message.includes('no embeddable preview')));
});

test('real LibraryStore and file service export all five formats with previews', async t => {
  const { store, fileService, notebook, run, attachment, root } = await makeRealLibrary(t);
  const service = createExportService(store, fileService);
  const outputDir = await fsp.mkdtemp(path.join(root, 'outputs-'));
  t.after(() => fsp.rm(outputDir, { recursive: true, force: true }));
  const checks = new Map([
    ['txt', bytes => bytes.toString('utf8').includes('reaction') || bytes.toString('utf8').includes(attachment.name)],
    ['md', bytes => bytes.toString('utf8').includes(attachment.name)],
    ['html', bytes => bytes.toString('utf8').includes('data:image/png;base64,')],
    ['rtf', bytes => bytes.toString('utf8').includes('\\pict\\pngblip')],
    ['docx', bytes => bytes.subarray(0, 4).toString('binary') === 'PK\x03\x04'],
  ]);
  for (const [format, check] of checks) {
    const destination = path.join(outputDir, `record.${format}`);
    const result = await service.write(request(notebook.id, [run.id], format, destination), {});
    assert.equal(result.cancelled, false);
    assert.equal(result.name, `record.${format}`);
    const bytes = await fsp.readFile(destination);
    assert.ok(bytes.length > 0, `${format} output is empty`);
    assert.equal(check(bytes), true, `${format} output missed its preview/content`);
    if (format === 'md') {
      const assetDirectory = path.join(outputDir, 'record_assets');
      const files = await fsp.readdir(assetDirectory);
      assert.equal(files.length, 1);
      assert.ok(files[0].startsWith('record-01-'));
      assert.match((await fsp.readFile(destination)).toString('utf8'), /record_assets\/record-01-/);
    }
    if (format === 'docx') {
      const zip = await JSZip.loadAsync(bytes);
      const documentXml = await zip.file('word/document.xml').async('string');
      assert.match(documentXml, /Informaci/);
      assert.ok(zip.file(/word\/media\//).length >= 1);
    }
  }
});

test('overwrite replaces the selected destination and rolls back primary plus companion folder on promotion failure', async t => {
  const { store, fileService, notebook, run, root } = await makeRealLibrary(t);
  const service = createExportService(store, fileService);
  const outputDir = await fsp.mkdtemp(path.join(root, 'overwrite-'));
  t.after(() => fsp.rm(outputDir, { recursive: true, force: true }));
  const destination = path.join(outputDir, 'record.md');
  await fsp.writeFile(destination, 'old primary', { flag: 'wx' });
  const assetsDirectory = path.join(outputDir, 'record_assets');
  await fsp.mkdir(assetsDirectory);
  await fsp.writeFile(path.join(assetsDirectory, 'old.txt'), 'old asset', { flag: 'wx' });

  const overwritten = await service.write(request(notebook.id, [run.id], 'md', destination), {});
  assert.equal(overwritten.cancelled, false);
  assert.notEqual((await fsp.readFile(destination)).toString('utf8'), 'old primary');
  assert.ok((await fsp.readdir(assetsDirectory)).some(name => name.startsWith('record-01-')));

  const originalRename = fsp.rename;
  let injected = false;
  fsp.rename = async (source, target) => {
    if (!injected && source.includes(`${path.sep}.labmate-export-`) && path.basename(source) === 'rollback_assets') {
      injected = true;
      const error = new Error('injected companion promotion failure');
      error.code = 'EIO';
      throw error;
    }
    return originalRename(source, target);
  };
  const rollbackDestination = path.join(outputDir, 'rollback.md');
  const rollbackAssets = path.join(outputDir, 'rollback_assets');
  await fsp.writeFile(rollbackDestination, 'previous primary', { flag: 'wx' });
  await fsp.mkdir(rollbackAssets);
  await fsp.writeFile(path.join(rollbackAssets, 'previous.txt'), 'previous asset', { flag: 'wx' });
  try {
    await assert.rejects(service.write(request(notebook.id, [run.id], 'md', rollbackDestination), {}), error => error.code === 'IO');
  } finally {
    fsp.rename = originalRename;
  }
  assert.equal(injected, true);
  assert.equal((await fsp.readFile(rollbackDestination)).toString('utf8'), 'previous primary');
  assert.equal((await fsp.readFile(path.join(rollbackAssets, 'previous.txt'))).toString('utf8'), 'previous asset');
});

test('multi-entry Markdown export gives same-named previews globally unique companion assets', async t => {
  const { store, fileService, notebook, run, source, root } = await makeRealLibrary(t);
  const secondResult = store.dispatch('records.createExperiment', {
    notebookId: notebook.id, label: 'Series', title: 'Second export run', date: '2026-09-09', author: 'A. Researcher',
  });
  assert.equal(secondResult.ok, true);
  const secondRun = store.snapshot().runs.find(candidate => candidate.id !== run.id);
  assert.ok(secondRun);
  const importResult = await fileService.importFiles({ runId: secondRun.id, paths: [source], jobId: 'import-2' }, {});
  assert.equal(importResult.runs.length, 2);
  const service = createExportService(store, fileService);
  const outputDir = await fsp.mkdtemp(path.join(root, 'multi-entry-'));
  t.after(() => fsp.rm(outputDir, { recursive: true, force: true }));
  const destination = path.join(outputDir, 'multi.md');
  const result = await service.write(request(notebook.id, [run.id, secondRun.id], 'md', destination), {});
  assert.equal(result.cancelled, false);
  const assetNames = await fsp.readdir(path.join(outputDir, 'multi_assets'));
  assert.equal(assetNames.length, 2);
  assert.notEqual(assetNames[0], assetNames[1]);
  const markdown = (await fsp.readFile(destination)).toString('utf8');
  for (const name of assetNames) assert.ok(markdown.includes(`multi_assets/${name}`));
});
