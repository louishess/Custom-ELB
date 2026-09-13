// Opt-in acceptance against the running Zotero client. Zotero is read-only;
// all LabMate records, exports, and recovery files use a disposable directory.
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import {mkdtemp, mkdir, writeFile, readFile, cp, rm} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {_electron as electron} from 'playwright';

assert.equal(process.env.LABMATE_LIVE_ZOTERO, '1', 'Explicitly opt in with LABMATE_LIVE_ZOTERO=1 after authorizing personal-library access.');
assert.ok(process.env.LABMATE_APP_BINARY, 'Point LABMATE_APP_BINARY to the review app.');
const require=createRequire(import.meta.url);
const {LibraryStore}=require('../electron/backend/store.cjs');
const {createBackupService}=require('../electron/backend/backup.cjs');
const root=await mkdtemp(path.join(os.tmpdir(),'labmate-zotero-live-'));
const output=path.resolve('artifacts/zotero'); await mkdir(output,{recursive:true});
const checks=[], errors=[];
let application,page,experiment,run,notebook,citation,clientVersion;
async function launch() {
  const env={...process.env,LABMATE_LIBRARY_ROOT:path.join(root,'library'),LABMATE_TEST_PROFILE:path.join(root,'profile')};
  delete env.LABMATE_ZOTERO_TEST_PORT;
  application=await electron.launch({executablePath:process.env.LABMATE_APP_BINARY,args:[],env});
  page=await application.firstWindow(); page.on('pageerror',e=>errors.push(e.message));
  await page.waitForFunction(()=>Boolean(window.labmate));
}
async function api(method,input) {
  const r=await page.evaluate(async({method,input})=>{const[n,m]=method.split('.');return window.labmate[n][m](input);},{method,input});
  assert.equal(r.ok,true,`${method}: ${r.error?.message||'failed'}`); return r.value;
}
async function check(name,fn) {await fn();checks.push(name);console.log(`PASS ${name}`);}
async function openNotebook() {await page.getByRole('button',{name:/Live Zotero acceptance/}).first().click();await page.getByRole('button',{name:'Add citation',exact:true}).waitFor();}
try {
  await launch();
  await check('Packaged Settings connects to the actual running Zotero API with stable source identity',async()=>{
    await page.getByRole('button',{name:'Settings',exact:true}).click();
    await page.getByRole('tab',{name:'Integrations',exact:true}).click();
    await page.getByRole('button',{name:'Connect Zotero',exact:true}).click();
    await page.getByText('Connected to Zotero on this Mac.',{exact:true}).waitFor();
    const status=await api('zotero.status');assert.equal(status.state,'connected');assert.ok(status.sourceInstance);clientVersion=status.clientVersion;
    await page.getByRole('button',{name:'Done',exact:true}).click();
  });
  await check('Personal library and collections load; one existing reference is linked through the picker',async()=>{
    let s=await api('records.createNotebook',{name:'Live Zotero acceptance',description:'Disposable test only',discipline:'Chemistry',color:'sage'});
    notebook=s.notebooks[0];s=await api('records.createExperiment',{notebookId:notebook.id,label:'Live reference',title:'Disposable experiment',date:'2026-09-12',author:'Acceptance test'});
    experiment=s.experiments[0];run=s.runs[0];await page.reload();await openNotebook();
    await page.getByRole('button',{name:'Add citation',exact:true}).click();
    await page.getByLabel('Zotero library',{exact:true}).waitFor();
    await page.getByLabel('Zotero collection',{exact:true}).waitFor();
    const first=page.locator('.citation-result input[type="checkbox"]').first();await first.waitFor();await first.check();
    await page.getByRole('button',{name:'Add to experiment (1)',exact:true}).click();
    await page.getByText('Citations added to every run of this experiment.',{exact:true}).waitFor();
    s=await api('records.snapshot');assert.equal(s.citations.length,1);citation=s.citations[0];
    assert.equal(citation.experimentId,experiment.id);assert.equal(citation.libraryType,'user');assert.ok(citation.snapshot.title);
    await page.getByRole('button',{name:'Done',exact:true}).click();
  });
  await check('Saved reference can be reviewed and refreshed; a new repeat shares the same association',async()=>{
    await page.locator('.citation-chips').getByRole('button',{name:citation.snapshot.title,exact:true}).click();
    await page.getByRole('button',{name:'Refresh details',exact:true}).click();
    await page.getByRole('region',{name:'Updated reference preview'}).waitFor();
    await page.getByRole('button',{name:'Use updated details',exact:true}).click();
    await page.getByText('Reference details updated for every run.',{exact:true}).waitFor();
    await page.getByRole('button',{name:'Done',exact:true}).click();
    const s=await api('records.repeatRun',{runId:run.id,date:'2026-09-13'});assert.equal(s.citations.length,1);assert.equal(s.runs.length,2);
    await page.reload();await openNotebook();
    const buttons=page.locator('.entry-items button');assert.equal(await buttons.count(),2);
    for(let i=0;i<2;i++){await buttons.nth(i).click();await page.locator('.citation-chips').getByRole('button',{name:citation.snapshot.title,exact:true}).waitFor();}
  });
  await check('Disconnect and full restart preserve the real reference, and all five formats export it offline',async()=>{
    await api('zotero.disconnect');await application.close();application=null;await launch();await openNotebook();
    await page.locator('.citation-chips').getByRole('button',{name:citation.snapshot.title,exact:true}).waitFor();
    assert.equal((await api('zotero.status')).state,'disconnected');
    for(const format of ['txt','md','html','rtf','docx']) {
      const destination=path.join(root,`reference.${format}`);
      await application.evaluate(({dialog},filePath)=>{dialog.showSaveDialog=async()=>({canceled:false,filePath});},destination);
      await api('exports.write',{scope:'notebook',notebookId:notebook.id,runIds:[],format,order:'number-asc',sections:['method'],data:'none',jobId:`live-${format}`});
      const bytes=await readFile(destination);assert.ok(bytes.length>0);
      if(format==='txt') {assert.ok(bytes.toString().includes(citation.snapshot.title));assert.equal(bytes.toString().match(/References/g)?.length,2);}
    }
  });
  await check('Encrypted recovery restores the real experiment citation into the packaged UI',async()=>{
    await application.close();application=null;
    const fixture=path.join(root,'restore-fixture');await mkdir(fixture);
    await cp(path.join(root,'library','library.sqlite'),path.join(fixture,'library.sqlite'));
    const store=new LibraryStore(fixture);let archive;
    try {const made=await createBackupService(store).create({password:'Disposable citation recovery password'});archive=path.join(fixture,'backups',made.name);}finally{store.close();}
    await launch();let s=await api('records.snapshot');const current=s.experiments.find(e=>e.id===experiment.id);
    await api('citations.remove',{experimentId:experiment.id,expectedRevision:current.revision,libraryGeneration:s.libraryGeneration,id:citation.id});
    await page.reload();await page.getByRole('button',{name:'Settings',exact:true}).click();
    await page.getByRole('tab',{name:'Backups',exact:true}).click();
    await page.getByLabel('Restore password',{exact:true}).fill('Disposable citation recovery password');
    await application.evaluate(({dialog},source)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[source]});dialog.showMessageBox=async()=>({response:1,checkboxChecked:false});},archive);
    await page.getByRole('button',{name:'Restore backup…',exact:true}).click();
    await page.waitForFunction(()=>!document.querySelector('dialog')&&Boolean(document.querySelector('.notebook-card')));
    s=await api('records.snapshot');assert.equal(s.citations.length,1);assert.equal(s.citations[0].snapshot.title,citation.snapshot.title);
    await openNotebook();await page.locator('.citation-chips').getByRole('button',{name:citation.snapshot.title,exact:true}).waitFor();
  });
  assert.deepEqual(errors,[]);
  await writeFile(path.join(output,'live-checks.json'),JSON.stringify({verifiedAt:new Date().toISOString(),clientVersion,packagedBinary:process.env.LABMATE_APP_BINARY,checks,errors,personalMetadataRetained:false,workingLabMateLibraryUsed:false,zoteroOperations:'Read-only local API'},null,2));
  console.log(`${checks.length} live Zotero checks passed; disposable data removed.`);
} finally {
  if(application)await application.close();
  await rm(root,{recursive:true,force:true});
}
