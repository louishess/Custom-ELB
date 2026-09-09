import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { _electron as electron } from 'playwright';

const output = path.resolve('artifacts/ui');
await mkdir(output, { recursive: true });
const application = await electron.launch(process.env.LABMATE_APP_BINARY
  ? { executablePath: process.env.LABMATE_APP_BINARY, args: [] }
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

async function setAppearance(value) {
  await page.getByRole('button', { name: 'Adjust appearance', exact: true }).click();
  await page.getByRole('slider', { name: 'Appearance', exact: true }).evaluate((input, next) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, String(next));
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }, value);
  assert.equal(await page.locator('html').getAttribute('data-appearance'), String(value));
  await closePanel();
}


try {
  await check('Directory renders with three notebooks', async () => {
    assert.equal(await page.title(), 'LabMate');
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
  await check('Appearance continuum across pages and dialogs', async () => {
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 960));
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('slider', { name: 'Appearance', exact: true }).focus();
    await page.keyboard.press('End');
    assert.equal(await page.locator('html').getAttribute('data-appearance'), '100');
    assert.equal(await page.getByRole('dialog').evaluate(element => getComputedStyle(element).backgroundColor), 'rgb(40, 53, 49)');
    await screenshot('13-dark-settings');
    await closePanel();
    await screenshot('14-dark-directory');

    const colors = [];
    for (const amount of [0, 25, 50, 75, 100]) {
      await setAppearance(amount);
      colors.push(await page.locator('html').evaluate(element => getComputedStyle(element).getPropertyValue('--canvas')));
      await screenshot(`appearance-${amount}`);
    }
    assert.equal(new Set(colors).size, 5);
    await page.getByRole('button', { name: 'Adjust appearance', exact: true }).click();
    await page.getByRole('slider', { name: 'Appearance', exact: true }).focus();
    await page.keyboard.press('Home');
    await page.keyboard.press('ArrowRight');
    assert.equal(await page.locator('html').getAttribute('data-appearance'), '1');
    await page.keyboard.press('End');
    await closePanel();

    await page.locator('.notebook-card').first().click();
    assert.equal(await page.locator('html').getAttribute('data-appearance'), '100');
    await screenshot('15-dark-notebook');
    await page.getByRole('button', { name: 'Open citation library', exact: true }).click();
    await screenshot('16-dark-citations');
    await closePanel();
    await page.getByRole('button', { name: 'Export entry', exact: true }).click();
    await screenshot('17-dark-export');
    await closePanel();
    await setAppearance(0);
    assert.equal(await page.locator('html').getAttribute('data-appearance'), '0');
  });
  await check('Organization tracker, status changes, filtering, and entry links', async () => {
    await page.getByRole('button', { name: 'Experiment tracker', exact: true }).click();
    await visible(page.getByRole('heading', { name: 'Experiment tracker', exact: true }));
    for (const status of ['To-Do', 'In Progress', 'Complete']) await visible(page.getByRole('heading', { name: status, exact: true }));
    assert.equal(await page.locator('.tracker-card').count(), 7);
    assert.equal(await page.locator('.tracker-column.todo .tracker-card').count(), 2);
    assert.equal(await page.locator('.tracker-column.progress .tracker-card').count(), 2);
    assert.equal(await page.locator('.tracker-column.complete .tracker-card').count(), 3);
    await screenshot('18-tracker-light');
    await page.getByLabel('Status for Solvent comparison', { exact: true }).selectOption('complete');
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'status-cat-11-1');
    assert.equal(await page.locator('.tracker-column.complete .tracker-card').count(), 4);
    await visible(page.locator('.tracker-summary').getByText('4 of 7 sample experiments complete.', { exact: false }));
    await setAppearance(100);
    await screenshot('19-tracker-dark');
    await page.getByLabel('Filter tracker by notebook', { exact: true }).selectOption('materials');
    assert.equal(await page.locator('.tracker-card').count(), 2);
    await visible(page.locator('.tracker-column.todo .tracker-empty'));
    await page.getByRole('button', { name: 'Polymer film repeat', exact: true }).click();
    await visible(page.getByRole('heading', { name: 'Polymer film repeat', exact: true }));
    assert.equal(await page.locator('html').getAttribute('data-appearance'), '100');
    await page.getByRole('button', { name: 'Experiment tracker', exact: true }).click();
    assert.equal(await page.getByLabel('Status for Solvent comparison', { exact: true }).inputValue(), 'complete');
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1000, 700));
    await screenshot('20-tracker-small-dark');
    const overflows = await page.evaluate(() => [...document.querySelectorAll('.tracker-main, .tracker-content, .tracker-board, .tracker-column')].filter(element => element.scrollWidth > element.clientWidth + 1).map(element => element.className));
    assert.deepEqual(overflows, []);
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
    assert.equal(await page.locator('html').getAttribute('data-appearance'), '0');
    await page.getByRole('button', { name: 'Experiment tracker', exact: true }).click();
    assert.equal(await page.getByLabel('Status for Solvent comparison', { exact: true }).inputValue(), 'todo');
    await page.getByRole('button', { name: 'LabMate home', exact: true }).click();
    await page.locator('.notebook-card').first().click();
    assert.equal(await page.getByRole('tablist').count(), 0);
    assert.deepEqual(failures, []);
  });
  await writeFile(path.join(output, 'checks.json'), JSON.stringify({ checkedAt: new Date().toISOString(), packaged: Boolean(process.env.LABMATE_APP_BINARY), checks, failures, externalRequests }, null, 2));
  console.log(`Verified ${checks.length} interface checks. Screenshots: ${output}`);
} catch (error) {
  await screenshot('failure');
  console.error('Renderer errors:', failures);
  throw error;
} finally {
  await application.close();
}
