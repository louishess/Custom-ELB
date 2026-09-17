import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createRequire} from 'node:module';
import {_electron as electron} from 'playwright';
const require=createRequire(import.meta.url);
const {LibraryStore}=require('../electron/backend/store.cjs');
const results=[];
for(const count of [1000,5000]) {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'labmate-performance-'));
 const library=path.join(root,'library'); const store=new LibraryStore(library,{mutationUpdates:true});
 const notebook=store.dispatch('records.createNotebook',{name:'Benchmark',description:'Synthetic',discipline:'Chemistry',color:'sage'}).value.notebooks[0];
 const doc={type:'doc',content:[{type:'paragraph',content:[{type:'text',text:'Synthetic reproducible measurement '.repeat(61)}]}]};
 store.db.transaction(()=>{for(let i=0;i<count;i++)store._createExperiment({notebookId:notebook.id,label:'Bench',title:`Run ${i}`,date:'2026-09-16',author:'Test'});store.db.prepare('UPDATE documents SET json=?').run(JSON.stringify(doc));})();
 const sourceRead=performance.now(); const snapshot=store.snapshot(); const snapshotMs=performance.now()-sourceRead;
 const preferenceStart=performance.now(); const delta=store.dispatch('preferences.update',{appearance:42}); const preferenceMs=performance.now()-preferenceStart;
 assert.equal(delta.value.runs.length,0); store.close();
 let application;
 try {
  const startup=performance.now(); application=await electron.launch({...process.env.LABMATE_APP_BINARY?{executablePath:process.env.LABMATE_APP_BINARY,args:[]}:{args:['.']},env:{...process.env,LABMATE_LIBRARY_ROOT:library,LABMATE_TEST_PROFILE:path.join(root,'profile')}});
  const page=await application.firstWindow(); page.setDefaultTimeout(30000); await page.getByRole('heading',{name:'Lab notebooks',exact:true}).waitFor(); const startupMs=performance.now()-startup;
  const initial=await page.evaluate(()=>window.labmate.records.snapshot()); assert.equal(initial.ok,true); let run=initial.value.runs[0];
  let done=false; const backupStart=performance.now();
  const backup=application.evaluate(async({app})=>{const require=process.getBuiltinModule('module').createRequire(app.getAppPath()+'/package.json'); const runtime=require(require('node:path').join(app.getAppPath(),'electron/main.cjs')).runtime; return runtime.worker.request('backups.run',{password:'Disposable benchmark password',destination:null,force:true,jobId:require('node:crypto').randomUUID()});}).then(result=>{done=true;return result;},error=>{done=true;return {ok:false,error:{message:error.message}};});
  const timings=[]; let edits=0;
  do {
   const started=performance.now(); const result=await page.evaluate(input=>window.labmate.documents.save(input),{runId:run.id,expectedRevision:run.revision,documents:{...run.documents,notes:{type:'doc',content:[{type:'paragraph',content:[{type:'text',text:`Saved during backup ${++edits}`}]}]}}});
   timings.push(performance.now()-started); assert.equal(result.ok,true,JSON.stringify(result.error)); assert.equal(result.value.kind,'mutation'); assert.equal(result.value.runs.length,1); run=result.value.runs[0];
   await new Promise(resolve=>setTimeout(resolve,10));
  } while(!done || edits<10);
  const protectedResult=await backup; assert.equal(protectedResult.ok,true,JSON.stringify(protectedResult)); assert.ok(protectedResult.value.lastLocalBackupAt);
  const after=await page.evaluate(()=>window.labmate.records.snapshot()); assert.equal(after.value.runs.find(r=>r.id===run.id).documents.notes.content[0].content[0].text,`Saved during backup ${edits}`);
  timings.sort((a,b)=>a-b);
  const result={runs:count,snapshotMs,preferenceMs,preferenceBytes:Buffer.byteLength(JSON.stringify(delta.value)),snapshotBytes:Buffer.byteLength(JSON.stringify(snapshot)),startupMs,backupMs:performance.now()-backupStart,edits,saveMedianMs:timings[Math.floor(timings.length/2)],saveP95Ms:timings[Math.floor(timings.length*.95)],saveMaxMs:timings.at(-1),package:process.env.LABMATE_APP_BINARY||null};
  assert.ok(result.saveP95Ms<1000,'Backup stalled normal saving'); results.push(result); console.log(JSON.stringify(result));
 } finally { if(application) await application.close(); fs.rmSync(root,{recursive:true,force:true}); }
}
fs.mkdirSync('artifacts/release',{recursive:true}); fs.writeFileSync('artifacts/release/performance.json',JSON.stringify(results,null,2));
