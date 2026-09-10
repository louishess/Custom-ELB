'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {createBridgeRuntime, validateRendererPayload} = require('../electron/main.cjs');
const {isAllowedMethod} = require('../electron/preload.cjs');
const pair = {starting:{text:'Reagent (0.2 g,2 mmol,2 eq.)'},product:{text:'Product (75mg,750 µmol,1equiv.)'}};
function event(url = 'elb://app/index.html') {const frame = {url}; return {senderFrame:frame,sender:{id:1,mainFrame:frame,getURL:()=>url}};}
test('Copy Yield allowlist validates inputs and calculates text before clipboard mutation', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(),'labmate-material-bridge-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const writes=[];
  const runtime=createBridgeRuntime({root,env:{},appApi:{getPath:()=>root},clipboardApi:{writeText:text=>writes.push(text)}});
  assert.equal(isAllowedMethod('yield.copy'),true);
  assert.equal(isAllowedMethod('clipboard.read'),false);
  for(const bad of [null,{}, {...pair,path:'/private'}, {...pair,starting:'plain'}, {...pair,product:{text:'x'.repeat(10001)}}, {...pair,product:{text:'Product',manual:{version:5}}}]) assert.equal(validateRendererPayload('yield.copy',bad).ok,false);
  assert.equal((await runtime.handleInvoke(event('https://example.com'),'yield.copy',pair)).ok,false);
  assert.equal((await runtime.handleInvoke(event(),'yield.copy',{...pair,product:{text:'missing amounts'}})).ok,false);
  assert.equal(writes.length,0);
  const copied = await runtime.handleInvoke(event(),'yield.copy',pair);
  assert.equal(copied.ok,true); assert.equal(copied.value.copied,true);
  assert.equal(writes.length,1); assert.equal(writes[0],copied.value.summary);
  assert.match(writes[0],/Theoretical yield: 1000 µmol/);
  assert.match(writes[0],/Actual yield:.*750 µmol.*75%/);
});
test('Copy Yield validates manual values and exact source text; clipboard errors are visible', async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'labmate-material-manual-bridge-')); t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const manual={version:1,sourceText:'Isolated oil',label:'Product',molarAmount:'0.75',molarUnit:'mmol',equivalents:'1'};
  const input={...pair,product:{text:'Isolated oil',manual}};
  const writes=[]; const runtime=createBridgeRuntime({root,env:{},appApi:{getPath:()=>root},clipboardApi:{writeText:text=>writes.push(text)}});
  assert.equal((await runtime.handleInvoke(event(),'yield.copy',input)).ok,true);
  assert.match(writes[0],/75%/);
  assert.equal((await runtime.handleInvoke(event(),'yield.copy',{...input,product:{...input.product,text:'Changed oil'}})).ok,false);
  assert.equal(writes.length,1);
  const broken=createBridgeRuntime({root,env:{},appApi:{getPath:()=>root},clipboardApi:{writeText:()=>{throw new Error('Clipboard unavailable');}}});
  const result=await broken.handleInvoke(event(),'yield.copy',pair); assert.equal(result.ok,false);assert.match(result.error.message,/Clipboard unavailable/);
});
