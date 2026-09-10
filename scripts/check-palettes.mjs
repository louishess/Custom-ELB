import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { setTimeout as waitForRetry } from 'node:timers/promises';
import { _electron as electron } from 'playwright';

// Every launch is isolated from the working library, Keychain and Box folder.
const root = await mkdtemp(path.join(os.tmpdir(), 'labmate-palettes-'));
const output = path.resolve('artifacts/palettes');
await mkdir(output, { recursive: true });
const palettes = [['sage', 'Original Sage'], ['ocean', 'Ocean'], ['lavender', 'Lavender'], ['terracotta', 'Terracotta'], ['rose', 'Rose'], ['graphite', 'Graphite'], ['midnight', 'Midnight Purple']];
const checks = [], errors = [], externalRequests = [], screenshots = [];
let application, page;
async function launch() {
  application = await electron.launch({
    ...(process.env.LABMATE_APP_BINARY ? { executablePath: process.env.LABMATE_APP_BINARY, args: [] } : { args: ['.'] }),
    env: { ...process.env, LABMATE_LIBRARY_ROOT: path.join(root, 'library'), LABMATE_TEST_PROFILE: path.join(root, 'profile') },
  });
  page = await application.firstWindow();
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (/^https?:/.test(request.url())) externalRequests.push(request.url()); });
  await page.getByRole('heading', { name: 'Lab notebooks', exact: true }).waitFor();
}
async function check(name, operation) { await operation(); checks.push(name); console.log(`PASS ${name}`); }
async function api(method, input) {
  const result = await page.evaluate(async ({ method, input }) => {
    const [namespace, name] = method.split('.');
    return window.labmate[namespace][name](input);
  }, { method, input });
  assert.equal(result.ok, true, `${method}: ${JSON.stringify(result)}`);
  return result.value;
}
async function persisted(palette, appearance) {
  // Poll resolved IPC results in Node: the renderer's waitForFunction must not
  // mistake an unresolved Promise for a successful persistence predicate.
  const deadline = Date.now() + 15_000;
  let lastPreferences;
  while (Date.now() < deadline) {
    lastPreferences = (await api('records.snapshot')).preferences;
    if (lastPreferences.palette === palette && (appearance === undefined || lastPreferences.appearance === appearance)) {
      await page.waitForFunction(({ palette, appearance }) =>
        document.documentElement.dataset.palette === palette &&
        (appearance === undefined || document.documentElement.dataset.appearance === String(appearance)),
      { palette, appearance });
      return;
    }
    await waitForRetry(50);
  }
  assert.fail(`Timed out waiting for saved palette=${palette}, appearance=${appearance}; last preferences: ${JSON.stringify(lastPreferences)}`);
}
async function openSettings() {
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('dialog', { name: 'Settings', exact: true }).waitFor();
}
async function closeSettings() {
  await page.keyboard.press('Escape');
  await page.getByRole('dialog').waitFor({ state: 'detached' });
}
async function brightness(value, palette) {
  const slider = page.getByRole('slider', { name: 'Appearance', exact: true });
  await slider.focus();
  await slider.press(value === 100 ? 'End' : 'Home');
  if (value === 50) for (let i = 0; i < 5; i++) await slider.press('PageUp');
  await persisted(palette, value);
}
async function shot(name) {
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const png = await application.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString('base64'));
  await writeFile(path.join(output, `${name}.png`), Buffer.from(png, 'base64'));
  screenshots.push(`${name}.png`);
}
async function checkLayout() {
  const problems = await page.evaluate(() => {
    const failures = [];
    const boxes = [...document.querySelectorAll('.palette-option')].map(element => ({ label: element.textContent, box: element.getBoundingClientRect() }));
    for (let i = 0; i < boxes.length; i++) {
      const { label, box } = boxes[i];
      if (box.left < 0 || box.right > innerWidth + 1) failures.push(`${label} outside window`);
      for (let j = i + 1; j < boxes.length; j++) {
        const other = boxes[j].box;
        if (Math.min(box.right, other.right) - Math.max(box.left, other.left) > 1 && Math.min(box.bottom, other.bottom) - Math.max(box.top, other.top) > 1) failures.push(`${label} overlaps ${boxes[j].label}`);
      }
    }
    for (const label of document.querySelectorAll('.palette-label')) if (label.scrollWidth > label.clientWidth + 1) failures.push(`${label.textContent} is clipped`);
    const dialog = document.querySelector('dialog[open]')?.getBoundingClientRect();
    if (!dialog || dialog.left < 0 || dialog.right > innerWidth + 1 || dialog.top < 0 || dialog.bottom > innerHeight + 1) failures.push('Settings dialog outside window');
    const body = document.querySelector('.modal-body');
    if (body && body.scrollWidth > body.clientWidth + 1) failures.push('Settings body overflows horizontally');
    return failures;
  });
  assert.deepEqual(problems, []);
}

try {
  await launch();
  await check('New libraries default to Original Sage', async () => {
    assert.equal((await api('records.snapshot')).preferences.palette, 'sage');
    await persisted('sage', 0);
    for (const color of ['sage', 'blue', 'clay']) await api('records.createNotebook', { name: `${color === 'sage' ? 'Synthesis' : color === 'blue' ? 'Analysis' : 'Field notes'}`, description: 'Disposable palette review notebook', discipline: 'Chemistry', color });
    await page.reload();
    await page.locator('.notebook-card').first().waitFor();
  });
  for (const [id, label] of palettes) {
    await check(`${label} selects in Settings, persists on reload, and renders at 0/50/100`, async () => {
      await openSettings();
      // Preference updates finish after the desktop transaction acknowledges;
      // locator.check() requires an immediate synchronous checked state.
      await page.locator('.palette-option').filter({ hasText: label }).click();
      await persisted(id);
      await page.reload();
      await page.getByRole('heading', { name: 'Lab notebooks', exact: true }).waitFor();
      await persisted(id);
      await openSettings();
      assert.equal(await page.getByRole('radio', { name: label, exact: true }).isChecked(), true);
      for (const value of [0, 50, 100]) {
        await brightness(value, id);
        if (id === 'midnight' && value === 100) assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--canvas').trim()), '#000000');
        await checkLayout();
        await page.locator('.palette-picker').scrollIntoViewIfNeeded();
        await shot(`${id}-${value}-settings`);
      }
      await closeSettings();
      await shot(`${id}-100-directory`);
    });
  }
  await check('Palette radio controls expose visible keyboard focus and arrow navigation', async () => {
    await openSettings();
    await page.getByRole('radio', { name: 'Graphite', exact: true }).focus();
    await page.keyboard.press('ArrowLeft');
    await persisted('rose');
    await page.waitForFunction(() => document.querySelector('.palette-option input[value="rose"]')?.checked === true);
    assert.equal(await page.getByRole('radio', { name: 'Rose', exact: true }).isChecked(), true);
    const outline = await page.locator('.palette-option').filter({ hasText: 'Rose' }).evaluate(element => ({ style: getComputedStyle(element).outlineStyle, width: getComputedStyle(element).outlineWidth }));
    assert.equal(outline.style, 'solid');
    assert.equal(outline.width, '2px');
    await shot('rose-keyboard-focus');
    await page.keyboard.press('ArrowRight');
    await persisted('graphite');
    await page.keyboard.press('ArrowRight');
    await persisted('midnight');
  });
  await check('Narrow supported window keeps palette names and Settings controls usable', async () => {
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1000, 740));
    await brightness(100, 'midnight');
    await checkLayout();
    await page.locator('.palette-picker').scrollIntoViewIfNeeded();
    await shot('midnight-100-narrow');
  });
  await check('Reduced motion suppresses palette transitions and notebook hover movement', async () => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    assert.equal(await page.locator('.palette-option').first().evaluate(element => getComputedStyle(element).transitionDuration), '0s');
    await closeSettings();
    await page.locator('.notebook-card').first().hover();
    const style = await page.locator('.notebook-card').first().evaluate(element => ({ transition: getComputedStyle(element).transitionDuration, transform: getComputedStyle(element).transform }));
    assert.equal(style.transition, '0s');
    assert.equal(style.transform, 'none');
    await shot('midnight-100-reduced-motion');
  });
  await check('Full application restart retains palette and brightness without renderer errors', async () => {
    await application.close(); application = undefined;
    await launch();
    await persisted('midnight', 100);
    assert.equal((await api('records.snapshot')).notebooks.length, 3);
    await openSettings();
    assert.equal(await page.getByRole('radio', { name: 'Midnight Purple', exact: true }).isChecked(), true);
    assert.deepEqual(errors, []);
    assert.deepEqual(externalRequests, []);
  });
  await writeFile(path.join(output, 'checks.json'), JSON.stringify({ checkedAt: new Date().toISOString(), packaged: Boolean(process.env.LABMATE_APP_BINARY), checks, errors, externalRequests, screenshots }, null, 2));
  await Promise.all(['failure.json', 'failure.png'].map(name => rm(path.join(output, name), { force: true })));
  console.log(`Verified ${checks.length} palette UI checks; ${screenshots.length} screenshots saved to ${output}.`);
} catch (error) {
  if (page && !page.isClosed()) await shot('failure').catch(() => {});
  await writeFile(path.join(output, 'failure.json'), JSON.stringify({ error: String(error), checks, errors, externalRequests }, null, 2));
  throw error;
} finally {
  if (application) await application.close().catch(() => {});
  await rm(root, { recursive: true, force: true });
}
