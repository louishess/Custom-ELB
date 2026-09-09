import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { _electron as electron } from 'playwright';

// Uses a disposable library only. Build the renderer before running this check.
const root = await mkdtemp(path.join(os.tmpdir(), 'labmate-tables-'));
const screenshots = path.resolve('artifacts/tables');
const screenshotLabel = process.env.LABMATE_TABLE_SCREENSHOT_LABEL === 'before' ? 'before' : 'after';
await mkdir(screenshots, { recursive: true });
let application;
try {
  application = await electron.launch({
    ...(process.env.LABMATE_APP_BINARY ? { executablePath: process.env.LABMATE_APP_BINARY, args: [] } : { args: ['.'] }),
    env: { ...process.env, LABMATE_LIBRARY_ROOT: path.join(root, 'library'), LABMATE_TEST_PROFILE: path.join(root, 'profile') },
  });
  const page = await application.firstWindow();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.waitForFunction(() => Boolean(window.labmate));
  const api = async (method, input) => {
    const result = await page.evaluate(async ({ method, input }) => {
      const [group, name] = method.split('.');
      return window.labmate[group][name](input);
    }, { method, input });
    assert.equal(result.ok, true, JSON.stringify(result));
    return result.value;
  };
  const waitForSavedColumnWidth = async (runId, expectedWidth) => {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const saved = await api('records.snapshot');
      const savedDocument = saved.runs.find(run => run.id === runId)?.documents.information;
      const savedTable = savedDocument?.content?.find(node => node.type === 'table');
      if (savedTable?.content?.[0]?.content?.[0]?.attrs?.colwidth?.join(',') === expectedWidth) return;
      await delay(100);
    }
    assert.fail(`Table column width ${expectedWidth} did not reach the persisted document within 15 seconds`);
  };
  let state = await api('records.createNotebook', { name: 'Table checks', description: '', discipline: '', color: 'sage' });
  state = await api('records.createExperiment', { notebookId: state.notebooks[0].id, label: 'Test', title: 'Table editing', date: '2026-09-09', author: 'Table validation' });
  const runId = state.runs[0].id;
  await api('preferences.update', { layout: 'tabs' });
  await page.reload();
  await page.locator('.notebook-card').first().click();
  await page.locator('.entry-list-item').first().click();
  const editor = page.locator('#section-information .tiptap-content');
  await editor.click();
  await page.getByRole('button', { name: 'Table', exact: true }).click();
  await page.locator('.table-insert-dialog').screenshot({ path: path.join(screenshots, `insert-table-${screenshotLabel}.png`) });
  if (screenshotLabel !== 'before') {
    const geometry = await page.locator('.table-insert-dialog').evaluate(dialog => {
      const body = dialog.querySelector('.modal-body');
      const footer = dialog.querySelector('.modal-footer');
      const input = dialog.querySelector('input');
      return { width: dialog.getBoundingClientRect().width, bodyPadding: parseFloat(getComputedStyle(body).paddingLeft), footerPadding: parseFloat(getComputedStyle(footer).paddingRight), inputHeight: input.getBoundingClientRect().height, overflow: dialog.scrollWidth > dialog.clientWidth };
    });
    assert.ok(geometry.width >= 500 && geometry.width <= 520, JSON.stringify(geometry));
    assert.ok(geometry.bodyPadding >= 24 && geometry.footerPadding >= 24, JSON.stringify(geometry));
    assert.ok(geometry.inputHeight >= 42 && !geometry.overflow, JSON.stringify(geometry));
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('.table-insert-dialog').count(), 0);
    assert.equal(await page.getByRole('button', { name: 'Table', exact: true }).evaluate(button => button === document.activeElement), true);
    await page.keyboard.press('Enter');
    await page.getByRole('spinbutton', { name: 'Rows', exact: true }).waitFor();
  }
  await page.getByRole('spinbutton', { name: 'Rows', exact: true }).fill('3');
  await page.getByRole('spinbutton', { name: 'Columns', exact: true }).fill('4');
  await page.getByRole('button', { name: 'Insert table', exact: true }).click();
  const table = editor.locator('table');
  assert.equal(await table.locator('tr').count(), 3);
  assert.equal(await table.locator('th').count(), 4);
  await table.locator('th').first().click();
  await page.getByRole('button', { name: 'Row below', exact: true }).click();
  assert.equal(await table.locator('tr').count(), 4);
  await page.getByRole('button', { name: 'Column after', exact: true }).click();
  assert.equal(await table.locator('tr').first().locator('th,td').count(), 5);
  await page.getByRole('button', { name: 'Remove column', exact: true }).click();
  await page.getByRole('button', { name: 'Remove row', exact: true }).click();
  assert.equal(await table.locator('tr').count(), 3);
  assert.equal(await table.locator('tr').first().locator('th,td').count(), 4);
  await page.getByRole('button', { name: 'Row above', exact: true }).click();
  assert.equal(await table.locator('tr').count(), 4);
  await page.getByRole('button', { name: 'Remove row', exact: true }).click();
  await page.getByRole('button', { name: 'Column before', exact: true }).click();
  assert.equal(await table.locator('tr').first().locator('th,td').count(), 5);
  await page.getByRole('button', { name: 'Remove column', exact: true }).click();
  await table.locator('tr').first().locator('th,td').first().click();
  const headersBefore = await table.locator('th').count();
  await page.getByRole('button', { name: 'Toggle header row', exact: true }).click();
  assert.equal(await table.locator('th').count(), headersBefore ? 0 : 4);
  if (headersBefore) await page.getByRole('button', { name: 'Toggle header row', exact: true }).click();
  await page.getByRole('button', { name: 'Toggle header column', exact: true }).click();
  assert.ok(await table.locator('th').count() > 4);
  await page.getByRole('button', { name: 'Toggle header column', exact: true }).click();
  if (await table.locator('tr').first().locator('th').count() < 4) {
    // Tiptap toggles the selected column, including its header cell.
    await table.locator('tr').first().locator('td').first().click();
    await page.getByRole('button', { name: 'Toggle header row', exact: true }).click();
    await page.getByRole('button', { name: 'Toggle header row', exact: true }).click();
  }
  await table.locator('th').first().click();
  await table.locator('th').nth(1).click({ modifiers: ['Shift'] });
  await page.getByRole('button', { name: 'Merge cells', exact: true }).click();
  assert.equal(await table.locator('[colspan="2"]').count(), 1);
  await page.getByRole('button', { name: 'Fit columns to editor', exact: true }).click();
  let widths = await table.locator('tr').first().locator('th').evaluateAll(cells => cells.map(cell => cell.getAttribute('colwidth')));
  assert.ok(widths.every(width => width && Number(width.split(',')[0]) >= 60));
  assert.equal(widths[0].split(',').length, 2);
  await page.getByRole('button', { name: 'Split cell', exact: true }).click();
  assert.equal(await table.locator('th').count(), 4);
  const firstCell = table.locator('th').first();
  const before = await firstCell.boundingBox();
  await page.mouse.move(before.x + before.width - 1, before.y + before.height / 2);
  await page.waitForFunction(() => document.querySelector('.tiptap-content.resize-cursor'));
  assert.equal(await firstCell.evaluate(cell => getComputedStyle(cell).position), 'relative');
  await page.mouse.down();
  await page.mouse.move(before.x + before.width + 39, before.y + before.height / 2, { steps: 8 });
  await page.mouse.up();
  const after = await firstCell.boundingBox();
  assert.ok(after.width > before.width + 25, `Resize: ${before.width} -> ${after.width}`);
  const resized = await firstCell.getAttribute('colwidth');
  await waitForSavedColumnWidth(runId, resized);
  await page.getByRole('button', { name: 'Delete table', exact: true }).click();
  assert.equal(await table.count(), 0);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  assert.equal(await table.count(), 1);
  await editor.press('Meta+Shift+z');
  assert.equal(await table.count(), 0);
  await editor.press('Meta+z');
  assert.equal(await table.count(), 1);
  await page.waitForFunction(() => document.querySelector('.entry-status')?.textContent?.includes('Saved'));
  await waitForSavedColumnWidth(runId, resized);
  // Navigation flushes the latest document before reload.
  await page.getByRole('tab', { name: 'Method', exact: true }).click();
  await api('preferences.update', { layout: 'continuous' });
  await page.reload();
  await page.locator('.notebook-card').first().click();
  await page.locator('.entry-list-item').first().click();
  assert.equal(await firstCell.getAttribute('colwidth'), resized);
  assert.equal(await table.locator('tr').count(), 3);
  await page.setViewportSize({ width: 800, height: 900 });
  assert.equal(await editor.locator('.tableWrapper').evaluate(element => getComputedStyle(element).overflowX), 'auto');
  if (screenshotLabel !== 'before') {
    await editor.click();
    await page.getByRole('button', { name: 'Table', exact: true }).click();
    await page.setViewportSize({ width: 480, height: 640 });
    await page.locator('.table-insert-dialog').screenshot({ path: path.join(screenshots, 'insert-table-after-narrow.png') });
    const narrow = await page.locator('.table-insert-dialog').evaluate(dialog => ({ width: dialog.getBoundingClientRect().width, viewport: innerWidth, overflow: dialog.scrollWidth > dialog.clientWidth }));
    assert.ok(narrow.width <= narrow.viewport - 30 && !narrow.overflow, JSON.stringify(narrow));
    await page.keyboard.press('Escape');
  }
  assert.deepEqual(errors, []);
  console.log('PASS table chooser, structure, merge/split, width fitting, resize, Undo/Redo, both layouts and durable widths');
} finally {
  if (application) await application.close();
  await rm(root, { recursive: true, force: true });
}
