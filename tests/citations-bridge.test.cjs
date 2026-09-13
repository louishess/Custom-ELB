'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {LibraryStore}=require('../electron/backend/store.cjs');
const {createBridgeRuntime,validateRendererPayload}=require('../electron/main.cjs');
const {createZoteroService}=require('../electron/zotero.cjs');
const {payloadShapeError}=require('../electron/backend/worker.cjs');

test('main fetches authoritative metadata, binds refresh to the requesting window, and rejects forged write payloads',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'labmate-citation-bridge-'));const store=new LibraryStore(root);
  t.after(()=>{store.close();fs.rmSync(root,{recursive:true,force:true});});
  const unwrap=r=>{assert.equal(r.ok,true,JSON.stringify(r));return r.value;};
  const notebook=unwrap(store.dispatch('records.createNotebook',{name:'N',description:'',discipline:'',color:'sage'})).notebooks[0];
  unwrap(store.dispatch('records.createExperiment',{notebookId:notebook.id,label:'A',title:'Experiment',date:'2026-09-12',author:'Researcher'}));
  let title='Verified source title';
  const runtime=createBridgeRuntime({root,env:{LABMATE_LIBRARY_ROOT:root,LABMATE_TEST_PROFILE:path.join(root,'profile')},appApi:{getPath:()=>root},
    zoteroFactory:options=>createZoteroService({...options,request:async route=>({status:200,headers:{'zotero-api-version':'3','zotero-server-id':'source'},body:route==='/api/'?'':JSON.stringify({key:'ABCD1234',version:1,data:{itemType:'journalArticle',title}})})})});
  runtime.worker={request:async(method,payload)=>method==='jobs.cancel'?{ok:true,value:{cancelled:true}}:store.dispatch(method,payload)};
  const frame={url:'elb://app/index.html'};const sender={id:7,mainFrame:frame,getURL:()=>frame.url};const event={sender,senderFrame:frame};
  const call=async(method,input,override=event)=>runtime.handleInvoke(override,method,input);
  const status=unwrap(await call('zotero.connect'));
  const target=()=>({experimentId:store.snapshot().experiments[0].id,expectedRevision:store.snapshot().experiments[0].revision,libraryGeneration:store.libraryGeneration});
  const identity={sourceInstance:'source',libraryType:'user',libraryId:'0',itemKey:'ABCD1234'};const sessionId=crypto.randomUUID();
  assert.equal(validateRendererPayload('citations.add',{...target(),generation:status.generation,sessionId,items:[{...identity,snapshot:{title:'forged'}}]}).ok,false);
  assert.equal(validateRendererPayload('zotero.search',{generation:status.generation,libraryType:'user',libraryId:'0',start:0,query:'',url:'https://example.com'}).ok,false);
  assert.notEqual(payloadShapeError('citations.add',{...target(),items:[identity],jobId:crypto.randomUUID()},true),null);
  let s=unwrap(await call('citations.add',{...target(),generation:status.generation,sessionId,items:[identity]}));
  assert.equal(s.citations[0].snapshot.title,title);assert.equal(s.runs[0].revision,1);
  title='Updated title';const before=target();
  const preview=unwrap(await call('citations.previewRefresh',{...before,id:s.citations[0].id,generation:status.generation,sessionId}));
  assert.equal(store.snapshot().citations[0].snapshot.title,'Verified source title');
  const foreign={sender:{...sender,id:8},senderFrame:frame};
  assert.equal((await call('citations.applyRefresh',{...before,token:preview.token,sessionId},foreign)).ok,false);
  s=unwrap(await call('citations.applyRefresh',{...before,token:preview.token,sessionId}));assert.equal(s.citations[0].snapshot.title,'Updated title');
  unwrap(await call('zotero.cancel',{sessionId}));
  assert.equal((await call('citations.add',{...target(),generation:status.generation,sessionId,items:[identity]})).error.code,'CANCELLED');
  // Simulate a citation mutation queued behind a backup. Disconnect must send
  // cancellation into the worker queue, not only abort the completed HTTP read.
  const originalRequest=runtime.worker.request;
  let queuedResolve, entered;
  const queued=new Promise(resolve=>{entered=resolve;});
  let cancelled=false;
  runtime.worker.request=async(method,payload)=>{
    if(method==='citations.add') return new Promise(resolve=>{queuedResolve=resolve;entered();});
    if(method==='jobs.cancel') {cancelled=true;queuedResolve({ok:false,error:{code:'CANCELLED',message:'Queued write cancelled'}});return {ok:true,value:{cancelled:true}};}
    return originalRequest(method,payload);
  };
  const pending=call('citations.add',{...target(),generation:status.generation,sessionId:crypto.randomUUID(),items:[identity]});
  await queued;unwrap(await call('zotero.disconnect'));
  assert.equal((await pending).error.code,'CANCELLED');assert.equal(cancelled,true);
  assert.equal(store.snapshot().citations.length,1);
});
