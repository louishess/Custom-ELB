'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {normalizeItem, identitySchema, librarySchema, validate, identityKey} = require('../shared/citations.cjs');
const LIMIT = 50;
function fault(code, message) { return Object.assign(new Error(message), {code}); }

// This transport accepts only service-constructed loopback routes, never renderer URLs.
function requestLocal(route, {signal, sourceInstance, port = 23119, timeout = 5000, maxBytes = 4 * 1024 * 1024} = {}) {
  if (!route.startsWith('/api/') || /[\r\n#]/.test(route)) return Promise.reject(fault('VALIDATION', 'Invalid Zotero route.'));
  return new Promise((resolve, reject) => {
    const request = http.get({hostname:'127.0.0.1', port, path:route, signal, agent:false,
      headers:{Host:`localhost:${port}`, 'User-Agent':'LabMate/0.5', 'Zotero-API-Version':'3', Accept:'application/json',
        ...(sourceInstance ? {'Zotero-Server-ID':sourceInstance} : {})}}, response => {
      const chunks=[]; let size=0;
      response.on('data', chunk => {
        size += chunk.length;
        if (size > maxBytes) {
          reject(fault('IO', 'The Zotero response is too large. Narrow your search.'));
          response.destroy(); request.destroy(); return;
        }
        chunks.push(chunk);
      });
      response.on('error', reject);
      response.on('end', () => resolve({status:response.statusCode, headers:response.headers, body:Buffer.concat(chunks).toString('utf8')}));
    });
    const timer=setTimeout(()=>request.destroy(fault('UNAVAILABLE','Zotero did not respond in time. Retry the connection.')),timeout);
    request.on('close',()=>clearTimeout(timer));
    request.on('error', error => reject(signal?.aborted ? fault('CANCELLED','Zotero request cancelled.') :
      ['VALIDATION','IO','UNAVAILABLE'].includes(error.code) ? error : fault('UNAVAILABLE','Open Zotero on this Mac, then retry.')));
  });
}

function createZoteroService({configPath, request = requestLocal, port = 23119, now = () => Date.now()} = {}) {
  let enabled=false;
  try { enabled=JSON.parse(fs.readFileSync(configPath,'utf8')).enabled===true; } catch { /* first use */ }
  let generation=crypto.randomUUID();
  let boundSource=null;
  let activeRequests=0;
  let controller=new AbortController();
  let current={state:'disconnected', enabled, generation, message:enabled ? 'Check the Zotero connection.' : 'Connect Zotero to browse references.'};
  const libraries=new Map();
  const sessions=new Map();
  const cancelledSessions=new Map();
  const previews=new Map();

  async function perform(route,options) {
    if(activeRequests>=8) throw fault('UNAVAILABLE','Wait for the current Zotero requests to finish.');
    activeRequests++;
    try { return await request(route,options); } finally { activeRequests--; }
  }

  function persist() {
    if (!configPath) return;
    fs.mkdirSync(path.dirname(configPath),{recursive:true});
    const temp=`${configPath}.${crypto.randomUUID()}.tmp`;
    try { fs.writeFileSync(temp,JSON.stringify({version:1,enabled}),{mode:0o600}); fs.renameSync(temp,configPath); }
    finally { try { fs.unlinkSync(temp); } catch {} }
  }
  function invalidate() {
    controller.abort(); controller=new AbortController(); generation=crypto.randomUUID();
    for (const c of sessions.values()) c.abort();
    sessions.clear(); previews.clear(); libraries.clear();
  }
  function setState(state,message,extra={}) { current={state,message,enabled,generation,...extra}; return {...current}; }
  function check(g) {
    if (g!==generation) throw fault('STALE_REVISION','The Zotero connection changed. Reopen the picker.');
    if (current.state!=='connected') throw fault('UNAVAILABLE',current.message);
  }
  function prune() {
    for(const [key,expiry] of cancelledSessions) if(expiry<now()) cancelledSessions.delete(key);
    for(const [key,value] of previews) if(value.expires<now()) previews.delete(key);
  }
  async function probe(explicit=false) {
    if (!enabled && !explicit) return {...current};
    if (explicit) { enabled=true; persist(); invalidate(); }
    const g=generation;
    const previous=boundSource;
    try {
      const response=await perform('/api/',{signal:controller.signal,port});
      if (g!==generation) throw fault('CANCELLED','Connection check cancelled.');
      const clientVersion=typeof response.headers['x-zotero-version']==='string' ? response.headers['x-zotero-version'].slice(0,128) : undefined;
      if (response.status===403) return setState('disabled','In Zotero Settings → Advanced, enable “Allow other applications on this computer to communicate with Zotero”, then retry.',{clientVersion});
      if (response.status!==200) return setState('failed','Zotero could not complete the connection check.',{clientVersion});
      const source=response.headers['zotero-server-id'];
      if (response.headers['zotero-api-version']!=='3' || typeof source!=='string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(source)) {
        return setState('unsupported','This Zotero build does not expose API v3 with stable library identity. Use a supported Zotero build.',{clientVersion});
      }
      if (previous && previous!==source && !explicit) {
        invalidate(); return setState('source-changed','A different Zotero library is open. Reconnect to browse it; saved citations keep their original source.',{clientVersion});
      }
      libraries.set('user/0',{libraryType:'user',libraryId:'0',name:'My Library'});
      boundSource=source;
      return setState('connected','Connected to Zotero on this Mac.',{sourceInstance:source,clientVersion});
    } catch(error) {
      if(g!==generation || error.code==='CANCELLED') throw error;
      return setState('unavailable','Open Zotero on this Mac, then retry.');
    }
  }
  async function json(route,g,signal) {
    check(g);
    const source=current.sourceInstance;
    const result=await perform(route,{signal:signal ? AbortSignal.any([controller.signal,signal]) : controller.signal,sourceInstance:source,port});
    check(g);
    if(result.status===412 || (result.headers['zotero-server-id'] && result.headers['zotero-server-id']!==source)) {
      invalidate(); setState('source-changed','The Zotero library changed. Reconnect before browsing.');
      throw fault('STALE_REVISION',current.message);
    }
    if(result.status===403) { invalidate(); setState('disabled','Zotero local access is disabled. Enable it in Zotero Settings → Advanced.'); throw fault('UNAVAILABLE',current.message); }
    if(result.status===404) throw fault('NOT_FOUND','This reference or library is no longer available in Zotero. Its saved citation is preserved.');
    if(result.status!==200) throw fault('IO','Zotero could not complete this request. Retry.');
    if(result.headers['zotero-server-id']!==source) {
      invalidate();setState('unsupported','Zotero did not confirm its library identity. Reconnect.');
      throw fault('UNAVAILABLE',current.message);
    }
    try { return {data:JSON.parse(result.body),headers:result.headers}; }
    catch { throw fault('IO','Zotero returned an unreadable response.'); }
  }
  function page(result,start,map) {
    if(!Array.isArray(result.data) || result.data.length>LIMIT) throw fault('IO','Zotero returned an invalid page.');
    const rawTotal=Number(result.headers['total-results']);
    const total=Number.isSafeInteger(rawTotal)&&rawTotal>=0 ? rawTotal : null;
    const hasNext=total!==null ? start+result.data.length<total : /rel="next"/.test(result.headers.link||'') || result.data.length===LIMIT;
    return {items:result.data.map(map).filter(Boolean), total, nextStart:hasNext && result.data.length ? start+result.data.length : null};
  }
  function library(input) {
    validate(librarySchema,{libraryType:input.libraryType,libraryId:input.libraryId});
    const found=libraries.get(`${input.libraryType}/${input.libraryId}`);
    if(!found) throw fault('VALIDATION','Select an available Zotero library first.');
    return found;
  }
  function prefix(input) { return `/api/${input.libraryType==='user'?'users':'groups'}/${input.libraryId}`; }
  async function listLibraries(input) {
    const result=page(await json(`/api/users/0/groups?limit=${LIMIT}&start=${input.start}`,input.generation),input.start,raw=>{
      const id=String(raw.id??raw.data?.id??''); const name=raw.data?.name;
      if(!/^\d{1,20}$/.test(id)||typeof name!=='string'||name.length>300) throw fault('IO','Zotero returned invalid group metadata.');
      const item={libraryType:'group',libraryId:id,name}; libraries.set(`group/${id}`,item); return item;
    });
    if(input.start===0) result.items.unshift(libraries.get('user/0'));
    if(result.total!==null) result.total++;
    return result;
  }
  async function collections(input) {
    library(input);
    return page(await json(`${prefix(input)}/collections?limit=${LIMIT}&start=${input.start}`,input.generation),input.start,raw=>{
      if(!/^[A-Z0-9]{8}$/.test(raw.key)||typeof raw.data?.name!=='string'||raw.data.name.length>300||
        (raw.data.parentCollection && !/^[A-Z0-9]{8}$/.test(raw.data.parentCollection))) throw fault('IO','Zotero returned invalid collection metadata.');
      return {key:raw.key,name:raw.data.name,parentKey:raw.data.parentCollection||null};
    });
  }
  async function search(input) {
    const selected=library(input);
    const collection=input.collectionKey?`/collections/${input.collectionKey}`:'';
    const query=new URLSearchParams({limit:String(LIMIT),start:String(input.start),q:input.query,qmode:'titleCreatorYear',sort:'title',direction:'asc'});
    return page(await json(`${prefix(input)}${collection}/items/top?${query}`,input.generation),input.start,raw=>{
      if(['attachment','note','annotation'].includes(raw.data?.itemType)||raw.data?.deleted) return null;
      return normalizeItem(raw,{sourceInstance:current.sourceInstance,libraryType:input.libraryType,libraryId:input.libraryId,itemKey:raw.key},selected.name);
    });
  }
  async function item(identity,g,signal) {
    validate(identitySchema,identity); check(g);
    if(identity.libraryType==='user'&&identity.libraryId!=='0') throw fault('VALIDATION','Personal references must use the connected local library.');
    if(identity.sourceInstance!==current.sourceInstance) throw fault('STALE_REVISION','This citation belongs to another Zotero library. Its saved details are preserved.');
    // Saved group references may be refreshed without first paging through the group picker.
    const name=libraries.get(`${identity.libraryType}/${identity.libraryId}`)?.name || (identity.libraryType==='user'?'My Library':`Group ${identity.libraryId}`);
    const result=await json(`${prefix(identity)}/items/${identity.itemKey}`,g,signal);
    return normalizeItem(result.data,identity,name);
  }
  async function withSession(id,operation) {
    prune();
    if(cancelledSessions.has(id)) throw fault('CANCELLED','The citation picker was closed.');
    if(sessions.has(id)) throw fault('UNAVAILABLE','Wait for the current citation operation.');
    if(sessions.size>=100) throw fault('UNAVAILABLE','Too many citation requests.');
    const active=new AbortController(); sessions.set(id,active);
    try {
      const result=await operation(active.signal);
      if(active.signal.aborted) throw fault('CANCELLED','The citation picker was closed.');
      return result;
    } finally { if(sessions.get(id)===active) sessions.delete(id); }
  }
  function cancel(id) {
    sessions.get(id)?.abort(); cancelledSessions.set(id,now()+300000);
    while(cancelledSessions.size>1000) cancelledSessions.delete(cancelledSessions.keys().next().value);
    for(const [key,value] of previews) if(value.sessionId===id) previews.delete(key);
    prune(); return {cancelled:true};
  }
  return {
    status:()=>probe(), connect:()=>probe(true),
    disconnect:()=>{enabled=false; persist(); invalidate(); boundSource=null; return setState('disconnected','Zotero disconnected. Saved experiment citations remain available.');},
    libraries:listLibraries, collections, search, item, check, withSession, cancel,
    async selected(items,g,signal) {
      const result=[]; const seen=new Set();
      for(const identity of items) if(!seen.has(identityKey(identity))) { seen.add(identityKey(identity)); result.push(await item(identity,g,signal)); }
      check(g); return result;
    },
    preview(sessionId,target,id,item,g) {
      prune(); check(g);
      if(previews.size>=100) throw fault('UNAVAILABLE','Too many pending citation refreshes.');
      const token=crypto.randomUUID(); previews.set(token,{sessionId,target,id,item,g,expires:now()+300000}); return {token,item};
    },
    consume(token,sessionId,target) {
      prune(); const value=previews.get(token);
      if(!value||value.sessionId!==sessionId||Object.keys(target).some(k=>target[k]!==value.target[k])) throw fault('STALE_REVISION','This refresh expired or the experiment changed. Review the details again.');
      check(value.g); previews.delete(token); return {id:value.id,item:value.item};
    },
    invalidate:()=>{invalidate(); return setState('disconnected','Check the Zotero connection after reopening the library.');},
    dispose:()=>{invalidate();cancelledSessions.clear();},
  };
}
module.exports={createZoteroService,requestLocal};
