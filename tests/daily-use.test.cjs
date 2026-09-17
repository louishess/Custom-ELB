'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const {LibraryStore} = require('../electron/backend/store.cjs');
const {createBackupService} = require('../electron/backend/backup.cjs');
const {runManagedBackup, verifyBackup, capture} = require('../electron/backend/backup-manager.cjs');
const {readCatalog, retainedArchives} = require('../electron/backend/backup-catalog.cjs');
const {capacity} = require('../electron/backend/backup-capacity.cjs');
const {appearanceStatus} = require('../electron/appearance.cjs');
const roots = new Set(), stores = new Set();
const root = () => { const p=fs.mkdtempSync(path.join(os.tmpdir(),'labmate-release-')); roots.add(p); return p; };
const value = r => { assert.equal(r.ok,true,JSON.stringify(r.error)); return r.value; };
function library(options) { const store=new LibraryStore(root(), options); stores.add(store); value(store.dispatch('records.createNotebook',{name:'Lab',description:'',discipline:'Chemistry',color:'sage'})); const id=store.snapshot().notebooks[0].id; value(store.dispatch('records.createExperiment',{notebookId:id,label:'Experiment',title:'Original',date:'2026-09-16',author:'Scientist'})); return store; }
const request = destination => ({password:'disposable-test-password', jobId:crypto.randomUUID(), destination});
test.afterEach(() => { for(const store of stores) { try {store.close();}catch{} } stores.clear(); for(const p of roots) fs.rmSync(p,{recursive:true,force:true}); roots.clear(); });

test('local checkpoint succeeds offline, retries after restart, skips unchanged work, and rehearses without replacing the library', async () => {
  let store=library(); const libraryRoot=store.root;
  const first=await runManagedBackup(store,request(null));
  assert.equal(first.pendingDeliveryCount,1); assert.ok(first.lastLocalBackupAt); assert.equal(first.lastBoxCopyAt,undefined);
  const archive=readCatalog(libraryRoot).archives[0];
  store.close(); store=new LibraryStore(libraryRoot); stores.add(store);
  const generation=store.libraryGeneration;
  const box=root(); const delivered=await runManagedBackup(store,request(box));
  assert.equal(delivered.pendingDeliveryCount,0); assert.ok(delivered.lastBoxCopyAt);
  assert.equal(readCatalog(libraryRoot).archives.length,1);
  assert.equal(fs.readFileSync(path.join(box,archive.name)).equals(fs.readFileSync(path.join(libraryRoot,'backups',archive.name))),true);
  const verified=await verifyBackup(libraryRoot,{...request(),source:path.join(box,archive.name)});
  assert.equal(verified.verified,true); assert.equal(verified.records.runs,1); assert.equal(store.libraryGeneration,generation);
  assert.equal(store.snapshot().runs[0].title,'Original'); assert.equal(readCatalog(libraryRoot).rehearsal.sha256,archive.sha256);
  await assert.rejects(verifyBackup(libraryRoot,{...request(),password:'wrong',source:path.join(box,archive.name)}));
  assert.equal(store.libraryGeneration,generation);
});

test('attachment capture pins immutable objects while later edits and purge continue', async () => {
  const store=library(); const bytes=Buffer.from('pinned attachment'); const hash=crypto.createHash('sha256').update(bytes).digest('hex');
  fs.writeFileSync(path.join(store.root,'objects',hash),bytes);
  const run=store.snapshot().runs[0];
  store.addAttachment({id:crypto.randomUUID(),runId:run.id,name:'proof.txt',mime:'text/plain',kind:'file',hash,size:bytes.length,caption:'Original caption',createdAt:new Date().toISOString()});
  const captured=await capture(store);
  store.removeAttachment(store.snapshot().attachments[0].id);
  assert.equal(fs.existsSync(path.join(store.root,'objects',hash)),false);
  assert.deepEqual(fs.readFileSync(path.join(captured.stage,'objects',hash)),bytes);
});

test('mutation updates contain only affected records and preserve complete initial snapshots', () => {
  const store=library({mutationUpdates:true}); const initial=store.snapshot(); const run=initial.runs[0];
  const update=value(store.dispatch('records.updateRun',{id:run.id,expectedRevision:run.revision,changes:{title:'Updated'}}));
  assert.equal(update.kind,'mutation'); assert.equal(update.runs.length,1); assert.equal(update.notebooks.length,0); assert.equal(update.experiments.length,0); assert.deepEqual(update.replaceIds.runs,[run.id]); assert.equal(update.libraryGeneration,initial.libraryGeneration);
  const prefs=value(store.dispatch('preferences.update',{material:'glass',appearance:88})); assert.equal(prefs.runs.length,0); assert.equal(prefs.preferences.material,'glass');
  store.reopen(); assert.equal(store.snapshot().runs[0].title,'Updated'); assert.equal(store.snapshot().preferences.material,'glass'); assert.notEqual(store.libraryGeneration,initial.libraryGeneration);
});

test('committed restore returns authoritative data even if cleanup fails', async () => {
  const store=library(); const backup=await createBackupService(store).create(request()); const run=store.snapshot().runs[0];
  value(store.dispatch('records.updateRun',{id:run.id,expectedRevision:run.revision,changes:{title:'Later'}}));
  const restored=await createBackupService(store,{onSwitchPhase:phase=>{if(phase==='opened') throw new Error('injected cleanup failure');}}).restore({...request(),source:path.join(store.root,'backups',backup.name)});
  assert.equal(restored.runs[0].title,'Original'); assert.ok(restored.recoveryWarnings.length); assert.equal(store.snapshot().runs[0].title,'Original');
  store.close(); const reopened=new LibraryStore(store.root); stores.add(reopened); assert.equal(reopened.snapshot().runs[0].title,'Original');
});

test('a corrupt current database remains recoverable while a good incoming archive restores', async () => {
  const good=library(); const backup=await createBackupService(good).create(request());
  const brokenRoot=root(); fs.mkdirSync(path.join(brokenRoot,'objects')); fs.writeFileSync(path.join(brokenRoot,'library.sqlite'),'damaged current database');
  const broken=new LibraryStore(brokenRoot,{deferOpen:true}); stores.add(broken);
  const restored=await createBackupService(broken).restore({...request(),source:path.join(good.root,'backups',backup.name)});
  assert.equal(restored.runs[0].title,'Original');
  const rollbacks=fs.readdirSync(path.join(brokenRoot,'rollback')).filter(n=>n.startsWith('rollback-'));
  assert.ok(rollbacks.length); assert.equal(fs.readFileSync(path.join(brokenRoot,'rollback',rollbacks[0],'library.sqlite'),'utf8'),'damaged current database');
});

test('retention uses the calendar union, pins rehearsal and pending deliveries, and counts overlap once', () => {
  const archives=Array.from({length:120},(_,i)=>({name:`labmate-${i}.labmatebackup`,capturedAt:new Date(Date.UTC(2026,8,16-i)).toISOString(),sha256:String(i).padStart(64,'0'),copies:[{directory:'/box'}]}));
  const catalog={archives,rehearsal:{sha256:archives[110].sha256}};
  const kept=retainedArchives(catalog,'/box'); assert.equal(kept.has(archives[110].name),true); assert.equal(kept.has(archives[119].name),false); assert.ok(kept.size>=30 && kept.size<=43);
  archives[119].copies=[]; assert.equal(retainedArchives(catalog,'/box').has(archives[119].name),true);
});

test('capacity counts unique attachment content and rejects individual and complete backup overflows', () => {
  const store=library(); const a={hash:'a'.repeat(64),size:800*1024**2};
  assert.equal(capacity(store,[a,a]).objectCount,1); assert.equal(capacity(store,[a,a]).issue,undefined);
  assert.match(capacity(store,[{...a,size:1024**3+1}]).issue,/1 GiB/);
  assert.match(capacity(store,[a,{hash:'b'.repeat(64),size:800*1024**2},{hash:'c'.repeat(64),size:800*1024**2}]).issue,/2 GiB/);
});

test('Glass falls back to Solid for accessibility and unsupported platforms', () => {
  assert.equal(appearanceStatus({},'glass','darwin').material,'glass');
  for(const setting of ['prefersReducedTransparency','shouldUseHighContrastColors']) assert.equal(appearanceStatus({[setting]:true},'glass','darwin').material,'solid');
  assert.equal(appearanceStatus({},'glass','linux').material,'solid');
  assert.equal(appearanceStatus({},'solid','darwin').material,'solid');
});

test('process interruption at every durable restore phase recovers one coherent library', async () => {
  const {spawnSync}=require('node:child_process');
  const original=library(); const made=await createBackupService(original).create(request()); const archive=path.join(original.root,'backups',made.name);
  for(const phase of ['prepared','db-moved','objects-moved','candidate-db-moved','candidate-objects-moved','opened','committed']) {
    const current=library(); const before=current.snapshot(); const targetRoot=current.root; current.close();
    const child=spawnSync(process.execPath,[path.join(__dirname,'helpers','restore-crash.cjs'),targetRoot,archive,phase],{encoding:'utf8',timeout:15000});
    assert.equal(child.status,73,`${phase}: ${child.stderr}`);
    const recovered=new LibraryStore(targetRoot); stores.add(recovered);
    const expected=['opened','committed'].includes(phase) ? original.snapshot().runs[0].id : before.runs[0].id;
    assert.equal(recovered.snapshot().runs[0].id,expected,phase);
    assert.equal(recovered.db.pragma('integrity_check',{simple:true}),'ok',phase);
    assert.deepEqual(recovered.db.pragma('foreign_key_check'),[],phase);
  }
});

test('Retry reinitializes services after a temporary startup obstruction is removed', async () => {
  const {createWorkerRuntime}=require('../electron/backend/worker.cjs'); const targetRoot=root(); fs.writeFileSync(path.join(targetRoot,'objects'),'temporary obstruction');
  const messages=[]; const runtime=createWorkerRuntime({root:targetRoot,parentPort:{on(){},postMessage:m=>messages.push(m)}});
  runtime.receive({id:'first',method:'records.snapshot',payload:undefined}); await runtime.waitForIdle(); assert.equal(messages.find(m=>m.id==='first').result.ok,false);
  fs.unlinkSync(path.join(targetRoot,'objects')); runtime.receive({id:'retry',method:'records.snapshot',payload:undefined}); await runtime.waitForIdle(); assert.equal(messages.find(m=>m.id==='retry').result.ok,true); await runtime.close();
});

test('a missing current attachment does not veto restoration and old bytes remain preserved', async () => {
  const store=library(); const backup=await createBackupService(store).create(request()); const run=store.snapshot().runs[0]; const hash=crypto.createHash('sha256').update('lost').digest('hex');
  fs.writeFileSync(path.join(store.root,'objects',hash),'lost'); store.addAttachment({id:crypto.randomUUID(),runId:run.id,name:'lost.txt',mime:'text/plain',kind:'file',hash,size:4,caption:'Lost',createdAt:new Date().toISOString()}); fs.unlinkSync(path.join(store.root,'objects',hash));
  const restored=await createBackupService(store).restore({...request(),source:path.join(store.root,'backups',backup.name)}); assert.equal(restored.attachments.length,0); assert.equal(restored.runs.length,1); assert.ok(fs.readdirSync(path.join(store.root,'rollback')).length);
});

test('old-generation mutations are refused after a library is reopened', async () => {
  const {createWorkerRuntime}=require('../electron/backend/worker.cjs'); const store=library({mutationUpdates:true}); const old=store.libraryGeneration; store.reopen(); const messages=[];
  const runtime=createWorkerRuntime({root:store.root,services:{store},parentPort:{on(){},postMessage:m=>messages.push(m)}});
  runtime.receive({id:'old',method:'preferences.update',payload:{material:'glass'},libraryGeneration:old}); await runtime.waitForIdle(); assert.equal(messages.find(m=>m.id==='old').result.error.code,'STALE_REVISION'); assert.equal(store.snapshot().preferences.material,'solid');
  runtime.receive({id:'fresh',method:'preferences.update',payload:{material:'glass'},libraryGeneration:store.libraryGeneration}); await runtime.waitForIdle(); assert.equal(messages.find(m=>m.id==='fresh').result.value.kind,'mutation'); await runtime.close();
});

test('late cancellation through the worker cannot conceal a committed restore', async () => {
 const {createWorkerRuntime}=require('../electron/backend/worker.cjs');const store=library();const saved=await createBackupService(store).create(request());const run=store.snapshot().runs[0];value(store.dispatch('records.updateRun',{id:run.id,expectedRevision:run.revision,changes:{title:'Changed'}}));const messages=[];let runtime;
 const service=createBackupService(store,{onSwitchPhase:phase=>{if(phase==='committed')runtime.receive({id:'cancel',method:'jobs.cancel',payload:{jobId:'late-restore'}});}});
 runtime=createWorkerRuntime({root:store.root,services:{store,backupService:service},parentPort:{on(){},postMessage:m=>messages.push(m)}});
 runtime.receive({id:'restore',method:'backups.restore',payload:{password:request().password,jobId:'late-restore',source:path.join(store.root,'backups',saved.name)}});await runtime.waitForIdle();assert.equal(messages.find(m=>m.id==='restore').result.ok,true,JSON.stringify(messages));assert.equal(messages.find(m=>m.id==='cancel').result.value.cancelled,false);assert.equal(messages.find(m=>m.id==='restore').result.value.runs[0].title,'Original');await runtime.close();
});

test('rename failure at every restore publication step preserves a coherent reopen', async () => {
 const source=library();const saved=await createBackupService(source).create(request());
 for(let failAt=1;failAt<=10;failAt++) {
  const store=library();const oldId=store.snapshot().runs[0].id;const original=fs.promises.rename;let calls=0,injected=false;
  fs.promises.rename=async(from,to)=>{if(String(to).startsWith(store.root)&&++calls===failAt){injected=true;throw Object.assign(new Error('injected rename failure'),{code:'EIO'});}return original(from,to);};
  try{await createBackupService(store).restore({...request(),source:path.join(source.root,'backups',saved.name)});}catch(error){assert.ok(['IO','CORRUPT_BACKUP'].includes(error.code));}finally{fs.promises.rename=original;}
  assert.equal(injected,true);store.close();const reopened=new LibraryStore(store.root);stores.add(reopened);assert.equal(reopened.db.pragma('integrity_check',{simple:true}),'ok');assert.ok([oldId,source.snapshot().runs[0].id].includes(reopened.snapshot().runs[0].id));
 }
});

test('disk-capacity failure leaves the saved library and previous checkpoint intact', async () => {
 const store=library();await runManagedBackup(store,request(null));const before=readCatalog(store.root).archives[0].sha256;const old=fs.statfsSync;fs.statfsSync=()=>({bavail:0,bsize:4096});
 try{await assert.rejects(runManagedBackup(store,{...request(null),force:true}),/free space/);}finally{fs.statfsSync=old;}
 assert.equal(readCatalog(store.root).archives[0].sha256,before);assert.equal(store.snapshot().runs[0].title,'Original');
});

test('startup removes only owned interrupted capture directories', async () => {
 const store=library();const pinned=await capture(store);const directory=path.dirname(pinned.stage);const unknown=path.join(directory,'unknown');fs.mkdirSync(unknown);const target=root();fs.symlinkSync(target,path.join(directory,'capture-ABCDEF'));require('../electron/backend/backup-manager.cjs').cleanInterruptedCaptures(store.root);assert.equal(fs.existsSync(pinned.stage),false);assert.equal(fs.existsSync(unknown),true);assert.equal(fs.lstatSync(path.join(directory,'capture-ABCDEF')).isSymbolicLink(),true);assert.equal(store.snapshot().runs.length,1);
});

test('a failed journal write cannot replace the working library', async () => {
 const store=library();const saved=await createBackupService(store).create(request());const run=store.snapshot().runs[0];value(store.dispatch('records.updateRun',{id:run.id,expectedRevision:run.revision,changes:{title:'Keep current'}}));const original=fs.promises.open;let injected=false;
 fs.promises.open=async(file,...args)=>{if(String(file).includes('restore-journal.json.partial-')){injected=true;throw Object.assign(new Error('injected journal write failure'),{code:'EIO'});}return original(file,...args);};
 try{await assert.rejects(createBackupService(store).restore({...request(),source:path.join(store.root,'backups',saved.name)}));}finally{fs.promises.open=original;}
 assert.equal(injected,true);assert.equal(store.snapshot().runs[0].title,'Keep current');store.close();const reopened=new LibraryStore(store.root);stores.add(reopened);assert.equal(reopened.snapshot().runs[0].title,'Keep current');
});

test('recovery rehearsal pins the authenticated bytes even if the source is replaced', async () => {
 const store=library();await runManagedBackup(store,request(null));const archive=readCatalog(store.root).archives[0];const source=path.join(root(),'download.labmatebackup');fs.copyFileSync(path.join(store.root,'backups',archive.name),source);let replaced=false;
 const result=await verifyBackup(store.root,{password:request().password,jobId:'changing-download',source},{onProgress:event=>{if(!replaced&&event.phase==='switching'){replaced=true;fs.writeFileSync(source,'replaced cloud download');}}});
 assert.equal(replaced,true);assert.equal(result.verified,true);assert.equal(readCatalog(store.root).rehearsal.sha256,archive.sha256);assert.equal(store.snapshot().runs[0].title,'Original');
});
