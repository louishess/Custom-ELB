'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {LibraryStore} = require('../electron/backend/store.cjs');
const {createBackupService} = require('../electron/backend/backup.cjs');
const {normalizeItem} = require('../shared/citations.cjs');

function value(result) { assert.equal(result.ok, true, JSON.stringify(result.error)); return result.value; }
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'labmate-citations-'));
  const store = new LibraryStore(root);
  t.after(() => { store.close(); fs.rmSync(root, {recursive: true, force: true}); });
  const nb = value(store.dispatch('records.createNotebook', {name:'Citations', description:'', discipline:'Chemistry', color:'sage'})).notebooks[0];
  const s = value(store.dispatch('records.createExperiment', {notebookId:nb.id, label:'Experiment A', title:'Run one', date:'2026-09-12', author:'Researcher'}));
  const experimentId = s.experiments[0].id;
  const target = () => ({experimentId, expectedRevision:store.snapshot().experiments.find(e=>e.id===experimentId).revision, libraryGeneration:store.libraryGeneration});
  const item = (overrides={}) => normalizeItem({key:'ABCD1234', version:1, data:{itemType:'journalArticle', title:'A reference', creators:[{name:'Research Group', creatorType:'author'}], date:'2025', DOI:'10.1000/example'}}, {sourceInstance:'server-A', libraryType:'user', libraryId:'0', itemKey:'ABCD1234', ...overrides}, 'My Library');
  return {root, store, nb, experimentId, target, item, run:s.runs[0]};
}
test('schema 4 gains unset citation style; labels and preferences survive encrypted recovery',async t=>{
  const f=fixture(t);
  value(f.store.dispatch('citations.add',{...f.target(),items:[f.item()]}));
  const before=f.store.snapshot();
  f.store.db.exec('ALTER TABLE preferences DROP COLUMN citation_label');f.store.db.exec('ALTER TABLE preferences DROP COLUMN citation_style');f.store.db.pragma('user_version = 4');
  f.store.close();f.store.reopen();
  const migrated=f.store.snapshot();assert.equal(migrated.schemaVersion,6);
  assert.equal(migrated.preferences.citationStyle,'');assert.equal(migrated.preferences.citationLabel,'title');
  assert.deepEqual(migrated.citations,before.citations);
  const item=f.item();item.snapshot.formattedCitation={text:'(Research Group 2025)',style:'chicago-author-date',fetchedAt:new Date().toISOString()};
  value(f.store.dispatch('citations.applyRefresh',{...f.target(),id:migrated.citations[0].id,item}));
  value(f.store.dispatch('preferences.update',{citationLabel:'formatted',citationStyle:'chicago-author-date'}));
  assert.equal(f.store.dispatch('preferences.update',{citationStyle:'https://example.com/style'}).ok,false);
  const expected=f.store.snapshot();const service=createBackupService(f.store);
  const archive=await service.create({password:'label recovery'});
  value(f.store.dispatch('preferences.update',{citationStyle:'',citationLabel:'title'}));
  await service.restore({source:path.join(f.root,'backups',archive.name),password:'label recovery'});
  assert.deepEqual(f.store.snapshot(),{...expected,libraryGeneration:f.store.libraryGeneration});
});
test('one experiment citation survives repeat/reopen, stays independent, and does not change run revisions', t => {
  const f = fixture(t);
  const a = value(f.store.dispatch('citations.add', {...f.target(), items:[f.item(), f.item()]}));
  assert.equal(a.citations.length, 1); assert.equal(a.runs[0].revision, f.run.revision);
  const repeated = value(f.store.dispatch('records.repeatRun', {runId:f.run.id, date:'2026-09-13'}));
  assert.equal(repeated.runs.length, 2); assert.equal(repeated.citations.length, 1);
  assert.ok(repeated.runs.every(r=>r.experimentId===repeated.citations[0].experimentId));
  value(f.store.dispatch('records.createExperiment', {notebookId:f.nb.id, label:'Separate', title:'Other experiment', date:'2026-09-12', author:'Researcher'}));
  assert.equal(f.store.snapshot().citations.filter(c=>c.experimentId!==f.experimentId).length, 0);
  const generation = f.store.libraryGeneration; f.store.close(); f.store.reopen();
  assert.notEqual(f.store.libraryGeneration, generation); assert.deepEqual(f.store.snapshot().citations, a.citations);
  assert.equal(f.store.dispatch('citations.remove', {...f.target(), libraryGeneration:generation, id:a.citations[0].id}).error.code, 'STALE_REVISION');
  const stale = f.target(); value(f.store.dispatch('citations.remove', {...f.target(), id:a.citations[0].id}));
  assert.equal(f.store.snapshot().citations.length, 0);
  assert.equal(f.store.dispatch('citations.add', {...stale, items:[f.item()]}).error.code, 'STALE_REVISION');
});
test('identity separates libraries and profiles; refresh cannot replace source', t => {
  const f=fixture(t);
  const s=value(f.store.dispatch('citations.add', {...f.target(), items:[f.item(), f.item({libraryType:'group',libraryId:'42'}), f.item({sourceInstance:'server-B'})]}));
  assert.equal(s.citations.length,3);
  const c=s.citations.find(c=>c.sourceInstance==='server-A'&&c.libraryType==='user');
  assert.equal(f.store.dispatch('citations.applyRefresh', {...f.target(), id:c.id, item:f.item({sourceInstance:'server-B'})}).error.code,'VALIDATION');
  const revised=f.item(); revised.snapshot.title='Corrected title';
  const updated=value(f.store.dispatch('citations.applyRefresh', {...f.target(), id:c.id, item:revised}));
  assert.equal(updated.citations.find(x=>x.id===c.id).snapshot.title,'Corrected title');
});
test('run trash/purge preserves experiment citations; parent trash rejects edits and restores references', t => {
  const f=fixture(t); value(f.store.dispatch('citations.add', {...f.target(), items:[f.item()]}));
  value(f.store.dispatch('trash.move',{kind:'run', id:f.run.id, expectedRevision:f.run.revision}));
  value(f.store.dispatch('trash.purge',{kind:'run', id:f.run.id, expectedRevision:f.store.snapshot().runs[0].revision}));
  assert.equal(f.store.snapshot().citations.length,1);
  value(f.store.dispatch('trash.move',{kind:'experiment', id:f.experimentId, expectedRevision:f.target().expectedRevision}));
  assert.equal(f.store.dispatch('citations.add',{...f.target(), items:[f.item()]}).error.code,'NOT_FOUND');
  value(f.store.dispatch('trash.restore',{kind:'experiment', id:f.experimentId, expectedRevision:f.target().expectedRevision}));
  assert.equal(f.store.snapshot().citations.length,1);
  value(f.store.dispatch('trash.move',{kind:'experiment', id:f.experimentId, expectedRevision:f.target().expectedRevision}));
  value(f.store.dispatch('trash.purge',{kind:'experiment', id:f.experimentId, expectedRevision:f.target().expectedRevision}));
  assert.equal(f.store.snapshot().citations.length,0);
});
test('schema 3 migration preserves legacy associations without promoting run scope', t => {
  const f=fixture(t);
  f.store.db.prepare('INSERT INTO citation_associations VALUES (?, ?, ?, ?, ?, ?, ?)').run(require('node:crypto').randomUUID(),f.run.id,'old','0','ABCD1234','{}',new Date().toISOString());
  f.store.db.exec('DROP TABLE experiment_citations'); f.store.db.exec('ALTER TABLE preferences DROP COLUMN citation_label'); f.store.db.exec('ALTER TABLE preferences DROP COLUMN citation_style'); f.store.db.pragma('user_version = 3'); f.store.close(); f.store.reopen();
  const s=f.store.snapshot(); assert.equal(s.schemaVersion,6); assert.equal(s.legacyCitationCount,1); assert.deepEqual(s.citations,[]);
});
test('citation backup restores complete metadata and rejects pre-restore operations', async t => {
  const f=fixture(t); const s=value(f.store.dispatch('citations.add', {...f.target(), items:[f.item()]}));
  const old=f.target(); const service=createBackupService(f.store);
  const backup=await service.create({password:'test password'});
  value(f.store.dispatch('citations.remove',{...f.target(),id:s.citations[0].id}));
  const restored=await service.restore({password:'test password',source:path.join(f.root,'backups',backup.name)});
  assert.deepEqual(restored.citations,s.citations);
  assert.equal(f.store.dispatch('citations.remove',{...old,id:s.citations[0].id}).error.code,'STALE_REVISION');
});
test('invalid metadata fails transactionally and corrupt stored metadata prevents opening', t => {
  const f=fixture(t); const bad=f.item(); bad.snapshot.creators=[{name:'x',role:'author',script:'bad'}];
  assert.equal(f.store.dispatch('citations.add',{...f.target(),items:[f.item(),bad]}).error.code,'VALIDATION');
  assert.equal(f.store.snapshot().citations.length,0);
  value(f.store.dispatch('citations.add',{...f.target(),items:[f.item()]}));
  f.store.db.exec("UPDATE experiment_citations SET snapshot_json = '{}' "); f.store.close();
  assert.throws(()=>f.store.reopen(),e=>e.code==='CORRUPT_BACKUP');
});
