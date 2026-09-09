'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { LibraryStore } = require('../electron/backend/store.cjs');
const { createBackupService } = require('../electron/backend/backup.cjs');
const { DEFAULT_YIELD_INPUTS, calculateYield } = require('../shared/yield.cjs');
function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'labmate-yield-store-'));
  const store = new LibraryStore(root);
  t.after(() => { store.close(); fs.rmSync(root, {recursive:true,force:true}); });
  const notebook = store.dispatch('records.createNotebook', {name:'Yield test',description:'',discipline:'Chemistry',color:'sage'}).value.notebooks[0];
  const run = store.dispatch('records.createExperiment', {notebookId:notebook.id,label:'Yield',title:'Recovery',date:'2026-09-09',author:'Test'}).value.runs[0];
  return {root,store,run};
}
function save(store, run, attrs) {
  return store.dispatch('documents.save', {runId:run.id,expectedRevision:run.revision,documents:{...run.documents,data:{type:'doc',content:[{type:'yieldCalculation',attrs}]}}});
}
test('store rejects unsupported yield payloads atomically and accepts incomplete strings', t => {
  const {store,run} = setup(t);
  for (const patch of [{version:2},{startingUnit:'kg'},{productAmount:12},{startingEquivalents:null},{materialLabel:'x'.repeat(501)}]) {
    const result = save(store,run,{...DEFAULT_YIELD_INPUTS,...patch});
    assert.equal(result.ok,false); assert.equal(result.error.code,'VALIDATION');
    assert.deepEqual(store.snapshot().runs[0],run);
  }
  const result = save(store,run,{...DEFAULT_YIELD_INPUTS,startingAmount:'1e-'});
  assert.equal(result.ok,true);
  assert.equal(result.value.runs[0].documents.data.content[0].attrs.startingAmount,'1e-');
});
test('yield inputs survive encrypted backup restore and reopen; repeats clear cards', async t => {
  const {root,store,run} = setup(t);
  const attrs = {...DEFAULT_YIELD_INPUTS,startingAmount:'2',startingEquivalents:'2',productAmount:'750',productUnit:'µmol'};
  const saved = save(store,run,attrs);
  assert.equal(saved.ok,true);
  const backup = createBackupService(store);
  const archive = await backup.create({password:'Synthetic yield backup password',jobId:'yield-backup'},{});
  const savedRun = saved.value.runs[0];
  const overwritten = save(store,savedRun,{...attrs,productAmount:'1e-'});
  assert.equal(overwritten.ok,true);
  const restored = await backup.restore({password:'Synthetic yield backup password',source:path.join(root,'backups',archive.name),jobId:'yield-restore'},{});
  assert.deepEqual(restored.runs[0].documents.data.content[0].attrs,attrs);
  store.close(); store.reopen();
  assert.equal(calculateYield(store.snapshot().runs[0].documents.data.content[0].attrs).percentage,75);
  const repeated = store.dispatch('records.repeatRun',{runId:run.id,date:'2026-09-09'});
  assert.equal(repeated.ok,true);
  assert.ok(!JSON.stringify(repeated.value.runs.find(item=>item.id!==run.id).documents.data).includes('yieldCalculation'));
});
