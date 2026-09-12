import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { _electron as electron } from 'playwright';

const root = await mkdtemp(path.join(os.tmpdir(), 'labmate-ui-'));
const output = path.resolve('artifacts/ui');
await mkdir(output, { recursive: true });
const checks = [], failures = [], externalRequests = [];
let application, page;
async function launch() {
  application = await electron.launch({
    ...(process.env.LABMATE_APP_BINARY ? { executablePath: process.env.LABMATE_APP_BINARY, args: [] } : { args: ['.'] }),
    env: { ...process.env, LABMATE_LIBRARY_ROOT: path.join(root, 'library'), LABMATE_TEST_PROFILE: path.join(root, 'profile') },
  });
  page = await application.firstWindow();
  page.on('pageerror', error => failures.push(error.message));
  page.on('request', request => { if (/^https?:/.test(request.url())) externalRequests.push(request.url()); });
  await page.getByRole('heading', { name: 'Lab notebooks', exact: true }).waitFor();
}
async function check(name, operation) { await operation(); checks.push(name); console.log(`PASS ${name}`); }
async function closePanel() { await page.keyboard.press('Escape'); await page.getByRole('dialog').waitFor({ state: 'detached' }); }
async function snapshot() { const result = await page.evaluate(() => window.labmate.records.snapshot()); assert.equal(result.ok, true); return result.value; }
async function shot(name) {
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true)))));
  const png = await application.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString('base64'));
  await writeFile(path.join(output, `${name}.png`), Buffer.from(png, 'base64'));
}
async function openSettings() { await page.getByRole('button', { name: 'Settings', exact: true }).click(); await page.getByRole('dialog', { name: 'Settings', exact: true }).waitFor(); }
const editor = label => page.locator(`[contenteditable="true"][aria-label="${label} editor"]`);
async function fillEditor(label, text) {
  const target = editor(label);
  await target.click();
  await target.press('Meta+A');
  await page.keyboard.insertText(text);
  await page.waitForFunction(({ label, text }) => document.querySelector(`[contenteditable="true"][aria-label="${label} editor"]`)?.textContent === text, { label, text });
}
let firstId;
try {
  await launch();
  await check('Real empty library and usable notebook creation form', async () => {
    assert.equal(await page.locator('.notebook-card').count(), 0);
    await page.getByRole('button', { name: 'New notebook', exact: true }).last().click();
    await page.getByLabel('Notebook name', { exact: true }).fill('UI acceptance notebook');
    await page.getByLabel('Description', { exact: true }).fill('Disposable native UI test');
    await shot('01-notebook-form');
    await page.getByRole('dialog').getByRole('button', { name: 'Create notebook', exact: true }).click();
    await page.getByRole('dialog').waitFor({ state: 'detached' });
    assert.equal((await snapshot()).notebooks.length, 1);
    await page.getByRole('button', { name: 'List view', exact: true }).click();
    await page.locator('.notebook-cards.list').waitFor();
    await page.getByRole('button', { name: 'Grid view', exact: true }).click();
    await shot('02-directory');
  });
  await check('Create an experiment through native app controls', async () => {
    await page.locator('.notebook-card').first().click();
    await page.getByRole('button', { name: 'New experiment', exact: true }).first().click();
    await page.getByLabel('Entry title', { exact: true }).fill('UI first run');
    await page.getByLabel('Experiment label', { exact: true }).fill('UI-test');
    await page.getByLabel('Author', { exact: true }).fill('UI tester');
    await page.getByRole('dialog').getByRole('button', { name: 'Create experiment', exact: true }).click();
    await page.getByRole('dialog').waitFor({ state: 'detached' });
    await page.locator('.entry-list-item').first().click();
    firstId = (await snapshot()).runs[0].id;
    await editor('Experimental information').waitFor();
  });
  await check('Rapid section edits retain every section before React renders again', async () => {
    await page.evaluate(() => {
      const labels = ['Experimental information', 'Method', 'Notes', 'Data'];
      for (let generation = 0; generation < 8; generation++) {
        for (const label of labels) {
          const target = document.querySelector(`[contenteditable="true"][aria-label="${label} editor"]`);
          target.focus();
          document.execCommand('selectAll', false);
          document.execCommand('insertText', false, `${label} rapid generation ${generation}`);
        }
      }
    });
    await page.getByRole('button', { name: 'Back to all notebooks', exact: true }).click();
    await page.locator('.notebook-card').first().waitFor();
    const run = (await snapshot()).runs.find(item => item.id === firstId);
    for (const section of ['information', 'method', 'notes', 'data']) assert.match(JSON.stringify(run.documents[section]), /rapid generation 7/);
    await page.locator('.notebook-card').first().click();
    await editor('Experimental information').waitFor();
  });
  await check('Rich editing saves all sections and flushes on immediate navigation', async () => {
    await fillEditor('Experimental information', 'Purpose from the editor α');
    await editor('Experimental information').press('Meta+A');
    await page.getByRole('button', { name: 'Link', exact: true }).click();
    await page.getByLabel('Link URL', { exact: true }).fill('https://example.com/labmate');
    await page.getByRole('button', { name: 'Apply link', exact: true }).click();
    await fillEditor('Method', 'Method copied on repeat');
    await editor('Method').press('Meta+A');
    await page.getByRole('button', { name: 'Bold', exact: true }).click();
    await fillEditor('Notes', 'Observed β, saved before navigating');
    await fillEditor('Data', 'Measured 1.25 units');
    await editor('Data').press('Meta+ArrowRight');
    await page.getByRole('button', { name: 'Table', exact: true }).click();
    await page.getByRole('button', { name: 'Insert table', exact: true }).click();
    await page.getByRole('button', { name: 'Back to all notebooks', exact: true }).click();
    await page.locator('.notebook-card').first().waitFor();
    const run = (await snapshot()).runs.find(item => item.id === firstId);
    assert.match(JSON.stringify(run.documents.information), /Purpose from the editor α/);
    assert.match(JSON.stringify(run.documents.information), /https:\/\/example.com\/labmate/);
    assert.match(JSON.stringify(run.documents.method), /"bold"/);
    assert.match(JSON.stringify(run.documents.notes), /Observed β/);
    assert.match(JSON.stringify(run.documents.data), /Measured 1.25/);
    assert.match(JSON.stringify(run.documents.data), /"table"/);
    await page.locator('.notebook-card').first().click();
    await shot('03-editor');
  });
  await check('Appearance and section tabs retain shared editor content', async () => {
    await openSettings();
    const slider = page.getByRole('slider', { name: 'Appearance', exact: true });
    await slider.focus(); await page.keyboard.press('End');
    await page.waitForFunction(() => document.documentElement.dataset.appearance === '100');
    await page.getByRole('radio', { name: /Section tabs/ }).check();
    await shot('04-settings-dark');
    await closePanel();
    await page.getByRole('tab', { name: 'Method', exact: true }).click();
    assert.match(await editor('Method').innerText(), /Method copied on repeat/);
    await page.getByRole('tab', { name: 'Method', exact: true }).focus();
    await page.keyboard.press('ArrowRight');
    assert.equal(await page.getByRole('tab', { name: 'Notes', exact: true }).getAttribute('aria-selected'), 'true');
    assert.match(await editor('Notes').innerText(), /Observed β/);
  });
  await check('Repeat run, working search, and numeric sorting', async () => {
    await page.getByRole('button', { name: 'Repeat experiment', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Create repeat run', exact: true }).click();
    await page.getByRole('dialog').waitFor({ state: 'detached' });
    const state = await snapshot(); assert.equal(state.runs.length, 2);
    const repeated = state.runs.find(item => item.id !== firstId);
    assert.equal(repeated.runNumber, 2);
    assert.equal(JSON.stringify(repeated.documents.notes).includes('Observed'), false);
    await page.getByRole('textbox', { name: 'Search entries', exact: true }).fill('Observed β');
    assert.equal(await page.locator('.entry-list-item').count(), 1);
    await page.getByRole('textbox', { name: 'Search entries', exact: true }).fill('');
    await page.getByRole('combobox', { name: 'Sort entries', exact: true }).selectOption('number-desc');
    assert.match(await page.locator('.entry-list-item').first().innerText(), /UI-test-1-2/);
    await page.getByRole('combobox', { name: 'Sort entries', exact: true }).selectOption('number-asc');
  });
  await check('Create ordered scheme membership with a keyboard alternative', async () => {
    await page.getByRole('button', { name: 'New scheme', exact: true }).click();
    await page.getByLabel('Scheme name', { exact: true }).fill('UI comparison');
    const repeatedId = (await snapshot()).runs.find(item => item.id !== firstId).id;
    await page.locator(`[data-scheme-run="${firstId}"] input`).check();
    await page.locator(`[data-scheme-run="${repeatedId}"] input`).check();
    await page.waitForFunction(() => document.querySelectorAll('.scheme-member.included').length === 2);
    await page.locator(`[data-scheme-run="${repeatedId}"]`).focus();
    await page.keyboard.press('Alt+ArrowUp');
    await page.waitForFunction(id => document.querySelector('.scheme-member')?.getAttribute('data-scheme-run') === id, repeatedId);
    await page.getByRole('dialog').getByRole('button', { name: 'Save scheme', exact: true }).click();
    await page.getByRole('dialog').waitFor({ state: 'detached' });
    const state = await snapshot();
    assert.equal(state.schemes.length, 1);
    assert.equal(state.schemes[0].runIds[1], firstId);
    await page.getByRole('button', { name: 'UI comparison', exact: true }).click();
    assert.match(await page.locator('.entry-list-item').first().innerText(), /UI-test-1-2/);
    await shot('05-scheme-dark');
  });
  await check('Metadata saves flush drafts and subsequent editing uses the current revision', async () => {
    await page.getByRole('tab', { name: 'Notes', exact: true }).click();
    await fillEditor('Notes', 'Draft before metadata update');
    await page.getByRole('button', { name: 'Edit metadata', exact: true }).click();
    await page.getByLabel('Author', { exact: true }).fill('Updated UI author');
    await page.getByRole('button', { name: 'Save changes', exact: true }).click();
    await page.getByRole('dialog').waitFor({ state: 'detached' });
    await fillEditor('Notes', 'Draft after metadata update');
    await page.getByRole('button', { name: 'Edit experiment label', exact: true }).click();
    await page.getByLabel('Experiment label', { exact: true }).fill('UI-renamed');
    await page.getByRole('button', { name: 'Save changes', exact: true }).click();
    await page.getByRole('dialog').waitFor({ state: 'detached' });
    await page.getByRole('button', { name: 'Back to all notebooks', exact: true }).click();
    await page.locator('.notebook-card').first().waitFor();
    const state = await snapshot();
    assert.equal(state.experiments[0].label, 'UI-renamed');
    assert.ok(state.runs.some(run => run.author === 'Updated UI author' && JSON.stringify(run.documents.notes).includes('Draft after metadata update')));
    await page.locator('.notebook-card').first().click();
  });
  await check('Parent Trash restoration preserves the real library', async () => {
    const before = await snapshot();
    page.once('dialog', dialog => dialog.accept());
    await page.getByRole('button', { name: 'Move notebook to Trash', exact: true }).click();
    await page.getByRole('heading', { name: 'Lab notebooks', exact: true }).waitFor();
    assert.equal(await page.locator('.notebook-card').count(), 0);
    await openSettings();
    await page.getByRole('tab', { name: 'Trash', exact: true }).click();
    await page.getByRole('button', { name: 'Restore', exact: true }).click();
    await page.getByText('Trash is empty', { exact: true }).waitFor();
    await closePanel();
    assert.equal((await snapshot()).runs.length, before.runs.length);
    assert.deepEqual((await snapshot()).runs, before.runs);
    await page.waitForFunction(() => document.documentElement.dataset.appearance === '100');
    await page.locator('.notebook-card').first().click();
    await page.getByRole('tab', { name: 'Notes', exact: true }).waitFor();
  });
  await check('Tracker status saves and keeps focus after moving a card', async () => {
    await page.getByRole('button', { name: 'Experiment tracker', exact: true }).click();
    assert.equal(await page.locator('.tracker-card').count(), 2);
    const control = page.locator(`#status-${firstId}`);
    await control.selectOption('complete');
    await page.waitForFunction(id => document.activeElement?.id === `status-${id}` && document.getElementById(`status-${id}`)?.value === 'complete', firstId);
    assert.equal((await snapshot()).runs.find(item => item.id === firstId).status, 'complete');
    await shot('06-tracker-dark');
  });
  await check('Backup and Trash controls distinguish configuration and deferred integrations', async () => {
    await openSettings();
    await page.getByRole('tab', { name: 'Backups', exact: true }).click();
    assert.equal(await page.getByRole('button', { name: 'Create first backup', exact: true }).isDisabled(), true);
    await page.getByLabel('Backup password', { exact: true }).waitFor();
    await shot('07-backup-setup');
    await page.getByRole('tab', { name: 'Trash', exact: true }).click();
    await page.getByText('Trash is empty', { exact: true }).waitFor();
    await closePanel();
  });
  await check('Small Mac window and zoom remain usable', async () => {
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1000, 700));
    await shot('08-tracker-small');
    const overflow = await page.evaluate(() => [...document.querySelectorAll('.app-shell,.tracker-main,.tracker-board,.tracker-column')].filter(item => item.scrollWidth > item.clientWidth + 1).map(item => item.className));
    assert.deepEqual(overflow, []);
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(1.1));
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), true);
    await shot('09-tracker-zoom');
    await application.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; window.webContents.setZoomFactor(1); window.setSize(1440, 960); });
  });
  await check('Normal application close flushes the final keystrokes and restart restores preferences', async () => {
    await page.locator('.tracker-entry-link').first().click();
    await page.getByRole('tab', { name: 'Notes', exact: true }).click();
    await fillEditor('Notes', 'Final keystrokes before normal close');
    await application.close(); application = undefined;
    await launch();
    const state = await snapshot();
    assert.equal(state.preferences.appearance, 100); assert.equal(state.preferences.layout, 'tabs');
    assert.ok(state.runs.some(item => JSON.stringify(item.documents.notes).includes('Final keystrokes before normal close')));
    await page.locator('.notebook-card').first().click();
    await page.getByRole('tab', { name: 'Notes', exact: true }).click();
    await shot('10-reopened-editor');
    assert.deepEqual(failures, []); assert.deepEqual(externalRequests, []);
  });
  await writeFile(path.join(output, 'checks.json'), JSON.stringify({ checkedAt: new Date().toISOString(), packaged: Boolean(process.env.LABMATE_APP_BINARY), checks, failures, externalRequests }, null, 2));
  await Promise.all(['failure.json', 'failure.png'].map(name => rm(path.join(output, name), { force: true })));
  console.log(`Verified ${checks.length} real user interface checks.`);
} catch (error) {
  if (page && !page.isClosed()) await shot('failure').catch(() => {});
  await writeFile(path.join(output, 'failure.json'), JSON.stringify({ error: String(error), checks, failures, externalRequests }, null, 2));
  throw error;
} finally {
  if (application) await application.close().catch(() => {});
  await rm(root, { recursive: true, force: true });
}
