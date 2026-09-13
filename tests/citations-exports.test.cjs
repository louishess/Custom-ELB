'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const JSZip=require('jszip');
const {LibraryStore}=require('../electron/backend/store.cjs');
const {createExportService,resolveExportDocument}=require('../electron/backend/exports.cjs');
const {normalizeItem}=require('../shared/citations.cjs');
test('all five offline exports include experiment references after selected sections, preserving safe links and escaping markup',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'labmate-citation-exports-'));const store=new LibraryStore(root);
  t.after(()=>{store.close();fs.rmSync(root,{recursive:true,force:true});});
  const unwrap=r=>{assert.equal(r.ok,true,JSON.stringify(r));return r.value;};
  const notebook=unwrap(store.dispatch('records.createNotebook',{name:'References',description:'',discipline:'Chemistry',color:'sage'})).notebooks[0];
  let s=unwrap(store.dispatch('records.createExperiment',{notebookId:notebook.id,label:'A',title:'An experiment',date:'2026-09-12',author:'Researcher'}));
  const run=s.runs[0];
  const item=normalizeItem({key:'ABCD1234',version:1,data:{itemType:'journalArticle',title:'Copper <script>study</script>',creators:[{name:'Research Group',creatorType:'author'}],date:'2025',DOI:'10.1000/example'}},{sourceInstance:'source',libraryType:'user',libraryId:'0',itemKey:'ABCD1234'},'My Library');
  s=unwrap(store.dispatch('citations.add',{experimentId:run.experimentId,expectedRevision:s.experiments[0].revision,libraryGeneration:s.libraryGeneration,items:[item]}));
  s=unwrap(store.dispatch('records.repeatRun',{runId:run.id,date:'2026-09-13'}));
  const files={preview:()=>{throw new Error('No attachment access expected');}};
  const service=createExportService(store,files);
  for(const format of ['txt','md','html','rtf','docx']) {
    const request={scope:'notebook',notebookId:notebook.id,runIds:[],format,order:'number-asc',sections:['method'],data:'none',jobId:`export-${format}`,destination:path.join(root,`refs.${format}`)};
    const model=await resolveExportDocument(store,files,request);
    assert.equal(model.entries.length,2);assert.deepEqual(model.entries[0].sections.map(x=>x.title),['Method','References']);
    await service.write(request);
    const bytes=fs.readFileSync(request.destination);
    const output=format==='docx'?await(await JSZip.loadAsync(bytes)).file('word/document.xml').async('string'):bytes.toString('utf8');
    assert.equal((output.match(/References/g)||[]).length>=2,true,format);assert.match(output,/Research Group/);assert.match(output,/10\.1000\/example/);
    if(['html','docx'].includes(format)) {assert.doesNotMatch(output,/<script>/);assert.match(output,/&lt;script&gt;/);}
  }
  const id=s.citations[0].id;
  s=unwrap(store.dispatch('citations.remove',{experimentId:run.experimentId,expectedRevision:s.experiments[0].revision,libraryGeneration:s.libraryGeneration,id}));
  const empty=await resolveExportDocument(store,files,{scope:'entry',notebookId:notebook.id,runIds:[run.id],format:'txt',order:'number-asc',sections:['notes'],data:'none',jobId:'empty'});
  assert.deepEqual(empty.entries[0].sections.map(x=>x.title),['Notes']);
});
