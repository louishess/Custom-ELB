'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { LibraryStore } = require('../electron/backend/store.cjs');
const { createWorkerRuntime } = require('../electron/backend/worker.cjs');
const { runManagedBackup, deliverAndRotate } = require('../electron/backend/backup-manager.cjs');
const { runCloudProcess, probeCloudDestination, stageCloudBackup } = require('../electron/backend/cloud-process.cjs');
const { readCatalog, writeCatalog, retainedArchives } = require('../electron/backend/backup-catalog.cjs');
const main = require('../electron/main.cjs');
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function temporary(t) { const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'labmate-delivery-test-'))); t.after(() => fs.rmSync(root, {recursive:true,force:true})); return root; }
function stalledProcess(onSend = () => {}) {
  const child = new EventEmitter();
  child.send = (payload, callback) => { child.payload = payload; onSend(payload); callback?.(); };
  child.kill = signal => { child.killed = signal; return true; };
  return child;
}
async function eventually(check) {
  const deadline = Date.now() + 3000;
  while (!check()) { if (Date.now() > deadline) throw new Error('Expected operation did not finish.'); await delay(5); }
}

test('provider timeout is isolated and does not send credentials or wait for process exit', async () => {
  const child = stalledProcess();
  await assert.rejects(runCloudProcess({operation:'deliver',root:'/local',catalog:{archives:[]}}, {timeoutMs:20,forkProcess:()=>child}), /did not respond/);
  assert.equal(child.killed, 'SIGKILL');
  assert.equal(Object.hasOwn(child.payload, 'password'), false);
  child.emit('message', {result:{late:true}}); // An abandoned reply is ignored.
  const result = await probeCloudDestination('/home','/provider',{timeoutMs:20,forkProcess:()=>stalledProcess()});
  assert.equal(result.available,false);
});

test('stalled Box resolution cannot prevent local capture, saves, another checkpoint, or delivery cancellation', async t => {
  const root = temporary(t), store = new LibraryStore(root, {mutationUpdates:true});
  t.after(() => store.close());
  const destination = path.join(root, 'unresponsive-provider');
  const originalRealpath = fs.promises.realpath;
  let providerCallsInBackend = 0;
  fs.promises.realpath = (...args) => { if (args[0] === destination) { providerCallsInBackend++; return new Promise(()=>{}); } return originalRealpath(...args); };
  t.after(() => { fs.promises.realpath = originalRealpath; });
  const started = deferred(), messages = [], children = [];
  const runtime = createWorkerRuntime({root,parentPort:{on(){},postMessage:m=>messages.push(m)},services:{store,backupService:{create:(request,context)=>runManagedBackup(store,request,{...context,runDelivery:(payload,options)=>runCloudProcess(payload,{...options,timeoutMs:200,forkProcess:()=>{
    const child = stalledProcess(data => {
      assert.ok(readCatalog(root).archives.length > 0, 'checkpoint must be durable before provider process starts');
      assert.equal(JSON.stringify(data).includes('private-password'),false);
      started.resolve();
    }); children.push(child); return child;
  }})})}}});
  runtime.receive({id:'backup',method:'backups.run',payload:{jobId:'slow-box',password:'private-password',destination}});
  await Promise.race([started.promise,delay(3000).then(()=>{throw new Error('Local checkpoint was blocked by provider I/O.');})]);
  runtime.receive({id:'save',method:'preferences.update',payload:{material:'glass'},libraryGeneration:store.libraryGeneration});
  await eventually(()=>messages.some(m=>m.id==='save'));
  assert.equal(messages.find(m=>m.id==='save').result.ok,true);
  assert.equal(messages.some(m=>m.id==='backup'),false);
  await runtime.waitForIdle();
  assert.equal(children[0].killed,'SIGKILL');
  assert.equal(messages.find(m=>m.id==='backup').result.value.pendingDeliveryCount,1);
  assert.equal(providerCallsInBackend,0);
  const before = readCatalog(root).archives[0].token;
  runtime.receive({id:'second',method:'backups.run',payload:{jobId:'second-box',password:'private-password',destination}});
  await eventually(()=>children.length===2);
  runtime.receive({id:'cancel',method:'jobs.cancel',payload:{jobId:'second-box'}});
  await runtime.waitForIdle();
  assert.equal(messages.find(m=>m.id==='cancel').result.value.cancelled,true);
  assert.equal(messages.find(m=>m.id==='second').result.ok,true);
  assert.equal(readCatalog(root).archives.length,2);
  assert.notEqual(readCatalog(root).archives[1].token,before);
  assert.equal(children[1].killed,'SIGKILL');
});

test('credential and status reads never probe the configured provider path synchronously', t => {
  const root=temporary(t), destination=path.join(root,'provider'); let probes=0;
  const fsApi = {...fs};
  for (const method of ['lstatSync','statSync','accessSync','realpathSync']) fsApi[method] = (...args) => {
    if (args[0] === destination) { probes++; throw new Error('Provider would block.'); }
    return fs[method](...args);
  };
  const config = new main.LocalConfigStore({appApi:{getPath:()=>root},fsApi,safeStorageApi:{isEncryptionAvailable:()=>true,encryptString:s=>Buffer.from(s),decryptString:b=>b.toString()}});
  assert.equal(config.configure(destination,'test-password').ok,true);
  assert.equal(config.readUsable().value.password,'test-password');
  assert.equal(config.readStatus().ok,true);
  assert.equal(probes,0);
});

async function history(t) {
  const root=temporary(t), destination=temporary(t); fs.mkdirSync(path.join(root,'backups'));
  const catalog={version:1,archives:[],rehearsal:null,lastFailure:null};
  for(let i=0;i<80;i++) {
    const bytes=Buffer.from(`owned-archive-${i}`),name=`archive-${i}.labmatebackup`;
    fs.writeFileSync(path.join(root,'backups',name),bytes); fs.writeFileSync(path.join(destination,name),bytes);
    catalog.archives.push({name,sha256:crypto.createHash('sha256').update(bytes).digest('hex'),capturedAt:new Date(Date.UTC(2026,8,17-i)).toISOString(),token:String(i),copies:[{directory:destination,name,verifiedAt:new Date().toISOString()}]});
  }
  await writeCatalog(root,catalog); return {root,destination,catalog};
}

test('a crash after remote pruning preserves local sources and retry prunes without re-uploading history', async t => {
  const {root,destination,catalog}=await history(t);
  const foreign=path.join(destination,'unknown.labmatebackup');fs.writeFileSync(foreign,'not owned');
  const rehearsal=catalog.archives[75];catalog.rehearsal={sha256:rehearsal.sha256,name:rehearsal.name,at:new Date().toISOString(),records:{}};await writeCatalog(root,catalog);
  const {deliver}=require('../electron/backend/cloud-worker.cjs');
  const interrupted=await deliverAndRotate(root,{destination,jobId:'interrupted'}, {runDelivery:async data=>{await deliver(structuredClone(data));throw new Error('Provider process interrupted before reply.');}});
  assert.match(interrupted.lastFailure.message,/interrupted/);
  assert.equal(readCatalog(root).archives.length,80);
  for(const archive of catalog.archives) assert.equal(fs.existsSync(path.join(root,'backups',archive.name)),true);
  let copies=0;
  const retried=await deliverAndRotate(root,{destination,jobId:'retry'},{onProgress:event=>{if(event.phase==='copying')copies++;}});
  assert.equal(retried.pendingDeliveryCount,0);
  assert.equal(copies,0);
  assert.ok(readCatalog(root).archives.length<80);
  assert.equal(fs.readFileSync(foreign,'utf8'),'not owned');
  assert.equal(fs.existsSync(path.join(root,'backups',rehearsal.name)),true);
});

test('local pruning publishes catalog removal before unlinking and rejects unowned prune replies', async t => {
  const {root,destination,catalog}=await history(t);
  const keep=retainedArchives(catalog,destination), candidate=catalog.archives.find(a=>!keep.has(a.name));
  const original=fs.promises.unlink;let observed=false;
  fs.promises.unlink=async file=>{
    if(file===path.join(root,'backups',candidate.name)) {
      observed=true;assert.equal(readCatalog(root).archives.some(a=>a.name===candidate.name),false);
      throw new Error('Interrupted before unlink.');
    }
    return original(file);
  };
  try { await deliverAndRotate(root,{destination,jobId:'prune'},{runDelivery:async()=>({destination,destinationAvailable:true,copies:[],prunable:[candidate.name]})}); }
  finally {fs.promises.unlink=original;}
  assert.equal(observed,true);assert.equal(fs.existsSync(path.join(root,'backups',candidate.name)),true);
  const rejected=await deliverAndRotate(root,{destination,jobId:'bad-reply'},{runDelivery:async()=>({destination,destinationAvailable:true,copies:[],prunable:['../../outside']})});
  assert.match(rejected.lastFailure.message,/Invalid Box delivery response/);
});

test('repeated quit stays blocked until local commitment and the pending-delivery decision is explicit', async t => {
  const root=temporary(t), destination=path.join(root,'provider');
  await writeCatalog(root,{version:1,archives:[{name:'local.labmatebackup',sha256:'a'.repeat(64),capturedAt:new Date().toISOString(),token:'1',copies:[]}],lastFailure:{at:new Date().toISOString(),message:'Delivery pending'},rehearsal:null});
  let choice=0,dialogs=0,quits=0,closes=0,backupRequests=0,cancels=0;
  const active=deferred();
  const runtime=main.createBridgeRuntime({root,appApi:{getPath:name=>path.join(root,name),quit(){quits++;}},BrowserWindowApi:{getAllWindows:()=>[]},closeDeliveryTimeoutMs:25,destinationProbe:async()=>({roots:[],available:false}),dictationFactory:()=>({dispose(){}}),zoteroFactory:()=>({dispose(){}}),dialogApi:{showMessageBox:async(_window,options)=>{dialogs++;assert.deepEqual(options.buttons,['Keep LabMate open','Quit with backup pending']);return {response:choice};}},utilityProcessApi:{fork:()=>({on(){},postMessage(){},kill(){}})}});
  runtime.configStore.readRaw=()=>({ok:true,value:{destination}});
  runtime.configStore.readUsable=()=>({ok:true,value:{destination,password:'test'}});
  runtime.configStore.readStatus=()=>({ok:true,value:{destination}});
  runtime.configStore.recordAttempt=()=>({ok:true});
  runtime.worker={request:async(method,payload)=>{
    if(method==='backups.inspect')return {ok:true,value:{}};
    if(method==='jobs.cancel'){cancels++;active.resolve({ok:true,value:{pendingDeliveryCount:1}});return {ok:true,value:{cancelled:true}};}
    if(++backupRequests===1)return active.promise;
    assert.equal(payload.deliveryTimeoutMs,25);return {ok:true,value:{pendingDeliveryCount:1}};
  },close:async()=>{closes++;return {ok:true,value:true};}};
  const backup=runtime.runBackup('active-backup');await delay(0);
  let prevented=0;
  const closing=runtime.closeApplication({preventDefault(){prevented++;}});
  await runtime.closeApplication({preventDefault(){prevented++;}});
  await runtime.closeWindow({preventDefault(){prevented++;}},{});
  assert.equal(prevented,3);assert.equal(cancels,0);assert.equal(dialogs,0);assert.equal(quits,0);
  runtime.forwardProgress({jobId:'active-backup',operation:'backups.run',phase:'delivery',cancellable:true,state:'running'});
  await backup;assert.equal(await closing,false);
  assert.equal(cancels,1);assert.equal(dialogs,1);assert.equal(closes,0);assert.equal(quits,0);
  choice=1;
  assert.equal(await runtime.closeApplication({preventDefault(){}}),true);
  assert.equal(dialogs,2);assert.equal(closes,1);assert.equal(quits,1);
});

function recoveryRuntime(t, incomingStage) {
  const root=temporary(t),source=path.join(root,'download.labmatebackup');
  fs.writeFileSync(source,'downloaded encrypted archive fixture');
  const frame={url:'elb://app/index.html'},event={senderFrame:frame,sender:{mainFrame:frame,getURL:()=>frame.url}};
  const runtime=main.createBridgeRuntime({root,appApi:{getPath:name=>path.join(root,name)},BrowserWindowApi:{getAllWindows:()=>[]},
    ...(incomingStage ? {incomingStage} : {}),
    dialogApi:{showOpenDialog:async()=>({canceled:false,filePaths:[source]}),showMessageBox:async()=>({response:1})},
    utilityProcessApi:{fork:()=>({on(){},postMessage(){},kill(){}})}});
  return {root,source,event,runtime};
}

test('restore and rehearsal give the worker only a verified private local byte copy and clean it afterward', async t => {
  const {source,event,runtime}=recoveryRuntime(t);let calls=0;
  runtime.worker={request:async(method,payload)=>{
    calls++;assert.ok(['backups.verify','backups.restore'].includes(method));
    assert.notEqual(payload.source,source);assert.match(payload.source,/labmate-incoming-/);
    assert.equal(fs.readFileSync(payload.source,'utf8'),'downloaded encrypted archive fixture');
    const value={source:payload.source};
    return {ok:true,value};
  }};
  for(const operation of ['verify','restore']) {
    const result=await runtime.handleInvoke(event,`backups.${operation}`,{jobId:`incoming-${operation}`,password:'local-worker-password'});
    assert.equal(result.ok,true,JSON.stringify(result));
    assert.equal(fs.existsSync(result.value.source),false);
    assert.equal(fs.existsSync(source),true);
  }
  assert.equal(calls,2);
});

test('incoming provider timeout and cancellation never queue a restore or alter the working library', async t => {
  const children=[];
  const {root,source,event,runtime}=recoveryRuntime(t,(file,options)=>stageCloudBackup(file,{...options,timeoutMs:30,forkProcess:()=>{const child=stalledProcess();children.push(child);return child;}}));
  const store=new LibraryStore(root);t.after(()=>store.close());
  const before=store.snapshot();let workerCalls=0;
  runtime.worker={request:async()=>{workerCalls++;throw new Error('Restore must not be queued.');}};
  const result=await runtime.handleInvoke(event,'backups.restore',{jobId:'incoming-timeout',password:'secret-not-for-provider'});
  assert.equal(result.ok,false);assert.equal(result.error.code,'UNAVAILABLE');
  assert.equal(workerCalls,0);assert.deepEqual(store.snapshot(),before);
  assert.equal(children[0].killed,'SIGKILL');
  assert.equal(JSON.stringify(children[0].payload).includes('secret-not-for-provider'),false);
  assert.equal(fs.existsSync(path.dirname(children[0].payload.destination)),false);
  const pending=runtime.handleInvoke(event,'backups.verify',{jobId:'incoming-cancel',password:'secret-not-for-provider'});
  await eventually(()=>children.length===2);
  assert.equal((await runtime.handleInvoke(event,'jobs.cancel',{jobId:'incoming-cancel'})).value.cancelled,true);
  assert.equal((await pending).error.code,'CANCELLED');
  assert.equal(children[1].killed,'SIGKILL');assert.equal(workerCalls,0);assert.equal(fs.existsSync(source),true);
  assert.deepEqual(store.snapshot(),before);
});
