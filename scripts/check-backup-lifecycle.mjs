import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {_electron as electron} from 'playwright';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'labmate-backup-lifecycle-'));
const destination=path.join(root,'home','Library','CloudStorage','Box-Box','LabMate'); fs.mkdirSync(destination,{recursive:true});
const password='Disposable lifecycle test password';const results=[];let application,page;
async function launch(){
 application=await electron.launch({...process.env.LABMATE_APP_BINARY?{executablePath:process.env.LABMATE_APP_BINARY,args:[]}:{args:['.']},env:{...process.env,LABMATE_LIBRARY_ROOT:path.join(root,'library'),LABMATE_TEST_PROFILE:path.join(root,'profile')}});
 page=await application.firstWindow();page.setDefaultTimeout(20000);await page.getByRole('heading',{name:'Lab notebooks',exact:true}).waitFor();
 await application.evaluate(({app,dialog},{root,destination})=>{const original=app.getPath.bind(app);app.getPath=name=>name==='home'?root+'/home':original(name);dialog.showOpenDialog=async()=>({canceled:false,filePaths:[destination]});dialog.showMessageBox=async()=>({response:1});},{root,destination});
}
async function api(method,input){const r=await page.evaluate(async({method,input})=>{const[n,m]=method.split('.');return window.labmate[n][m](input);},{method,input});assert.equal(r.ok,true,JSON.stringify(r.error));return r.value;}
try{
 await launch(); await api('backups.configure',{password});let state=await api('records.createNotebook',{name:'Lifecycle',description:'',discipline:'Chemistry',color:'sage'});const notebook=state.notebooks[0];await api('records.createExperiment',{notebookId:notebook.id,label:'L',title:'Lifecycle test',date:'2026-09-17',author:'Test'});
 fs.renameSync(destination,destination+'-offline');
 const offline=await api('backups.run',{jobId:'offline-checkpoint'});assert.ok(offline.lastLocalBackupAt);assert.equal(offline.pendingDeliveryCount,1);assert.equal(offline.destinationAvailable,false);results.push('Local checkpoint with unavailable Box destination');
 await application.close();application=null; await launch();
 const status=await api('backups.status');assert.equal(status.configured,true);assert.equal(status.pendingDeliveryCount,1);results.push('Keychain-protected password and queued delivery survive restart');
 fs.renameSync(destination+'-offline',destination);
 await application.evaluate(async({app,powerMonitor})=>{const load=process.getBuiltinModule('module').createRequire(app.getAppPath()+'/package.json'); powerMonitor.emit('resume'); await load('./electron/main.cjs').runtime.catchUpBackup();});
 await page.waitForFunction(async()=>{const s=await window.labmate.backups.status();return s.ok&&!s.value.running&&s.value.pendingDeliveryCount===0;});
 results.push('Resume retries pending delivery');
 const before=JSON.parse(fs.readFileSync(path.join(root,'library','backups','catalog.json'))).archives.length;
 await application.evaluate(async({app})=>{const load=process.getBuiltinModule('module').createRequire(app.getAppPath()+'/package.json');await load('./electron/main.cjs').runtime.runBackup('unchanged',null,true);});
 assert.equal(JSON.parse(fs.readFileSync(path.join(root,'library','backups','catalog.json'))).archives.length,before);results.push('Unchanged library skips new checkpoint');
 await page.locator('.notebook-card').first().click();await page.locator('[contenteditable="true"]').first().fill('FINAL DRAFT SAVED AT QUIT');
 await application.close();application=null;
 const catalog=JSON.parse(fs.readFileSync(path.join(root,'library','backups','catalog.json')));assert.ok(catalog.archives.length>before);assert.ok(catalog.archives.every(a=>a.copies.length));results.push('Normal quit flushes editor, completes local checkpoint, and records delivery');
 await launch(); const snapshot=await api('records.snapshot');assert.match(JSON.stringify(snapshot.runs[0].documents.information),/FINAL DRAFT SAVED AT QUIT/);
 await api('backups.configure',{password:'Changed disposable password'}); await api('backups.run',{jobId:'changed-password'});results.push('Password change preserves older archive history');
 const oldest=catalog.archives[0];await application.evaluate(({dialog},file)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[file]});},path.join(root,'library','backups',oldest.name));
 const rehearsed=await api('backups.verify',{password,jobId:'original-password'});assert.equal(rehearsed.verified,true);results.push('Older archive still recovers with its original password');
 console.log(results.map(r=>'PASS '+r).join('\n'));fs.mkdirSync('artifacts/release',{recursive:true});fs.writeFileSync('artifacts/release/backup-lifecycle.json',JSON.stringify({results,package:process.env.LABMATE_APP_BINARY||null},null,2));
}finally{if(application)await application.close();fs.rmSync(root,{recursive:true,force:true});}
