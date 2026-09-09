import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { _electron as electron } from 'playwright';

const output = path.resolve('artifacts/ui');
await mkdir(output, { recursive: true });
const application = await electron.launch(process.env.ELB_APP_BINARY
  ? { executablePath: process.env.ELB_APP_BINARY, args: [] }
  : { args: ['.'] });
const page = await application.firstWindow();
const failures = [];
const externalRequests = [];
page.on('pageerror', error => failures.push(error.message));
page.on('request', request => { if (/^https?:/.test(request.url())) externalRequests.push(request.url()); });
const checks = [];
async function check(name, fn) { await fn(); checks.push(name); console.log(`PASS ${name}`); }
async function visible(locator) { await locator.waitFor({ state: 'visible' }); }
async function closePanel() { await page.keyboard.press('Escape'); await page.getByRole('dialog').waitFor({ state: 'detached' }); }
async function screenshot(name) { await page.screenshot({ path: path.join(output, `${name}.png`) }); }

try {
  await check('Directory renders with three notebooks', async () => {
    await visible(page.getByRole('heading', { name: 'Lab notebooks', exact: true }));
    assert.equal(await page.locator('.notebook-card').count(), 3);
    await screenshot('01-directory');
  });
  await check('Directory view and notebook form', async () => {
    await page.getByRole('button', { name: 'List view', exact: true }).click();
    await visible(page.locator('.notebook-cards.list'));
    await page.getByRole('button', { name: 'Grid view', exact: true }).click();
    await page.getByRole('button', { name: 'New notebook', exact: true }).last().click();
    await visible(page.getByRole('dialog', { name: 'New notebook', exact: true }));
    assert.equal(await page.getByRole('button', { name: 'Create notebook Planned' }).isDisabled(), true);
    await page.getByLabel('Notebook name', { exact: true }).fill('Temporary field value');
    await screenshot('02-notebook-form');
    await closePanel();
    assert.equal(await page.locator('.notebook-card').count(), 3);
  });
  await check('Notebook and entry selection', async () => {
    await page.locator('.notebook-card').first().click();
    await visible(page.getByRole('heading', { name: 'Catalyst loading study', exact: true }));
    await screenshot('03-notebook');
    await page.locator('.entry-list-item').filter({ hasText: 'Catalyst loading baseline' }).click();
    await visible(page.getByRole('heading', { name: 'Catalyst loading baseline', exact: true }));
    await page.locator('.entry-list-item').filter({ hasText: 'Catalyst loading study' }).click();
    assert.equal(await page.getByRole('button', { name: 'Bold — planned', exact: true }).isDisabled(), true);
    assert.equal(await page.getByRole('textbox', { name: 'Search entries — planned', exact: true }).isDisabled(), true);
  });
  await check('Sort choices and overlapping scheme navigation', async () => {
    const sort = page.getByRole('combobox', { name: 'Sort entries', exact: true });
    for (const value of ['oldest', 'az', 'za', 'number-asc', 'number-desc', 'newest']) {
      await sort.selectOption(value); assert.equal(await sort.inputValue(), value);
    }
    await page.getByRole('button', { name: 'Loading comparison', exact: true }).click();
    assert.equal(await page.locator('.entry-list-item').count(), 2);
    await visible(page.getByRole('heading', { name: 'Catalyst loading baseline', exact: true }));
    await screenshot('04-scheme');
    await page.getByRole('button', { name: 'Route A · development', exact: true }).click();
    assert.equal(await page.locator('.entry-list-item').count(), 4);
    await page.locator('.entry-list-item').filter({ hasText: 'Catalyst loading study' }).click();
  });
  await check('New and repeat experiment forms are presentation only', async () => {
    for (const name of ['New experiment', 'Repeat experiment']) {
      await page.getByRole('button', { name, exact: true }).click();
      await visible(page.getByRole('dialog', { name, exact: true }));
      assert.equal(await page.getByRole('dialog').locator('button[type="submit"], button.button-primary').last().isDisabled(), true);
      await closePanel();
    }
    assert.equal(await page.locator('.entry-list-item').count(), 4);
  });
  await check('Settings changes entry layout and restores dialog focus', async () => {
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await screenshot('05-settings');
    await page.getByRole('radio', { name: /Section tabs/ }).check();
    await page.getByRole('button', { name: 'Done', exact: true }).click();
    assert.equal(await page.evaluate(() => document.activeElement?.textContent), 'Settings');
    await visible(page.getByRole('tablist', { name: 'Entry sections' }));
    await page.getByRole('tab', { name: 'Information', exact: true }).focus();
    await page.keyboard.press('ArrowRight');
    assert.equal(await page.getByRole('tab', { name: 'Method', exact: true }).getAttribute('aria-selected'), 'true');
    await page.keyboard.press('End');
    assert.equal(await page.getByRole('tab', { name: 'Data', exact: true }).getAttribute('aria-selected'), 'true');
    await page.getByRole('tab', { name: 'Method', exact: true }).click();
    assert.equal(await page.getByRole('tabpanel').count(), 1);
    await visible(page.getByRole('heading', { name: 'Procedure', exact: true }));
    await screenshot('06-method-tabs');
    await page.getByRole('tab', { name: 'Notes', exact: true }).click();
    assert.equal(await page.getByRole('button', { name: 'Dictate Planned', exact: true }).isDisabled(), true);
    await page.getByRole('tab', { name: 'Data', exact: true }).click();
    await screenshot('07-data-tabs');
  });
  await check('All four attachment detail panels', async () => {
    for (const kind of ['image', 'pdf', 'spreadsheet', 'scientific']) {
      await page.locator('.attachment-card').filter({ has: page.locator(`.file-icon.${kind}`) }).click();
      await visible(page.getByRole('dialog', { name: 'Attachment details' }));
      await visible(page.locator(`.preview-${kind}`));
      if (kind === 'scientific') await visible(page.getByRole('heading', { name: 'Preview support planned' }));
      await screenshot(`08-attachment-${kind}`);
      await closePanel();
    }
  });
  await check('Citation details switch without a connection', async () => {
    await page.getByRole('button', { name: 'Open citation library', exact: true }).click();
    await visible(page.getByRole('dialog', { name: 'Citation library' }));
    assert.equal(await page.getByRole('button', { name: 'Connect Planned' }).isDisabled(), true);
    await page.locator('.citation-list button').last().click();
    await visible(page.locator('.citation-details h3').filter({ hasText: 'Calibration strategies' }));
    await screenshot('09-citations');
    await closePanel();
  });
  await check('Single-entry and batch export options', async () => {
    await page.getByRole('button', { name: 'Export entry', exact: true }).click();
    await visible(page.getByRole('dialog', { name: 'Export options' }));
    assert.equal(await page.getByLabel('Export scope', { exact: true }).inputValue(), 'entry');
    assert.equal(await page.getByLabel('Entry ordering', { exact: true }).count(), 0);
    for (const format of ['txt', 'md', 'html', 'rtf', 'docx', 'google']) await page.getByLabel('Format', { exact: true }).selectOption(format);
    await visible(page.getByText('Google Docs is a future connected destination.', { exact: false }));
    await page.getByLabel('Export scope', { exact: true }).selectOption('selected');
    assert.equal(await page.locator('.entry-checkboxes input').count(), 4);
    await page.getByLabel('Entry ordering', { exact: true }).selectOption('scheme');
    await visible(page.getByLabel('Scheme', { exact: true }));
    await page.getByRole('button', { name: 'Move Method up', exact: true }).click();
    assert.match(await page.locator('.export-section-row').first().innerText(), /Method/);
    await page.getByLabel('Data inclusion', { exact: true }).selectOption('previews');
    assert.equal(await page.getByRole('button', { name: 'Export Planned', exact: true }).isDisabled(), true);
    await screenshot('10-export-options');
    await closePanel();
    await page.getByRole('button', { name: 'Export notebook', exact: true }).click();
    assert.equal(await page.getByLabel('Export scope', { exact: true }).inputValue(), 'notebook');
    await closePanel();
    await page.getByRole('button', { name: 'Export selected entries', exact: true }).click();
    assert.equal(await page.getByLabel('Export scope', { exact: true }).inputValue(), 'selected');
    await closePanel();
  });
  await check('Layout carries across notebooks and empty data is readable', async () => {
    await page.getByRole('button', { name: 'Functional materials', exact: true }).click();
    await visible(page.getByRole('heading', { name: 'Polymer film repeat', exact: true }));
    await visible(page.getByRole('tablist'));
    await page.getByRole('button', { name: 'Analytical methods', exact: true }).click();
    await visible(page.getByRole('heading', { name: 'Calibration series', exact: true }));
    await page.getByRole('button', { name: 'Catalysis & synthesis', exact: true }).click();
    await page.locator('.entry-list-item').filter({ hasText: 'Initial reaction survey' }).click();
    await page.getByRole('tab', { name: 'Data', exact: true }).click();
    await visible(page.getByText('No sample attachments', { exact: true }));
  });
  await check('Minimum Mac window size and continuous jump links', async () => {
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1000, 700));
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('radio', { name: /Continuous page/ }).check();
    await closePanel();
    await page.locator('.entry-list-item').filter({ hasText: 'Catalyst loading study' }).click();
    await page.getByRole('button', { name: 'Data', exact: true }).click();
    await visible(page.locator('#heading-data'));
    await page.waitForFunction(() => {
      const heading = document.getElementById('heading-data').getBoundingClientRect();
      const viewport = document.querySelector('.entry-scroll').getBoundingClientRect();
      return heading.top >= viewport.top && heading.top < viewport.top + 100;
    });
    await screenshot('11-small-window');
    const overflows = await page.evaluate(() => [...document.querySelectorAll('.app-shell, .entry-workspace, .entry-document, .sidebar')].filter(element => element.scrollWidth > element.clientWidth + 1).map(element => element.className));
    assert.deepEqual(overflows, []);
    await page.getByRole('button', { name: 'Back to all notebooks', exact: true }).click();
    await screenshot('12-small-directory');
    assert.equal(await page.evaluate(() => document.querySelector('.directory-content').scrollWidth > document.querySelector('.directory-content').clientWidth + 1), false);
  });
  await check('Sandbox, session-only state, and offline content', async () => {
    const preferences = await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences());
    assert.equal(preferences.nodeIntegration, false);
    assert.equal(preferences.contextIsolation, true);
    assert.equal(preferences.sandbox, true);
    assert.equal(await page.evaluate(() => typeof window.require), 'undefined');
    assert.equal(await page.evaluate(() => localStorage.length), 0);
    assert.deepEqual(externalRequests, []);
    await page.reload();
    await visible(page.getByRole('heading', { name: 'Lab notebooks', exact: true }));
    await page.locator('.notebook-card').first().click();
    assert.equal(await page.getByRole('tablist').count(), 0);
    assert.deepEqual(failures, []);
  });
  await writeFile(path.join(output, 'checks.json'), JSON.stringify({ checkedAt: new Date().toISOString(), packaged: Boolean(process.env.ELB_APP_BINARY), checks, failures, externalRequests }, null, 2));
  console.log(`Verified ${checks.length} interface checks. Screenshots: ${output}`);
} catch (error) {
  await screenshot('failure');
  console.error('Renderer errors:', failures);
  throw error;
} finally {
  await application.close();
}
