'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {_electron: electron} = require('playwright');
const root = fs.mkdtempSync('/private/tmp/labmate-release-ui-');
const checks = [], errors = []; let application, page;
const doc = text => ({type:'doc',content:[{type:'paragraph',content:[{type:'text',text}]}]});
async function api(method,input) { const result=await page.evaluate(async({method,input})=>{ const [n,m]=method.split('.'); const r=await window.labmate[n][m](input); if(r.ok && r.value?.kind==='mutation') return window.labmate.records.snapshot(); return r; },{method,input}); assert.equal(result.ok,true,JSON.stringify(result.error)); return result.value; }
async function check(name, fn) { await fn(); checks.push(name); console.log('PASS '+name); }
const labels={information:'Experimental information',method:'Method',notes:'Notes',data:'Data'};
(async()=>{
 application=await electron.launch({...process.env.LABMATE_APP_BINARY ? {executablePath:process.env.LABMATE_APP_BINARY,args:[]} : {args:['.']},env:{...process.env,LABMATE_LIBRARY_ROOT:path.join(root,'library'),LABMATE_TEST_PROFILE:path.join(root,'profile')}});
 page=await application.firstWindow(); page.setDefaultTimeout(15000); page.on('pageerror', e=>errors.push(e.message));
 await application.evaluate(()=>{globalThis.releaseUnhandledExceptions=[];process.on('uncaughtException',error=>globalThis.releaseUnhandledExceptions.push(error.stack||String(error)));});
 await page.getByRole('heading',{name:'Lab notebooks',exact:true}).waitFor();
 let s=await api('records.createNotebook',{name:'Release notebook',description:'Synthetic test',discipline:'Chemistry',color:'sage'}); const nb=s.notebooks[0];
 const runs=[];
 for(const label of ['A','B']) { s=await api('records.createExperiment',{notebookId:nb.id,label,title:`Release Run ${label}`,date:label==='A'?'2026-09-01':'2026-09-16',author:label}); const run=s.runs.find(r=>r.label===label); runs.push(run); await api('documents.save',{runId:run.id,expectedRevision:run.revision,documents:Object.fromEntries(Object.keys(labels).map(section=>[section,doc(`${label} ${section} ORIGINAL`)]))}); }
 await page.reload(); await page.locator('.notebook-card').first().click();
 const choose=letter=>page.locator('.entry-items button').filter({hasText:`Release Run ${letter}`}).click();
 await check('A01: Undo and Redo are isolated across runs in all four sections, including persisted data',async()=>{
  for(const [section,label] of Object.entries(labels)) {
   await choose('A'); const editor=page.locator(`[contenteditable="true"][aria-label="${label} editor"]`); await editor.fill(`A ${section} EDITED`);
   await choose('B'); const target=page.locator(`[contenteditable="true"][aria-label="${label} editor"]`); await target.click(); await target.press('Meta+z'); await target.press('Meta+Shift+z'); assert.equal(await target.innerText(),`B ${section} ORIGINAL`);
  }
  await page.getByRole('button',{name:'Back to all notebooks',exact:true}).click(); s=await api('records.snapshot');
  for(const section of Object.keys(labels)) { assert.equal(s.runs.find(r=>r.id===runs[0].id).documents[section].content[0].content[0].text,`A ${section} EDITED`); assert.equal(s.runs.find(r=>r.id===runs[1].id).documents[section].content[0].content[0].text,`B ${section} ORIGINAL`); }
 });
 await check('A13: Recent entries opens the run actually selected',async()=>{ await page.locator('.recent-row').filter({hasText:'Release Run A'}).click(); assert.equal(await page.locator('.entry-document-header h1').innerText(),'Release Run A'); });
 await check('A05/A06: Every export format, scope, and offered ordering works through the UI',async()=>{
  await api('schemes.create',{notebookId:nb.id,name:'Reverse fixture',description:'',runIds:[runs[1].id,runs[0].id]}); await page.reload(); await page.locator('.notebook-card').first().click();
  await application.evaluate(({dialog})=>{dialog.showMessageBox=async()=>({response:1});});
  await page.getByRole('button',{name:'Export notebook',exact:true}).click();
  let index=0;
  const cases=[]; for(const scope of ['entry','selected','notebook']) for(const format of ['txt','md','html','rtf','docx']) cases.push({scope,format,order:'newest'});
  for(const order of ['oldest','title-az','title-za','label-az','author-az','number-asc','number-desc','scheme']) cases.push({scope:'notebook',format:'txt',order});
  for(const item of cases) {
   const destination=path.join(root,`export-${++index}.${item.format}`);
   await application.evaluate(({dialog},file)=>{dialog.showSaveDialog=async()=>({canceled:false,filePath:file});},destination);
   await page.getByLabel('Export scope',{exact:true}).selectOption(item.scope); await page.getByLabel('Format',{exact:true}).selectOption(item.format); if(item.scope!=='entry') await page.getByLabel('Entry ordering',{exact:true}).selectOption(item.order);
   await page.getByRole('button',{name:/^Export( again)?$/,exact:true}).click(); await page.getByText(`Saved ${path.basename(destination)}.`,{exact:true}).waitFor(); assert.ok(fs.statSync(destination).size>0);
   if(item.scope==='notebook' && item.format==='txt') { const body=fs.readFileSync(destination,'utf8'); const a=body.indexOf('Release Run A'),b=body.indexOf('Release Run B'); assert.ok(a>=0&&b>=0); assert.equal(a<b,['oldest','title-az','label-az','author-az','number-asc'].includes(item.order)); }
  }
  await page.getByRole('button',{name:'Close panel',exact:true}).click();
 });
 await check('A07: A trashed experiment is restorable while its notebook remains active',async()=>{
  s=await api('records.snapshot'); const e=s.experiments.find(e=>e.id===runs[0].experimentId); await api('trash.move',{kind:'experiment',id:e.id,expectedRevision:e.revision}); await page.reload();
  await page.getByRole('button',{name:'Settings',exact:true}).click(); await page.getByRole('tab',{name:'Trash',exact:true}).click(); const restore=page.getByRole('button',{name:'Restore',exact:true}); assert.equal(await restore.isEnabled(),true); await restore.click(); await page.getByText('Trash is empty',{exact:true}).waitFor(); assert.equal((await api('records.snapshot')).experiments.find(e=>e.id===runs[0].experimentId).trashedAt,null); await page.getByRole('button',{name:'Done',exact:true}).click();
 });
 await check('Glass preserves seven palettes, brightness endpoints, solid editors, and reduced-motion styling',async()=>{
  await page.getByRole('button',{name:'Settings',exact:true}).click();
  await page.getByRole('radio',{name:'Glass',exact:true}).click(); await page.waitForFunction(()=>document.documentElement.dataset.material==='glass');
  for(const palette of ['sage','ocean','lavender','terracotta','rose','graphite','midnight']) {
   for(const appearance of [0,50,100]) {
   await api('preferences.update',{palette,material:'glass',appearance}); await page.reload(); await page.getByRole('heading',{name:'Lab notebooks',exact:true}).waitFor(); await page.waitForFunction(p=>document.documentElement.dataset.palette===p,palette);
   assert.equal(await page.evaluate(()=>getComputedStyle(document.querySelector('.sidebar')).backdropFilter.includes('blur')),true);
   await page.locator('.notebook-card').first().click();
   const editor=page.locator('[contenteditable="true"]').first(); await editor.waitFor(); assert.notEqual(await editor.evaluate(e=>getComputedStyle(e.closest('.entry-document')).backgroundColor),'rgba(0, 0, 0, 0)');
   fs.mkdirSync('artifacts/release/glass',{recursive:true}); await page.screenshot({path:`artifacts/release/glass/${palette}-${appearance}.png`});
   }
  }
  await page.emulateMedia({reducedMotion:'reduce'}); assert.equal(await page.evaluate(()=>getComputedStyle(document.querySelector('.sidebar')).animationName),'none');
  await api('preferences.update',{palette:'sage',appearance:0,material:'solid'}); await page.reload();
 });
 await page.locator('.notebook-card').first().click();
 await check('A11: Retry restarts a failed worker and saves the retained editor draft',async()=>{
  await application.evaluate(async({app})=>{const load=process.getBuiltinModule('module').createRequire(app.getAppPath()+'/package.json');const client=load('./electron/main.cjs').runtime.worker;await new Promise(resolve=>{client.worker.once('exit',resolve);client.worker.kill();});});
  const editor=page.locator('[contenteditable="true"]').first();await editor.fill('RETAINED DRAFT AFTER WORKER FAILURE');
  await page.getByRole('button',{name:'Retry with this draft',exact:true}).click();
  await page.getByRole('button',{name:'Back to all notebooks',exact:true}).click();
  const saved=await api('records.snapshot');assert.ok(saved.runs.some(run=>JSON.stringify(run.documents.information).includes('RETAINED DRAFT AFTER WORKER FAILURE')));
  await page.locator('.notebook-card').first().click();
 });
 const source=path.join(root,'caption.txt');fs.writeFileSync(source,'Synthetic attachment');
 await application.evaluate(({dialog},source)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[source]});},source);
 await page.getByRole('button',{name:'Add files',exact:true}).click(); await page.getByRole('button',{name:'Open attachment caption.txt',exact:true}).click(); await page.getByText('Preview unavailable',{exact:true}).waitFor();
 await check('A14: Completed previews clear global progress',async()=>{ await page.getByRole('button',{name:'Done',exact:true}).click(); assert.equal(await page.locator('.global-progress').count(),0); });
 await check('A10: Closing with an unblurred caption saves it durably',async()=>{
  await page.getByRole('button',{name:'Open attachment caption.txt',exact:true}).click(); await page.getByLabel('Caption',{exact:true}).fill('CAPTION SAVED WITHOUT BLUR');
  await Promise.all([page.waitForEvent('close'),application.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].close())]);
  assert.deepEqual(await application.evaluate(async()=>{await new Promise(resolve=>setImmediate(resolve));return globalThis.releaseUnhandledExceptions;}),[],'Native window close must not raise a main-process exception');
  const {LibraryStore}=require('../electron/backend/store.cjs'); const reopened=new LibraryStore(path.join(root,'library')); try {assert.equal(reopened.snapshot().attachments[0].caption,'CAPTION SAVED WITHOUT BLUR');}finally{reopened.close();}
 });
 assert.deepEqual(errors,[]);
 fs.mkdirSync('artifacts/release',{recursive:true}); fs.writeFileSync('artifacts/release/ui-regressions.json',JSON.stringify({checks,errors,package:process.env.LABMATE_APP_BINARY||null},null,2));
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(async()=>{if(application) await application.close();fs.rmSync(root,{recursive:true,force:true});});
