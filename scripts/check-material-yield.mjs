import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { _electron as electron } from 'playwright';

// Real renderer, IPC, parser, and autosave in a disposable library. Capture
// Electron's clipboard write in this process so the user's clipboard is untouched.
const root = await mkdtemp(path.join(os.tmpdir(), 'labmate-material-yield-'));
const output = path.resolve('artifacts/material-yield');
await mkdir(output, { recursive: true });
const checks = [], errors = [];
let app, page, runId;
async function check(name, body) { console.log(`CHECK ${name}`); await body(); checks.push(name); console.log(`PASS ${name}`); }
const doc = text => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] });
try {
  app = await electron.launch({
    ...(process.env.LABMATE_APP_BINARY ? { executablePath: process.env.LABMATE_APP_BINARY, args: [] } : { args: ['.'] }),
    env: { ...process.env, LABMATE_LIBRARY_ROOT: path.join(root, 'library'), LABMATE_TEST_PROFILE: path.join(root, 'profile') },
  });
  await app.evaluate(({ clipboard }) => { clipboard.writeText = text => { globalThis.materialYieldCopiedText = text; }; });
  page = await app.firstWindow(); page.setDefaultTimeout(12000);
  page.on('pageerror', error => errors.push(error.message));
  await page.waitForFunction(() => Boolean(window.labmate));
  const api = async (method, input) => {
    const response = await page.evaluate(({ method, input }) => {
      const [group, name] = method.split('.'); return window.labmate[group][name](input);
    }, { method, input });
    assert.equal(response.ok, true, JSON.stringify(response)); return response.value;
  };
  let snapshot = await api('records.createNotebook', { name: 'Material yield checks', description: 'Disposable', discipline: 'Chemistry', color: 'sage' });
  snapshot = await api('records.createExperiment', { notebookId: snapshot.notebooks[0].id, label: 'Yield markup', title: 'Marked materials', date: '2026-09-09', author: 'Automated validation' });
  const run = snapshot.runs[0]; runId = run.id;
  await api('documents.save', { runId, expectedRevision: run.revision, documents: {
    information: doc('SUBSTRATE (0.2 g, 2  mmol, 2 eq.)'),
    method: doc('PRODUCT (75mg,750µmol,1equiv.)'),
    notes: doc('OTHER (1mL,1mmol,1eq.)'),
    data: doc('Unformatted isolated product'),
  } });
  await api('preferences.update', { layout: 'tabs' });
  const reopen = async () => {
    await page.reload(); await page.locator('.notebook-card').first().click(); await page.locator('.entry-list-item').first().click();
  };
  await reopen();
  const section = async (id, tabName) => {
    await page.getByRole('tab', { name: tabName, exact: true }).click();
    return page.locator(`#section-${id} .tiptap-content`);
  };
  const select = async (editor, text) => {
    await editor.evaluate((element, target) => {
      element.focus();
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      const nodes = []; let node; let total = '';
      while ((node = walker.nextNode())) { nodes.push({ node, offset: total.length }); total += node.textContent; }
      const start = total.indexOf(target); if (start < 0) throw new Error(`Selection not found: ${target}`);
      const end = start + target.length;
      const first = nodes.find(item => item.offset + item.node.textContent.length > start);
      const last = nodes.find(item => item.offset + item.node.textContent.length >= end);
      const range = document.createRange(); range.setStart(first.node, start - first.offset); range.setEnd(last.node, end - last.offset);
      const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
      document.dispatchEvent(new Event('selectionchange'));
    }, text);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  };
  const mark = role => page.getByRole('button', { name: role === 'starting' ? 'Mark as Starting Material' : 'Mark as Product', exact: true });
  const status = page.locator('.material-yield-status');
  const saved = async predicate => {
    const deadline = Date.now() + 12000;
    while (Date.now() < deadline) {
      const current = (await api('records.snapshot')).runs.find(item => item.id === runId);
      if (predicate(current.documents)) return current.documents;
      await new Promise(resolve => setTimeout(resolve, 75));
    }
    assert.fail('Material edits did not autosave within 12 seconds');
  };
  const copy = async () => {
    await app.evaluate(() => { globalThis.materialYieldCopiedText = undefined; });
    await page.getByRole('button', { name: 'Copy Yield', exact: true }).click();
    await page.getByText('Copied theoretical yield, actual yield and calculation basis.', { exact: true }).waitFor();
    return app.evaluate(() => globalThis.materialYieldCopiedText);
  };
  await check('Markup buttons have tooltips and marking is one undoable edit', async () => {
    const editor = page.locator('#section-information .tiptap-content');
    for (const name of ['Mark as Starting Material', 'Mark as Product', 'Copy Yield']) {
      assert.match(await page.getByRole('button', { name, exact: true }).getAttribute('title'), new RegExp(name));
    }
    await select(editor, 'SUBSTRATE (0.2 g, 2  mmol, 2 eq.)'); await mark('starting').click();
    assert.equal(await editor.locator('[data-yield-material="starting"]').count(), 1);
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    assert.equal(await editor.locator('[data-yield-material]').count(), 0);
    assert.match(await editor.innerText(), /SUBSTRATE/);
    await page.getByRole('button', { name: 'Redo', exact: true }).click();
    assert.equal(await editor.locator('[data-yield-material="starting"]').count(), 1);
  });
  await check('Mixed spacing and units calculate across sections and copy theoretical plus actual yield', async () => {
    const editor = await section('method', 'Method');
    await select(editor, 'PRODUCT (75mg,750µmol,1equiv.)'); await mark('product').click();
    await page.getByText('75% yield', { exact: true }).waitFor();
    assert.match(await status.innerText(), /Theoretical: 1000 µmol/);
    const text = await copy();
    assert.match(text, /Theoretical yield: 1000 µmol \(100%\)/);
    assert.match(text, /Actual yield: 75 mg; 750 µmol \(75%\)/);
    assert.match(text, /Basis: 2 mmol × 1 ÷ 2/);
    await saved(documents => JSON.stringify(documents.information).includes('yieldMaterial') && JSON.stringify(documents.method).includes('yieldMaterial'));
    await reopen(); await section('method', 'Method');
    await page.getByText('75% yield', { exact: true }).waitFor();
    assert.equal(await page.locator('[data-yield-material="starting"]').count(), 1);
    assert.equal(await page.locator('[data-yield-material="product"]').count(), 1);
  });
  await check('Text edits recalculate and duplicate role marks are rejected', async () => {
    const editor = await section('method', 'Method');
    await select(editor, '750'); await page.keyboard.insertText('500');
    await page.getByText('50% yield', { exact: true }).waitFor();
    assert.match(await copy(), /Actual yield: 75 mg; 500 µmol \(50%\)/);
    const notes = await section('notes', 'Notes');
    await select(notes, 'OTHER (1mL,1mmol,1eq.)'); await mark('starting').click();
    assert.equal(await notes.locator('[data-yield-material]').count(), 0);
    assert.match(await status.innerText(), /already marked/);
  });
  await check('Invalid selection opens manual entry; invalid inputs remain visible and valid inputs persist', async () => {
    const method = await section('method', 'Method');
    await method.locator('[data-yield-material="product"]').click(); await mark('product').click();
    assert.equal(await method.locator('[data-yield-material]').count(), 0);
    const data = await section('data', 'Data');
    await select(data, 'Unformatted isolated product'); await mark('product').click();
    const dialog = page.getByRole('dialog', { name: 'Enter material amounts', exact: true }); await dialog.waitFor();
    await dialog.getByLabel('Material label', { exact: true }).fill('Manual product');
    await dialog.getByLabel('Molar amount', { exact: true }).fill('bad');
    await dialog.getByLabel('Equivalents', { exact: true }).fill('0');
    await dialog.getByRole('button', { name: 'Save material amounts', exact: true }).click();
    assert.equal(await dialog.isVisible(), true);
    assert.ok((await dialog.getByRole('alert').innerText()).length > 0);
    await dialog.getByLabel('Molar amount', { exact: true }).fill('5e2');
    await dialog.getByRole('combobox', { name: /Molar unit/ }).selectOption('µmol');
    await dialog.getByLabel('Equivalents', { exact: true }).fill('1');
    await dialog.getByRole('button', { name: 'Save material amounts', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' }); await page.getByText('50% yield', { exact: true }).waitFor();
    assert.match(await copy(), /Actual yield:.*5e2 µmol \(50%\)/);
    await saved(documents => JSON.stringify(documents.data).includes('sourceText'));
    await reopen(); await section('data', 'Data');
    await page.getByText('50% yield', { exact: true }).waitFor();
    assert.equal(await page.locator('#section-data [data-yield-material="product"]').count(), 1);
  });
  await check('Editing manually supplied material invalidates its override and Copy Yield opens repair', async () => {
    const editor = await section('data', 'Data');
    await select(editor, 'isolated'); await page.keyboard.insertText('purified');
    assert.equal(await page.getByText('50% yield', { exact: true }).count(), 0);
    await section('notes', 'Notes');
    await page.getByRole('button', { name: 'Copy Yield', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Enter material amounts', exact: true }); await dialog.waitFor();
    await page.setViewportSize({ width: 600, height: 850 });
    await dialog.screenshot({ path: path.join(output, 'manual-entry-narrow.png') });
    const geometry = await dialog.evaluate(element => ({ width: element.getBoundingClientRect().width, viewport: innerWidth, overflow: element.scrollWidth > element.clientWidth }));
    assert.ok(geometry.width < geometry.viewport && !geometry.overflow, JSON.stringify(geometry));
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    assert.equal(await page.getByText('50% yield', { exact: true }).count(), 0);
    await page.getByRole('button', { name: 'Copy Yield', exact: true }).click();
    await dialog.getByLabel('Molar amount', { exact: true }).fill('600');
    await dialog.getByRole('combobox', { name: /Molar unit/ }).selectOption('µmol');
    await dialog.getByLabel('Equivalents', { exact: true }).fill('1');
    await dialog.getByRole('button', { name: 'Save material amounts', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    await page.getByText('60% yield', { exact: true }).waitFor();
    await page.getByText('Copied theoretical yield, actual yield and calculation basis.', { exact: true }).waitFor();
    assert.match(await app.evaluate(() => globalThis.materialYieldCopiedText), /Actual yield:.*600 µmol \(60%\)/);
    await saved(documents => JSON.stringify(documents.data).includes('600'));
    await api('preferences.update', { layout: 'continuous' });
    await reopen(); await page.getByText('60% yield', { exact: true }).waitFor();
    await page.setViewportSize({ width: 1100, height: 900 });
    await page.screenshot({ path: path.join(output, 'marked-yield.png') });
  });
  await check('Pasted malformed manual markup is plain text and does not create an invalid saved highlight', async () => {
    const editor = page.locator('#section-notes .tiptap-content');
    await editor.evaluate(element => {
      element.focus();
      const range = document.createRange(); range.selectNodeContents(element); range.collapse(false);
      const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
      document.dispatchEvent(new Event('selectionchange'));
    });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await editor.evaluate(element => {
      const data = new DataTransfer();
      data.setData('text/html', '<p><span data-yield-material="product" data-yield-id="bad-html" data-yield-manual="false">PASTED (1 g,1 mmol,1 eq.)</span></p>');
      data.setData('text/plain', 'PASTED (1 g,1 mmol,1 eq.)');
      element.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
    });
    assert.match(await editor.innerText(), /PASTED/);
    assert.equal(await editor.locator('[data-yield-material]').count(), 0);
    await saved(documents => JSON.stringify(documents.notes).includes('PASTED') && !JSON.stringify(documents.notes).includes('yieldMaterial'));
    await page.getByText('60% yield', { exact: true }).waitFor();
  });
  await check('A reopened manually entered highlight spanning bold text removes as one mark and Undo restores it', async () => {
    const editor = page.locator('#section-data .tiptap-content');
    await editor.scrollIntoViewIfNeeded();
    await select(editor, 'purified'); await page.getByRole('button', { name: 'Bold', exact: true }).click();
    await saved(documents => JSON.stringify(documents.data).includes('bold'));
    await reopen(); await editor.scrollIntoViewIfNeeded();
    assert.ok(await editor.locator('[data-yield-material="product"]').count() >= 2);
    await editor.locator('strong').click(); await mark('product').click();
    assert.equal(await editor.locator('[data-yield-material="product"]').count(), 0);
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    assert.ok(await editor.locator('[data-yield-material="product"]').count() >= 2);
    await page.getByText('60% yield', { exact: true }).waitFor();
    assert.equal((await editor.locator('[data-yield-material="product"]').allTextContents()).join(''), 'Unformatted purified product');
  });
  assert.deepEqual(errors, []);
  await writeFile(path.join(output, 'checks.json'), JSON.stringify({ packaged: Boolean(process.env.LABMATE_APP_BINARY), checks, errors, clipboard: 'Writes captured in disposable Electron process; system clipboard unchanged.' }, null, 2));
  console.log(`PASS ${checks.length} material yield UI checks`);
} catch (error) {
  if (page) console.error(await page.locator('body').innerText({ timeout: 1000 }).catch(() => 'Window unavailable'));
  throw error;
} finally {
  if (app) await app.close();
  await rm(root, { recursive: true, force: true });
}
