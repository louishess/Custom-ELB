import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { _electron as electron, chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import net from 'node:net';

// Explicit diagnostic: uses the real microphone briefly; never logs or saves audio/transcript text.
const root = await mkdtemp(path.join(os.tmpdir(), 'labmate-microphone-'));
let app, page, browser, standalonePID;
const reports = [];
try {
  if (process.env.LABMATE_LAUNCH_SERVICES === '1') {
    assert.ok(process.env.LABMATE_APP_BINARY, 'Normal macOS launch requires a packaged app');
    const server = net.createServer();
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    await new Promise(resolve => server.close(resolve));
    execFileSync('open', ['-n', '-a', path.resolve(process.env.LABMATE_APP_BINARY, '../../..'),
      '--env', `LABMATE_LIBRARY_ROOT=${path.join(root, 'library')}`,
      '--env', `LABMATE_TEST_PROFILE=${path.join(root, 'profile')}`,
      '--args', `--remote-debugging-port=${port}`, '--remote-debugging-address=127.0.0.1']);
    for (let attempt = 0; attempt < 40 && !browser; attempt++) {
      try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`); }
      catch { await new Promise(resolve => setTimeout(resolve, 250)); }
    }
    assert.ok(browser, 'Standalone app debugging connection');
    const session = await browser.newBrowserCDPSession();
    standalonePID = (await session.send('SystemInfo.getProcessInfo')).processInfo.find(info => info.type === 'browser')?.id;
    page = browser.contexts()[0].pages()[0] ?? await browser.contexts()[0].waitForEvent('page');
  } else {
  app = await electron.launch({
    ...(process.env.LABMATE_APP_BINARY ? {executablePath: process.env.LABMATE_APP_BINARY, args: []} : {args: ['.']}),
    env: {...process.env, LABMATE_LIBRARY_ROOT: path.join(root,'library'), LABMATE_TEST_PROFILE:path.join(root,'profile')},
  });
  page = await app.firstWindow();
  }
  page.setDefaultTimeout(35000);
  await page.waitForFunction(()=>Boolean(window.labmate));
  await page.evaluate(async ()=>{
    const book = await window.labmate.records.createNotebook({name:'Microphone diagnostic',description:'Temporary',discipline:'',color:'sage'});
    if (!book.ok) throw new Error(book.error.message);
    const created = await window.labmate.records.createExperiment({notebookId:book.value.notebooks[0].id,label:'Mic',title:'Microphone diagnostic',date:'2026-09-09',author:'Diagnostic'});
    if (!created.ok) throw new Error(created.error.message);
  });
  await page.reload();
  await page.locator('.notebook-card').first().click();
  await page.locator('[aria-label="Experimental information editor"]').click();
  await page.getByRole('button',{name:'Dictate',exact:true}).click();
  const start = page.getByRole('button',{name:'Start',exact:true});
  await page.waitForFunction(()=>Array.from(document.querySelectorAll('button')).some(button=>button.textContent==='Start'&&!button.disabled));
  await page.evaluate(()=>{
    window.microphoneDiagnostic=[];
    window.labmate.onDictation(event=>window.microphoneDiagnostic.push({state:event.state,at:performance.now(),message:event.message,transcriptLength:event.transcript?.length??0}));
  });
  for(let cycle=0;cycle<2;cycle++) {
    await page.evaluate(()=>window.microphoneDiagnostic=[]);
    await start.click();
    await page.waitForFunction(()=>window.microphoneDiagnostic.some(event=>['recording','error'].includes(event.state)), undefined, {timeout: 120000});
    await page.waitForTimeout(6000);
    const beforeStop = await page.evaluate(()=>({events:window.microphoneDiagnostic,status:document.querySelector('.dictation-status')?.textContent,recording:!!document.querySelector('.dictation-status.is-recording')}));
    console.log(JSON.stringify({cycle,...beforeStop}));
    if (beforeStop.recording) {
      await page.getByRole('button',{name:'Stop',exact:true}).click();
      await page.waitForFunction(()=>!document.querySelector('.dictation-status.is-recording'));
      await page.waitForFunction(()=>Array.from(document.querySelectorAll('button')).some(button=>button.textContent==='Start'&&!button.disabled));
    }
    const afterStop = await page.evaluate(()=>({events:window.microphoneDiagnostic,status:document.querySelector('.dictation-status')?.textContent}));
    reports.push({cycle,stayedRecording:beforeStop.recording,...afterStop});
    if(!beforeStop.recording) break;
  }
  await mkdir('artifacts/dictation-live',{recursive:true});
  await writeFile('artifacts/dictation-live/checks.json',JSON.stringify({checkedAt:new Date().toISOString(),packaged:!!process.env.LABMATE_APP_BINARY,launchServices:!!browser,audioSaved:false,transcriptSaved:false,reports},null,2));
  assert.equal(reports.length,2,'Both microphone start/stop cycles must complete');
  assert.ok(reports.every(report=>report.stayedRecording),'Microphone must stay active until Stop');
  assert.ok(reports.every(report=>!report.events.some(event=>event.state==='error')),'No native error');
  console.log('PASS two real microphone sessions remain active until explicit Stop');
} finally {
  if(app) {await app.evaluate(({app})=>{try{process.mainModule.require(`${app.getAppPath()}/electron/main.cjs`).runtime.speech.dispose()}catch{}}).catch(()=>{}); app.process().kill('SIGKILL');}
  if(browser) {
    await page?.getByRole('button', {name:'Cancel',exact:true}).click({timeout:1000}).catch(()=>{});
    await browser.close();
    if(standalonePID) { try { process.kill(standalonePID, 'SIGTERM'); } catch {} }
  }
  await rm(root,{recursive:true,force:true});
}
