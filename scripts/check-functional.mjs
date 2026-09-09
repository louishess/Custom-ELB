import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, cp } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { _electron as electron } from 'playwright';
import ExcelJS from 'exceljs';
const require = createRequire(import.meta.url);

const root = await mkdtemp(path.join(os.tmpdir(), 'labmate-acceptance-'));
const library = path.join(root, 'library');
const output = path.resolve('artifacts/functional');
await mkdir(output, { recursive: true });
const errors = [], externalRequests = [], checks = [];
let application, page;
async function launch() {
  application = await electron.launch({
    ...(process.env.LABMATE_APP_BINARY ? { executablePath: process.env.LABMATE_APP_BINARY, args: [] } : { args: ['.'] }),
    env: { ...process.env, LABMATE_LIBRARY_ROOT: library, LABMATE_TEST_PROFILE: path.join(root, 'profile') },
  });
  page = await application.firstWindow();
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (/^https?:/.test(request.url())) externalRequests.push(request.url()); });
  await page.waitForFunction(() => Boolean(window.labmate));
}
async function raw(method, input) {
  return page.evaluate(async ({ method, input }) => {
    const [namespace, name] = method.split('.');
    return window.labmate[namespace][name](input);
  }, { method, input });
}
async function api(method, input) {
  const result = await raw(method, input);
  assert.equal(result.ok, true, `${method}: ${JSON.stringify(result)}`);
  return result.value;
}
async function check(name, operation) { await operation(); checks.push(name); console.log(`PASS ${name}`); }
async function reload() { await page.reload(); await page.waitForFunction(() => Boolean(window.labmate)); }
const doc = text => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] });
function samplePdf() {
  const stream = label => { const content = `BT /F1 18 Tf 20 100 Td (${label}) Tj ET`; return `<< /Length ${content.length} >>\nstream\n${content}\nendstream`; };
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 280 160] /Resources << /Font << /F1 7 0 R >> >> /Contents 4 0 R >>',
    stream('LabMate PDF page one'),
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 280 160] /Resources << /Font << /F1 7 0 R >> >> /Contents 6 0 R >>',
    stream('LabMate PDF page two'),
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let output = '%PDF-1.4\n'; const offsets = [0];
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(output)); output += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(output);
  output += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  output += offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  output += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return output;
}
let notebook, first, second, scheme, attachment;
try {
  await launch();
  await check('New installed library is empty and renderer remains sandboxed', async () => {
    const state = await api('records.snapshot');
    assert.deepEqual(state.notebooks, []);
    assert.deepEqual(state.runs, []);
    const prefs = await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences());
    assert.equal(prefs.sandbox, true); assert.equal(prefs.contextIsolation, true); assert.equal(prefs.nodeIntegration, false);
    assert.equal(await page.evaluate(() => typeof window.require), 'undefined');
    assert.equal(await page.evaluate(() => typeof window.labmate.invoke), 'undefined');
    await page.getByRole('heading', { name: 'Lab notebooks', exact: true }).waitFor();
    await page.screenshot({ path: path.join(output, '01-empty.png') });
  });
  await check('Validated notebook and experiment creation are durable API operations', async () => {
    assert.equal((await raw('records.createNotebook', { name: '', description: '', discipline: '', color: 'sage' })).ok, false);
    let state = await api('records.createNotebook', { name: 'Acceptance notebook', description: 'Disposable automated validation', discipline: 'Chemistry', color: 'sage' });
    notebook = state.notebooks[0];
    state = await api('records.createExperiment', { notebookId: notebook.id, label: 'Test', title: 'Persistent α experiment', date: '2026-09-08', author: 'Acceptance runner' });
    first = state.runs[0];
    assert.equal(first.experimentNumber, 1); assert.equal(first.runNumber, 1);
    assert.equal(first.status, 'todo');
  });
  await check('Four documents save atomically and stale revisions cannot overwrite them', async () => {
    const documents = { information: doc('Purpose: α and H₂O'), method: { type: 'doc', content: [{ type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Procedure' }] }, { type: 'paragraph', content: [{ type: 'text', text: 'Bold β', marks: [{ type: 'bold' }] }] }] }, notes: doc('Observed 1.25 units'), data: doc('Supporting data') };
    const oldRevision = first.revision;
    let state = await api('documents.save', { runId: first.id, expectedRevision: oldRevision, documents });
    first = state.runs.find(run => run.id === first.id);
    assert.deepEqual(first.documents, documents);
    const stale = await raw('documents.save', { runId: first.id, expectedRevision: oldRevision, documents: { ...documents, notes: doc('Must not overwrite') } });
    assert.equal(stale.ok, false); assert.equal(stale.error.code, 'STALE_REVISION');
    state = await api('records.updateRun', { id: first.id, expectedRevision: first.revision, changes: { status: 'complete' } });
    first = state.runs.find(run => run.id === first.id);
  });
  await check('Repeat copies setup and method and resets status, Notes and Data', async () => {
    const state = await api('records.repeatRun', { runId: first.id, date: '2026-09-09' });
    second = state.runs.find(run => run.id !== first.id);
    assert.equal(second.experimentId, first.experimentId); assert.equal(second.runNumber, 2); assert.equal(second.status, 'todo');
    assert.deepEqual(second.documents.information, first.documents.information);
    assert.deepEqual(second.documents.method, first.documents.method);
    assert.equal(JSON.stringify(second.documents.notes).includes('Observed'), false);
    assert.equal(JSON.stringify(second.documents.data).includes('Supporting'), false);
  });
  await check('Schemes and preferences persist with ordered, non-destructive membership', async () => {
    let state = await api('schemes.create', { notebookId: notebook.id, name: 'Comparison', description: 'Ordered runs' });
    scheme = state.schemes[0];
    state = await api('schemes.update', { id: scheme.id, expectedRevision: scheme.revision, runIds: [second.id, first.id] });
    scheme = state.schemes[0]; assert.deepEqual(scheme.runIds, [second.id, first.id]);
    state = await api('preferences.update', { appearance: 75, layout: 'tabs', directoryView: 'list', sort: 'number-asc' });
    assert.equal(state.preferences.appearance, 75);
  });
  await check('Native picker import preserves originals and previews actual CSV/XLSX/image files', async () => {
    const csv = path.join(root, 'measurements.csv');
    const png = path.join(root, 'observation.png');
    const xlsx = path.join(root, 'measurements.xlsx');
    const pdf = path.join(root, 'report.pdf');
    await writeFile(csv, 'Sample,Response\nα,1.25\nβ,2.5\n');
    await writeFile(png, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5XkAAAAASUVORK5CYII=', 'base64'));
    await writeFile(pdf, samplePdf());
    const workbook = new ExcelJS.Workbook(); workbook.addWorksheet('Data').addRows([['Sample', 'Response'], ['α', 1.25]]); await workbook.xlsx.writeFile(xlsx);
    await application.evaluate(({ dialog }, paths) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: paths }); }, [csv, png, xlsx, pdf]);
    const state = await api('attachments.import', { runId: first.id, jobId: 'acceptance-import' });
    assert.equal(state.attachments.length, 4);
    attachment = state.attachments.find(item => item.name.endsWith('.csv'));
    for (const item of state.attachments) {
      const preview = await api('attachments.preview', { id: item.id, jobId: `preview-${item.id}` });
      assert.equal(preview.kind, item.name.endsWith('.png') ? 'image' : item.name.endsWith('.pdf') ? 'pdf' : 'spreadsheet');
      if (preview.kind === 'spreadsheet') assert.match(JSON.stringify(preview.sheets), /1.25/);
    }
    assert.match(await readFile(csv, 'utf8'), /α,1.25/);
    const altered = await api('attachments.update', { id: attachment.id, caption: 'Actual imported measurements' });
    assert.equal(altered.attachments.find(item => item.id === attachment.id).caption, 'Actual imported measurements');
  });
  await check('All local export destinations create real files', async () => {
    for (const format of ['txt', 'md', 'html', 'rtf', 'docx']) {
      const destination = path.join(root, `export.${format}`);
      await application.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }); }, destination);
      const result = await api('exports.write', { scope: 'selected', notebookId: notebook.id, runIds: [first.id, second.id], format, order: 'scheme', schemeId: scheme.id, sections: ['method', 'information', 'notes', 'data'], data: 'previews', jobId: `export-${format}` });
      assert.equal(result.cancelled, false);
      const bytes = await readFile(destination); assert.ok(bytes.length > 20);
      if (format === 'docx') assert.equal(bytes.subarray(0, 2).toString(), 'PK');
      if (format === 'html') assert.match(bytes.toString(), /Procedure/);
      if (format === 'rtf' || format === 'docx') {
        const reopened = execFileSync('/usr/bin/textutil', ['-convert', 'txt', '-stdout', destination], { encoding: 'utf8', timeout: 20_000 });
        assert.match(reopened, /Procedure/);
        assert.match(reopened, /Purpose: α and H₂O/);
        assert.match(reopened, /Observed 1.25/);
      }
    }
  });
  await check('Trash restores records and permanent deletion does not reuse run numbers', async () => {
    let state = await api('records.snapshot'); second = state.runs.find(run => run.id === second.id);
    state = await api('trash.move', { kind: 'run', id: second.id, expectedRevision: second.revision });
    second = state.runs.find(run => run.id === second.id); assert.ok(second.trashedAt);
    state = await api('trash.restore', { kind: 'run', id: second.id, expectedRevision: second.revision });
    second = state.runs.find(run => run.id === second.id); assert.equal(second.trashedAt, null);
    state = await api('trash.move', { kind: 'run', id: second.id, expectedRevision: second.revision });
    second = state.runs.find(run => run.id === second.id);
    state = await api('trash.purge', { kind: 'run', id: second.id, expectedRevision: second.revision });
    assert.equal(state.runs.some(run => run.id === second.id), false);
    state = await api('records.repeatRun', { runId: first.id, date: '2026-09-10' });
    assert.equal(state.runs.find(run => run.id !== first.id).runNumber, 3);
  });
  await check('Reload renders the saved library and remembered appearance', async () => {
    await reload();
    await page.getByText('Acceptance notebook', { exact: true }).first().waitFor();
    await page.waitForFunction(() => document.documentElement.dataset.appearance === '75');
    await page.screenshot({ path: path.join(output, '02-persisted-directory.png') });
  });
  await check('PDF.js renders actual PDF pixels with local page controls', async () => {
    await page.locator('.notebook-card').first().click();
    await page.locator('.entry-list-item').first().click();
    await page.getByRole('tab', { name: 'Data', exact: true }).click();
    await page.locator('.attachment-card').filter({ hasText: 'report.pdf' }).click();
    const canvas = page.locator('.attachment-preview canvas');
    await canvas.waitFor({ state: 'visible' });
    await page.waitForFunction(() => {
      const canvas = document.querySelector('.attachment-preview canvas');
      if (!canvas || !canvas.width || !canvas.height) return false;
      const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
      for (let index = 0; index < data.length; index += 4) if (data[index + 3] > 0 && data[index] < 150 && data[index + 1] < 150 && data[index + 2] < 150) return true;
      return false;
    });
    await page.getByRole('button', { name: 'Next page', exact: true }).click();
    await page.waitForFunction(() => {
      const buttons = [...document.querySelectorAll('.attachment-preview button')];
      return buttons.some(button => button.getAttribute('aria-label') === 'Previous page' && !button.disabled);
    });
    assert.equal(await page.getByRole('button', { name: 'Previous page', exact: true }).isEnabled(), true);
    await page.screenshot({ path: path.join(output, '03-pdf-preview.png') });
    await page.keyboard.press('Escape');
  });
  await check('Application restart preserves records, documents, files, and preferences', async () => {
    await application.close(); application = undefined;
    await launch();
    const state = await api('records.snapshot');
    assert.equal(state.notebooks.length, 1); assert.equal(state.runs.length, 2); assert.equal(state.attachments.length, 4);
    assert.equal(state.preferences.appearance, 75); assert.equal(state.preferences.layout, 'tabs');
    assert.match(JSON.stringify(state.runs.find(run => run.id === first.id).documents), /Observed 1.25/);
    const preview = await api('attachments.preview', { id: attachment.id, jobId: 'after-restart' });
    assert.equal(preview.kind, 'spreadsheet');
    assert.deepEqual(externalRequests, []); assert.deepEqual(errors, []);
  });
  await check('Settings restore replaces open same-ID documents and reloads restored preferences', async () => {
    const Database = require('better-sqlite3');
    const { LibraryStore } = require('../electron/backend/store.cjs');
    const { createBackupService } = require('../electron/backend/backup.cjs');
    const fixtureRoot = path.join(root, 'restore-fixture');
    await mkdir(fixtureRoot);
    const source = new Database(path.join(library, 'library.sqlite'), { readonly: true });
    try { await source.backup(path.join(fixtureRoot, 'library.sqlite')); } finally { source.close(); }
    await cp(path.join(library, 'objects'), path.join(fixtureRoot, 'objects'), { recursive: true });
    const fixture = new LibraryStore(fixtureRoot);
    let archive;
    try {
      const run = fixture.snapshot().runs.find(item => item.id === first.id);
      assert.equal(fixture.dispatch('documents.save', { runId: run.id, expectedRevision: run.revision, documents: { ...run.documents, notes: doc('Restored same-ID notebook content β') } }).ok, true);
      assert.equal(fixture.dispatch('preferences.update', { appearance: 10, layout: 'continuous' }).ok, true);
      const created = await createBackupService(fixture).create({ password: 'Disposable restore password' });
      archive = path.join(fixtureRoot, 'backups', created.name);
    } finally { fixture.close(); }
    await page.locator('.notebook-card').first().click();
    await page.locator('.entry-list-item').filter({ hasText: `${first.label}-${first.experimentNumber}-${first.runNumber}` }).click();
    await page.getByRole('tab', { name: 'Notes', exact: true }).click();
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('tab', { name: 'Backups', exact: true }).click();
    await page.getByLabel('Restore password', { exact: true }).fill('Disposable restore password');
    await application.evaluate(({ dialog }, selected) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] });
      dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
    }, archive);
    await page.getByRole('button', { name: 'Restore backup…', exact: true }).click();
    await page.waitForFunction(() => document.documentElement.dataset.appearance === '10' && !document.querySelector('dialog') && Boolean(document.querySelector('.notebook-card')));
    const restored = await api('records.snapshot');
    assert.equal(restored.attachments.length, 4);
    assert.equal(restored.preferences.layout, 'continuous');
    await page.locator('.notebook-card').first().click();
    await page.locator('.entry-list-item').filter({ hasText: `${first.label}-${first.experimentNumber}-${first.runNumber}` }).click();
    await page.waitForFunction(() => document.querySelector('[aria-label="Notes editor"]')?.textContent === 'Restored same-ID notebook content β');
    assert.deepEqual(externalRequests, []); assert.deepEqual(errors, []);
    await page.screenshot({ path: path.join(output, '04-restored-editor.png') });
  });
  await writeFile(path.join(output, 'checks.json'), JSON.stringify({ checkedAt: new Date().toISOString(), packaged: Boolean(process.env.LABMATE_APP_BINARY), checks, errors, externalRequests }, null, 2));
  await Promise.all(['failure.json', 'failure.png'].map(name => rm(path.join(output, name), { force: true })));
  console.log(`Verified ${checks.length} functional checks.`);
} catch (error) {
  if (page && !page.isClosed()) await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
  await writeFile(path.join(output, 'failure.json'), JSON.stringify({ error: String(error), checks, errors, externalRequests }, null, 2));
  throw error;
} finally {
  if (application) await application.close().catch(() => {});
  await rm(root, { recursive: true, force: true });
}
