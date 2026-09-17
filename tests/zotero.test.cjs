'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {createZoteroService,requestLocal}=require('../electron/zotero.cjs');
const {schemas,normalizeItem,referenceText}=require('../shared/citations.cjs');
const {plainCitation,citationLabel}=require('../shared/citations.cjs');
const headers={'zotero-server-id':'test-source','zotero-api-version':'3','x-zotero-version':'11.test'};
const raw={key:'ABCD1234',version:5,data:{itemType:'journalArticle',title:'Original title',creators:[{name:'Research Group',creatorType:'author'}],date:'2026'}};
test('formatted labels are plain text, style-specific, and identify numeric-style references',()=>{
  const identity={sourceInstance:'source',libraryType:'user',libraryId:'0',itemKey:raw.key};
  assert.equal(plainCitation('<span>(Smith &amp; Jones, &#x2026;)</span><script>alert(1)</script>'),'(Smith & Jones, …)');
  assert.equal(plainCitation('&#99999999;'),'�');
  assert.equal(plainCitation('a'.repeat(4001)),'');
  const item=normalizeItem({...raw,citation:'<sup>1</sup>',bib:'<div>Smith, A. <i>Coupling &amp; Catalysis</i>. 2026.</div>'},identity,'My Library',new Date(),'american-chemical-society');
  assert.equal(item.snapshot.formattedCitation.text,'Smith, A. Coupling & Catalysis. 2026.');
  assert.equal(citationLabel(item.snapshot,{citationLabel:'formatted',citationStyle:'american-chemical-society'}),item.snapshot.formattedCitation.text);
  for(const preferences of [{citationLabel:'title',citationStyle:'american-chemical-society'},{citationLabel:'formatted',citationStyle:''},{citationLabel:'formatted',citationStyle:'apa'}])assert.equal(citationLabel(item.snapshot,preferences),'Original title');
  assert.equal(normalizeItem({...raw,citation:'(Smith, 2026)'},identity,'My Library').snapshot.formattedCitation,undefined);
});
test('only the explicitly selected citation style is sent to Zotero',async t=>{
  const {service,calls}=fake(t);const {generation}=await service.connect();
  const identity={sourceInstance:'test-source',libraryType:'user',libraryId:'0',itemKey:raw.key};
  await service.item(identity,generation);assert.equal(calls.at(-1).route,'/api/users/0/items/ABCD1234');
  await service.item(identity,generation,undefined,'american-chemical-society');assert.match(calls.at(-1).route,/include=data%2Ccitation%2Cbib&style=american-chemical-society/);
  await assert.rejects(()=>service.item(identity,generation,undefined,'https://example.com/style'),e=>e.code==='VALIDATION');
});
function fake(t,handler) {
  const calls=[];
  const service=createZoteroService({request:async(route,options)=>{calls.push({route,options});return handler?handler(route,options):{status:200,headers,body:JSON.stringify(raw)};}});
  t.after(()=>service.dispose()); return {service,calls};
}
test('capability probe distinguishes disabled, unsupported, offline and connected clients', async t=>{
  for(const [response,state] of [[{status:403,headers},'disabled'],[{status:200,headers:{}},'unsupported'],[{status:200,headers},'connected']]) {
    const {service}=fake(t,()=>response); assert.equal((await service.connect()).state,state);
  }
  const {service}=fake(t,()=>{throw new Error('ECONNREFUSED');});assert.equal((await service.connect()).state,'unavailable');
});
test('connection preference persists outside the citation database; disconnect preserves source records elsewhere',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'labmate-zotero-config-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const configPath=path.join(root,'zotero.json'); const request=async()=>({status:200,headers});
  const first=createZoteroService({configPath,request});await first.connect();first.dispose();
  const second=createZoteroService({configPath,request});assert.equal((await second.status()).state,'connected');
  second.disconnect();second.dispose();const third=createZoteroService({configPath,request});assert.equal((await third.status()).state,'disconnected');third.dispose();
});
test('browses libraries, collections and filtered pages using bounded GET routes',async t=>{
  const {service,calls}=fake(t,route=>{
    const data=route.includes('/groups?')?[{id:42,data:{name:'Chemistry group'}}]:route.includes('/collections?')?[{key:'COLL1234',data:{name:'Methods',parentCollection:false}}]:route.includes('/items/top')?[{key:'FILE1234',data:{itemType:'attachment'}},raw]:raw;
    return {status:200,headers:{...headers,'total-results':route.includes('/items/top')?'52':String(data.length||1)},body:JSON.stringify(data)};
  });
  const {generation}=await service.connect();
  const libraries=await service.libraries({generation,start:0});assert.deepEqual(libraries.items.map(x=>x.name),['My Library','Chemistry group']);
  const q={generation,libraryType:'group',libraryId:'42',start:0};
  assert.equal((await service.collections(q)).items[0].name,'Methods');
  const result=await service.search({...q,query:'copper & palladium',collectionKey:'COLL1234'});
  assert.equal(result.items.length,1);assert.equal(result.nextStart,2);assert.equal(result.items[0].libraryId,'42');
  assert.ok(calls.slice(1).every(c=>c.options.sourceInstance==='test-source'));
  assert.ok(calls.find(c=>c.route.includes('q=copper+%26+palladium')));
  assert.ok(calls.slice(1).every(c=>c.route.includes('limit=50')));
});
test('source mismatch invalidates generations without rebinding saved identity',async t=>{
  let changed=false;
  const {service}=fake(t,()=>({status:changed?412:200,headers:changed?{...headers,'zotero-server-id':'other'}:headers,body:JSON.stringify(raw)}));
  const {generation}=await service.connect();changed=true;
  await assert.rejects(()=>service.item({sourceInstance:'test-source',libraryType:'user',libraryId:'0',itemKey:raw.key},generation),e=>e.code==='STALE_REVISION');
  assert.throws(()=>service.check(generation),e=>e.code==='STALE_REVISION');
});
test('a profile change during a connection outage still invalidates the previous source',async t=>{
  let offline=false, source='test-source';
  const {service}=fake(t,()=>{if(offline)throw new Error('offline');return {status:200,headers:{...headers,'zotero-server-id':source}};});
  const before=await service.connect();offline=true;assert.equal((await service.status()).state,'unavailable');
  offline=false;source='new-source';const after=await service.status();
  assert.equal(after.state,'source-changed');assert.notEqual(after.generation,before.generation);
  assert.equal((await service.connect()).sourceInstance,'new-source');
});
test('refresh previews expire, bind their session and target, and never accept renderer metadata',async t=>{
  const {service}=fake(t);const {generation}=await service.connect();
  const identity={sourceInstance:'test-source',libraryType:'user',libraryId:'0',itemKey:raw.key};
  const item=await service.item(identity,generation);const target={experimentId:crypto.randomUUID(),expectedRevision:1,libraryGeneration:crypto.randomUUID()};
  const preview=service.preview('owner:session',target,'id',item,generation);
  assert.throws(()=>service.consume(preview.token,'other',target),e=>e.code==='STALE_REVISION');
  assert.throws(()=>service.consume(preview.token,'owner:session',{...target,expectedRevision:2}),e=>e.code==='STALE_REVISION');
  assert.equal(service.consume(preview.token,'owner:session',target).item.snapshot.title,'Original title');
  assert.throws(()=>service.consume(preview.token,'owner:session',target));
  assert.equal(schemas['citations.add'].safeParse({...target,generation,sessionId:crypto.randomUUID(),items:[item]}).success,false);
});
test('closing the picker cancels metadata fetch and prevents a delayed session replay',async t=>{
  let pending;
  const {service}=fake(t,(route,options)=>route==='/api/'?{status:200,headers}:new Promise((resolve,reject)=>{
    pending=()=>resolve({status:200,headers,body:JSON.stringify(raw)});
    options.signal.addEventListener('abort',()=>reject(Object.assign(new Error('cancelled'),{code:'CANCELLED'})));
  }));
  const {generation}=await service.connect();
  const waiting=service.withSession('test',signal=>service.item({sourceInstance:'test-source',libraryType:'user',libraryId:'0',itemKey:raw.key},generation,signal));
  service.cancel('test');pending();await assert.rejects(()=>waiting,e=>e.code==='CANCELLED');
  await assert.rejects(()=>service.withSession('test',()=>null),e=>e.code==='CANCELLED');
});
test('missing source stays missing; malicious fields remain plain text and unsafe URLs are removed',async t=>{
  const {service}=fake(t,route=>({status:route==='/api/'?200:404,headers}));const {generation}=await service.connect();
  await assert.rejects(()=>service.item({sourceInstance:'test-source',libraryType:'user',libraryId:'0',itemKey:raw.key},generation),e=>e.code==='NOT_FOUND');
  const item=normalizeItem({...raw,data:{...raw.data,title:'<img src=x onerror=alert(1)>',url:'javascript:alert(1)'}},{sourceInstance:'s',libraryType:'user',libraryId:'0',itemKey:raw.key},'My Library');
  assert.equal(item.snapshot.url,'');assert.match(referenceText(item.snapshot),/<img/);
});
test('real loopback transport bounds responses, does not follow redirects, and times out',async t=>{
  const server=require('node:http').createServer((req,res)=>{
    assert.equal(req.method,'GET');assert.match(req.headers['user-agent'],/^LabMate\//);assert.equal(req.headers.origin,undefined);
    if(req.url==='/api/redirect') {res.writeHead(302,{Location:'https://example.com/'});res.end();}
    else if(req.url==='/api/large') res.end('x'.repeat(1000));
    else if(req.url==='/api/wait') return;
    else {res.writeHead(200,headers);res.end('{}');}
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  t.after(()=>{server.closeAllConnections();server.close();});const port=server.address().port;
  assert.equal((await requestLocal('/api/',{port})).status,200);
  assert.equal((await requestLocal('/api/redirect',{port})).status,302);
  await assert.rejects(()=>requestLocal('/api/large',{port,maxBytes:100}),e=>e.code==='IO');
  await assert.rejects(()=>requestLocal('/api/wait',{port,timeout:20}),e=>e.code==='UNAVAILABLE');
  await assert.rejects(()=>requestLocal('https://example.com/',{port}),e=>e.code==='VALIDATION');
});
