import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { _electron as electron } from 'playwright';

// Disposable library and mocked native service: no microphone or model downloads.
const root = await mkdtemp(path.join(os.tmpdir(), 'labmate-dictation-'));
const output = path.resolve('artifacts/dictation');
await mkdir(output, { recursive: true });
let app, page;
const checks = [], errors = [];
async function check(name, body) { console.log(`CHECK ${name}`); await body(); checks.push(name); console.log(`PASS ${name}`); }
try {
  app = await electron.launch({
    ...(process.env.LABMATE_APP_BINARY ? { executablePath: process.env.LABMATE_APP_BINARY, args: [] } : { args: ['.'] }),
    env: { ...process.env, LABMATE_LIBRARY_ROOT: path.join(root, 'library'), LABMATE_TEST_PROFILE: path.join(root, 'profile') },
  });
  page = await app.firstWindow();
  page.on('pageerror', error => errors.push(error.message));
  await page.waitForFunction(() => Boolean(window.labmate));
  await app.evaluate(async ({ app, BrowserWindow }) => {
    const { runtime } = process.mainModule.require(`${app.getAppPath()}/electron/main.cjs`);
    const emit = event => BrowserWindow.getAllWindows()[0].webContents.send('labmate:dictation', event);
    runtime.speech.capabilities = async () => ({ available: true, locales: [{ id: 'en-US', name: 'English (United States)', installed: true }] });
    runtime.speech.prepare = async ({sessionId}) => { emit({sessionId,state:'ready'}); return {ready:true}; };
    runtime.speech.start = async ({ sessionId }) => { globalThis.dictationTestSession = sessionId; emit({sessionId, state:'recording', transcript:'rough words',final:false}); return {started:true}; };
    runtime.speech.stop = async ({sessionId}) => { emit({sessionId,state:'stopped',transcript:'Recognized final words.',final:true}); return {stopped:true}; };
    runtime.speech.cancel = async ({sessionId}) => { emit({sessionId,state:'cancelled'}); return {cancelled:true}; };
  });
  await page.evaluate(async () => {
    const created = await window.labmate.records.createNotebook({name:'Dictation fixture',description:'Disposable',discipline:'Chemistry',color:'sage'});
    if (!created.ok) throw new Error(created.error.message);
    const state = await window.labmate.records.createExperiment({notebookId:created.value.notebooks[0].id,label:'Speech',title:'Dictation acceptance',date:'2026-09-09',author:'Test'});
    if (!state.ok) throw new Error(state.error.message);
    const run = state.value.runs[0];
    const doc = {type:'doc',content:[{type:'paragraph',content:[{type:'text',text:'Before AFTER'}]}]};
    const saved = await window.labmate.documents.save({runId:run.id,expectedRevision:run.revision,documents:{...run.documents,information:doc}});
    if (!saved.ok) throw new Error(saved.error.message);
  });
  await page.reload();
  await page.locator('.notebook-card').first().click();
  await page.locator('.entry-list-item,.entry-card').first().click();
  const editor = page.locator('[aria-label="Experimental information editor"]');
  await editor.waitFor();
  await editor.click();
  await page.keyboard.press('Home');
  // Select the final word through actual keyboard selection, saved when opening the dialog.
  await page.keyboard.press('Meta+ArrowRight');
  for(let index=0; index<5; index++) await page.keyboard.press('Shift+ArrowLeft');
  const open = async () => { await page.getByRole('button',{name:'Dictate',exact:true}).click(); await page.getByRole('button',{name:'Start',exact:true}).waitFor(); };
  await check('Start waits for preparation and cancelling preparation never starts the microphone', async () => {
    await app.evaluate(({app}) => {
      const {runtime} = process.mainModule.require(`${app.getAppPath()}/electron/main.cjs`);
      globalThis.originalSpeechPrepare = runtime.speech.prepare;
      globalThis.originalSpeechStart = runtime.speech.start;
      globalThis.microphoneStartCalls = 0;
      runtime.speech.prepare = async () => new Promise(resolve => { globalThis.finishSpeechPreparation = resolve; });
      runtime.speech.start = async payload => { globalThis.microphoneStartCalls++; return globalThis.originalSpeechStart(payload); };
    });
    await open(); await page.getByRole('button',{name:'Start',exact:true}).click();
    assert.equal(await app.evaluate(()=>globalThis.microphoneStartCalls),0);
    assert.equal(await page.getByRole('button',{name:'Stop',exact:true}).isDisabled(),true);
    await page.getByRole('button',{name:'Cancel',exact:true}).click();
    await page.getByRole('dialog').waitFor({state:'hidden'});
    await app.evaluate(()=>globalThis.finishSpeechPreparation({ready:true}));
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    assert.equal(await app.evaluate(()=>globalThis.microphoneStartCalls),0);
    await app.evaluate(({app}) => {
      const {runtime} = process.mainModule.require(`${app.getAppPath()}/electron/main.cjs`);
      runtime.speech.prepare = globalThis.originalSpeechPrepare;
      runtime.speech.start = globalThis.originalSpeechStart;
    });
  });
  await check('A native startup error remains visible even when the start reply arrives later', async () => {
    await app.evaluate(({app,BrowserWindow}) => {
      const {runtime} = process.mainModule.require(`${app.getAppPath()}/electron/main.cjs`);
      runtime.speech.start = async ({sessionId}) => {
        BrowserWindow.getAllWindows()[0].webContents.send('labmate:dictation',{sessionId,state:'error',message:'Microphone startup failed'});
        return {started:true};
      };
    });
    await open(); await page.getByRole('button',{name:'Start',exact:true}).click();
    await page.getByText('Microphone startup failed',{exact:true}).waitFor();
    await page.waitForFunction(()=>!document.querySelector('.dictation-status.is-recording'));
    assert.equal(await page.getByRole('button',{name:'Stop',exact:true}).isDisabled(),true);
    await page.getByRole('button',{name:'Cancel',exact:true}).click();
    await page.getByRole('dialog').waitFor({state:'hidden'});
    await app.evaluate(({app})=>{process.mainModule.require(`${app.getAppPath()}/electron/main.cjs`).runtime.speech.start=globalThis.originalSpeechStart});
  });
  await check('Partial results are visible, cannot overwrite review edits, and are session-scoped', async () => {
    await open(); await page.getByRole('button',{name:'Start',exact:true}).click();
    await page.locator('#dictation-transcript').filter({visible:true}).waitFor();
    await page.waitForFunction(()=>document.querySelector('#dictation-transcript')?.value==='rough words');
    assert.equal(await page.locator('#dictation-transcript').getAttribute('readonly'), '');
    await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].webContents.send('labmate:dictation',{sessionId:'wrong',state:'recording',transcript:'must not appear'}));
    assert.equal(await page.locator('#dictation-transcript').inputValue(),'rough words');
    await page.getByRole('button',{name:'Stop',exact:true}).click();
    await page.waitForFunction(()=>document.querySelector('#dictation-transcript')?.value==='Recognized final words.');
    await page.locator('#dictation-transcript').fill('Corrected words.');
    await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].webContents.send('labmate:dictation',{sessionId:globalThis.dictationTestSession,state:'stopped',transcript:'Late stale result',final:true}));
    assert.equal(await page.locator('#dictation-transcript').inputValue(),'Corrected words.');
  });
  await check('Review inserts at the saved selection and one Undo restores prior text', async () => {
    await page.getByRole('button',{name:'Insert transcript',exact:true}).click();
    await page.getByRole('dialog').waitFor({state:'hidden'});
    assert.match(await editor.innerText(),/Before Corrected words\./);
    assert.doesNotMatch(await editor.innerText(),/AFTER/);
    await page.getByRole('button',{name:'Undo',exact:true}).click();
    assert.equal(await editor.innerText(),'Before AFTER');
  });
  await check('A cancelled Stop reply cannot reset a restarted recording or disable its transcript', async () => {
    await app.evaluate(({app}) => {
      const {runtime} = process.mainModule.require(`${app.getAppPath()}/electron/main.cjs`);
      globalThis.originalSpeechStop = runtime.speech.stop;
      runtime.speech.stop = async () => new Promise(resolve => { globalThis.finishOldSpeechStop = resolve; });
    });
    await open(); await page.getByRole('button',{name:'Start',exact:true}).click();
    await page.waitForFunction(()=>document.querySelector('#dictation-transcript')?.value==='rough words');
    await page.getByRole('button',{name:'Stop',exact:true}).click();
    await page.getByText('Finishing the transcript…',{exact:true}).waitFor();
    await page.getByRole('button',{name:'Cancel',exact:true}).click();
    await page.getByRole('button',{name:'Keep reviewing',exact:true}).click();
    assert.equal(await page.locator('#dictation-transcript').inputValue(),'rough words');
    await page.getByRole('button',{name:'Start',exact:true}).click();
    await page.waitForFunction(()=>document.querySelector('#dictation-transcript')?.value==='rough words rough words');
    await app.evaluate(()=>globalThis.finishOldSpeechStop({stopped:true}));
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    assert.equal(await page.getByRole('button',{name:'Stop',exact:true}).isEnabled(),true);
    assert.equal(await page.getByRole('button',{name:'Start',exact:true}).isDisabled(),true);
    assert.equal(await page.locator('#dictation-transcript').getAttribute('readonly'),'');
    await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].webContents.send('labmate:dictation',{
      sessionId:globalThis.dictationTestSession,state:'recording',transcript:'Fresh recording words',final:false,
    }));
    await page.waitForFunction(()=>document.querySelector('#dictation-transcript')?.value==='rough words Fresh recording words');
    await page.getByRole('button',{name:'Cancel',exact:true}).click();
    await page.getByRole('button',{name:'Discard transcript',exact:true}).click();
    await page.getByRole('dialog').waitFor({state:'hidden'});
    await app.evaluate(({app})=>{process.mainModule.require(`${app.getAppPath()}/electron/main.cjs`).runtime.speech.stop=globalThis.originalSpeechStop});
  });
  await check('Cancellation preserves review text until an explicit discard', async () => {
    await open(); await page.locator('#dictation-transcript').fill('Keep this draft.');
    await page.getByRole('button',{name:'Cancel',exact:true}).click();
    await page.getByRole('button',{name:'Keep reviewing',exact:true}).click();
    assert.equal(await page.locator('#dictation-transcript').inputValue(),'Keep this draft.');
  });
  await check('A window close attempt stops capture and keeps the unresolved dialog open', async () => {
    await page.getByRole('button',{name:'Start',exact:true}).click();
    await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].close());
    await page.getByText('Insert or discard this transcript before closing LabMate.',{exact:true}).waitFor();
    assert.equal(page.isClosed(),false);
    await page.screenshot({path:path.join(output,'review-close-gate.png')});
    await page.getByRole('button',{name:'Cancel',exact:true}).click();
    await page.getByRole('button',{name:'Discard transcript',exact:true}).click();
    await page.getByRole('dialog').waitFor({state:'hidden'});
    assert.equal(await editor.innerText(),'Before AFTER');
  });
  assert.deepEqual(errors,[]);
  await writeFile(path.join(output,'checks.json'),JSON.stringify({checkedAt:new Date().toISOString(),packaged:Boolean(process.env.LABMATE_APP_BINARY),microphone:'mocked; no audio captured',checks,errors},null,2));
} catch(error) {
  if(page&&!page.isClosed()) await page.screenshot({path:path.join(output,'failure.png')}).catch(()=>{});
  console.error(error);
  throw error;
} finally {
  if(app) app.process().kill('SIGKILL');
  await rm(root,{recursive:true,force:true});
}
