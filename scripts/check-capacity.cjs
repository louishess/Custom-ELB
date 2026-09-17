'use strict';
const fs=require('node:fs'), path=require('node:path'), os=require('node:os'), crypto=require('node:crypto'), assert=require('node:assert/strict');
const {createRequire}=require('node:module');
const [asar]=process.argv.slice(2); const load=asar?createRequire(path.join(path.resolve(asar),'package.json')):require;
const {LibraryStore}=asar?load('./electron/backend/store.cjs'):require('../electron/backend/store.cjs');
const {runManagedBackup,verifyBackup}=asar?load('./electron/backend/backup-manager.cjs'):require('../electron/backend/backup-manager.cjs');
const {readCatalog}=asar?load('./electron/backend/backup-catalog.cjs'):require('../electron/backend/backup-catalog.cjs');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'labmate-capacity-')); const store=new LibraryStore(root); const started=Date.now();
(async()=>{
 const notebook=store.dispatch('records.createNotebook',{name:'Capacity proof',description:'Disposable',discipline:'Chemistry',color:'sage'}).value.notebooks[0];
 const run=store.dispatch('records.createExperiment',{notebookId:notebook.id,label:'Capacity',title:'Near supported limit',date:'2026-09-16',author:'Test'}).value.runs[0];
 const bytes=1024**3-8*1024**2;
 for(let i=0;i<2;i++) {
  const temporary=path.join(root,`source-${i}`); const handle=fs.openSync(temporary,'wx'); const chunk=crypto.randomBytes(8*1024**2); const hash=crypto.createHash('sha256');
  try { for(let written=0;written<bytes;) {const part=chunk.subarray(0,Math.min(chunk.length,bytes-written));fs.writeSync(handle,part);hash.update(part);written+=part.length;}fs.fsyncSync(handle); }finally{fs.closeSync(handle);}
  const digest=hash.digest('hex'); fs.renameSync(temporary,path.join(root,'objects',digest)); store.addAttachment({id:crypto.randomUUID(),runId:run.id,name:`capacity-${i}.bin`,mime:'application/octet-stream',kind:'file',size:bytes,hash:digest,caption:'Synthetic capacity fixture',createdAt:new Date().toISOString()});
 }
 console.log('Created 2,032 MiB of unique attachment data.');
 let phase;const progress={onProgress:event=>{if(event.phase!==phase){phase=event.phase;console.log(phase);}}};
 const result=await runManagedBackup(store,{password:'Disposable capacity password',destination:null,jobId:'capacity-backup'},progress); assert.ok(result.lastLocalBackupAt); const archive=readCatalog(root).archives[0];
 const file=path.join(root,'backups',archive.name); const archiveBytes=fs.statSync(file).size; assert.ok(archiveBytes>1.9*1024**3); assert.ok(archiveBytes<2*1024**3);
 const verified=await verifyBackup(root,{password:'Disposable capacity password',source:file,jobId:'capacity-recovery'},progress); assert.equal(verified.records.attachments,2);assert.equal(verified.verified,true);
 const report={attachmentBytes:bytes*2,archiveBytes,verified:true,elapsedMs:Date.now()-started,package:asar||null};fs.mkdirSync('artifacts/release',{recursive:true});fs.writeFileSync('artifacts/release/capacity.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report));
})().catch(error=>{console.error(error);process.exitCode=1;}).finally(()=>{store.close();fs.rmSync(root,{recursive:true,force:true});});
