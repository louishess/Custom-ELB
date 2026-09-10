import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { _electron as electron } from 'playwright';
import yieldMath from '../shared/yield.cjs';

const root = await mkdtemp(path.join(os.tmpdir(), 'labmate-yield-'));
let application, page;
try {
  application = await electron.launch({
    ...(process.env.LABMATE_APP_BINARY ? { executablePath: process.env.LABMATE_APP_BINARY, args: [] } : { args: ['.'] }),
    env: { ...process.env, LABMATE_LIBRARY_ROOT: path.join(root, 'library'), LABMATE_TEST_PROFILE: path.join(root, 'profile') },
  });
  page = await application.firstWindow();
  page.setDefaultTimeout(12000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.waitForFunction(() => Boolean(window.labmate));
  const api = async (method, input) => {
    const result = await page.evaluate(async ({ method, input }) => {
      const [group, name] = method.split('.'); return window.labmate[group][name](input);
    }, { method, input });
    assert.equal(result.ok, true, JSON.stringify(result)); return result.value;
  };
  let state = await api('records.createNotebook', { name: 'Yield checks', description: '', discipline: 'Chemistry', color: 'sage' });
  state = await api('records.createExperiment', { notebookId: state.notebooks[0].id, label: 'Yield', title: 'Mixed-unit calculation', date: '2026-09-09', author: 'Automated validation' });
  const runId = state.runs[0].id;
  // Existing saved cards remain editable after creation moves to material markup.
  await api('documents.save', { runId, expectedRevision: state.runs[0].revision, documents: {
    ...state.runs[0].documents,
    data: { type: 'doc', content: [{ type: 'yieldCalculation', attrs: { ...yieldMath.DEFAULT_YIELD_INPUTS } }, { type: 'paragraph' }] },
  } });
  const savedData = async predicate => {
    const deadline = Date.now() + 12000;
    while (Date.now() < deadline) {
      const snapshot = await api('records.snapshot');
      if (predicate(snapshot.runs.find(run => run.id === runId).documents.data)) return;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error('Latest yield data was not saved within 12 seconds');
  };
  await api('preferences.update', { layout: 'tabs' });
  const reopen = async () => {
    await page.reload(); await page.locator('.notebook-card').first().click(); await page.locator('.entry-list-item').first().click(); await page.getByRole('tab', { name: 'Data', exact: true }).click();
  };
  await reopen();
  let card = page.locator('.yield-card');
  assert.equal(await card.count(), 1);
  assert.equal(await card.getByLabel('Amount', { exact: true }).first().inputValue(), '');
  await card.getByLabel('Label (optional)', { exact: true }).first().fill('Substrate A');
  await card.getByLabel('Amount', { exact: true }).first().fill('2');
  await card.getByLabel('Equivalents', { exact: true }).first().fill('2');
  await card.getByLabel('Amount', { exact: true }).nth(1).fill('750');
  await card.getByRole('combobox').nth(1).selectOption('µmol');
  await page.waitForFunction(() => document.querySelector('.yield-result')?.textContent?.includes('75% yield'));
  assert.match(await card.locator('.yield-result').innerText(), /1000 µmol/);
  await savedData(data => data.content.some(node => node.type === 'yieldCalculation' && node.attrs.productAmount === '750' && node.attrs.productUnit === 'µmol'));
  await reopen();
  assert.match(await card.locator('.yield-result').innerText(), /75% yield/);
  assert.equal(await card.getByLabel('Label (optional)', { exact: true }).first().inputValue(), 'Substrate A');
  await card.getByLabel('Amount', { exact: true }).nth(1).fill('1e-');
  assert.match(await card.locator('.yield-result').innerText(), /finite decimal/);
  await savedData(data => data.content.some(node => node.type === 'yieldCalculation' && node.attrs.productAmount === '1e-'));
  await reopen();
  assert.equal(await card.getByLabel('Amount', { exact: true }).nth(1).inputValue(), '1e-');
  await card.getByLabel('Amount', { exact: true }).nth(1).fill('0');
  assert.match(await card.locator('.yield-result').innerText(), /0% yield/);
  await card.getByLabel('Amount', { exact: true }).nth(1).fill('1500');
  assert.match(await card.locator('.yield-result').innerText(), /150% yield/);
  assert.match(await card.locator('.yield-warning').innerText(), /Above 100%/);
  await card.getByRole('button', { name: 'Remove yield calculation', exact: true }).click();
  assert.equal(await card.count(), 0);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  assert.equal(await card.count(), 1);
  assert.equal(await card.getByLabel('Amount', { exact: true }).nth(1).inputValue(), '1500');
  await savedData(data => data.content.some(node => node.type === 'yieldCalculation' && node.attrs.productAmount === '1500'));
  await api('preferences.update', { layout: 'continuous' });
  await page.reload(); await page.locator('.notebook-card').first().click(); await page.locator('.entry-list-item').first().click();
  await card.scrollIntoViewIfNeeded();
  await page.setViewportSize({ width: 900, height: 1000 });
  const output = path.resolve('artifacts/yield'); await mkdir(output, { recursive: true });
  await card.screenshot({ path: path.join(output, 'yield-calculation.png') });
  // Real navigation and native close must flush immediately, without test waits.
  await card.getByLabel('Amount', { exact: true }).nth(1).fill('777');
  await page.getByRole('button', {name:'Back to all notebooks',exact:true}).click();
  await page.locator('.notebook-card').first().click(); await page.locator('.entry-list-item').first().click();
  assert.equal(await card.getByLabel('Amount', { exact: true }).nth(1).inputValue(), '777');
  await card.getByLabel('Amount', { exact: true }).nth(1).fill('888');
  await application.close();
  application = await electron.launch({
    ...(process.env.LABMATE_APP_BINARY ? { executablePath: process.env.LABMATE_APP_BINARY, args: [] } : { args: ['.'] }),
    env: { ...process.env, LABMATE_LIBRARY_ROOT: path.join(root, 'library'), LABMATE_TEST_PROFILE: path.join(root, 'profile') },
  });
  page = await application.firstWindow(); page.setDefaultTimeout(12000);
  page.on('pageerror', error => errors.push(error.message));
  await page.locator('.notebook-card').first().click(); await page.locator('.entry-list-item').first().click();
  card = page.locator('.yield-card');
  assert.equal(await card.getByLabel('Amount', { exact: true }).nth(1).inputValue(), '888');
  state = await api('records.repeatRun', { runId, date: '2026-09-09' });
  assert.ok(!JSON.stringify(state.runs.find(run => run.id !== runId).documents.data).includes('yieldCalculation'));
  assert.deepEqual(errors, []);
  console.log('PASS legacy yield-card loading, mixed-unit ratio, live editing, incomplete persistence, zero, over-100 warning, Remove/Undo, layouts, immediate navigation/native-close flush, repeat reset, and runtime errors');
} catch (error) {
  if (page) console.error(await page.locator('body').innerText({timeout:1000}).catch(() => 'Window unavailable'));
  throw error;
} finally {
  if (application) await application.close();
  await rm(root, { recursive: true, force: true });
}
