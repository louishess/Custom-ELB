import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import {mkdtemp, mkdir, writeFile, rm} from 'node:fs/promises';
import { _electron as electron } from 'playwright';

const root=await mkdtemp(path.join(os.tmpdir(),'labmate-zotero-ui-'));
const output=path.resolve('artifacts/zotero');await mkdir(output,{recursive:true});
const checks=[], errors=[], requests=[];
let source='fixture-source', disabled=false, title='Copper coupling methods', missing=false;
const records=Array.from({length:53},(_,i)=>({key:`REF${String(i).padStart(5,'0')}`,version:1,data:{itemType:'journalArticle',title:i===0?title:`Reference ${String(i).padStart(3,'0')}`,creators:[{name:'Fixture Research Group',creatorType:'author'}],date:'2025',publicationTitle:'Journal of Test Chemistry',DOI:`10.1000/test${i}`}}));
const server=http.createServer((req,res)=>{
  requests.push({method:req.method,path:req.url,source:req.headers['zotero-server-id']});
  const headers={'Zotero-Server-ID':source,'Zotero-API-Version':'3','X-Zotero-Version':'11.fixture','Content-Type':'application/json'};
  if(disabled) {res.writeHead(403,headers);return res.end('{}');}
  if(req.headers['zotero-server-id']&&req.headers['zotero-server-id']!==source) {res.writeHead(412,headers);return res.end('{}');}
  const url=new URL(req.url,'http://localhost');let data;
  if(url.pathname==='/api/') data={};
  else if(url.pathname==='/api/users/0/groups') data=[{id:42,data:{name:'Shared chemistry'}}];
  else if(url.pathname.endsWith('/collections')) data=[{key:'COLL0001',data:{name:'Methods',parentCollection:false}},{key:'COLL0002',data:{name:'Catalysts',parentCollection:'COLL0001'}}];
  else if(url.pathname.endsWith('/items/top')) {
    const q=url.searchParams.get('q')?.toLowerCase()||'';
    data=records.map((r,i)=>i===0?{...r,data:{...r.data,title}}:r).filter(r=>`${r.data.title} ${r.data.date} ${r.data.creators[0].name}`.toLowerCase().includes(q));
  } else if(/\/items\/REF\d{5}$/.test(url.pathname)&&!missing) {
    const key=url.pathname.split('/').at(-1);const r=records.find(r=>r.key===key);
    data=r?.key===records[0].key?{...r,data:{...r.data,title}}:r;
  }
  if(data===undefined){res.writeHead(404,headers);return res.end('{}');}
  if(url.searchParams.has('style')) {
    const format=r=>r?.data?.itemType?{...r,citation:url.searchParams.get('style')==='american-chemical-society'?'<sup>1</sup>':'<span>(Research Group 2025)</span>',bib:`<div>Research Group. <i>${r.data.title}</i>. 2025.</div>`}:r;
    data=Array.isArray(data)?data.map(format):format(data);
  }
  if(Array.isArray(data)){headers['Total-Results']=String(data.length);const start=Number(url.searchParams.get('start')||0);data=data.slice(start,start+Number(url.searchParams.get('limit')||50));}
  res.writeHead(200,headers);res.end(JSON.stringify(data));
});
await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
let application,page,experiment,run;
async function launch(){
  application=await electron.launch({...(process.env.LABMATE_APP_BINARY?{executablePath:process.env.LABMATE_APP_BINARY,args:[]}:{args:['.']}),
    env:{...process.env,LABMATE_LIBRARY_ROOT:path.join(root,'library'),LABMATE_TEST_PROFILE:path.join(root,'profile'),LABMATE_ZOTERO_TEST_PORT:String(server.address().port)}});
  page=await application.firstWindow();page.on('pageerror',e=>errors.push(e.message));
  await page.waitForFunction(()=>Boolean(window.labmate));
}
async function api(method,input){const result=await page.evaluate(async({method,input})=>{const[n,m]=method.split('.');return window.labmate[n][m](input);},{method,input});assert.equal(result.ok,true,JSON.stringify(result));return result.value;}
async function check(name,fn){await fn();checks.push(name);console.log(`PASS ${name}`);}
async function openNotebook(){await page.getByRole('button',{name:/Citation test notebook/}).first().click();await page.getByRole('button',{name:'Add citation',exact:true}).waitFor();}
try {
  await launch();
  await check('Empty library starts with no citations; setup uses Settings',async()=>{
    let s=await api('records.createNotebook',{name:'Citation test notebook',description:'Disposable Zotero acceptance',discipline:'Chemistry',color:'sage'});
    const nb=s.notebooks[0];s=await api('records.createExperiment',{notebookId:nb.id,label:'Coupling',title:'Run one',date:'2026-09-12',author:'Fixture Researcher'});
    experiment=s.experiments[0];run=s.runs[0];
    await api('records.repeatRun',{runId:run.id,date:'2026-09-13'});
    await api('records.createExperiment',{notebookId:nb.id,label:'Independent',title:'Independent experiment',date:'2026-09-11',author:'Fixture Researcher'});
    await page.reload();await page.getByRole('button',{name:'Settings',exact:true}).click();
    await page.getByRole('tab',{name:'Integrations',exact:true}).click();await page.getByRole('button',{name:'Connect Zotero',exact:true}).click();
    await page.getByText('Connected to Zotero on this Mac.',{exact:true}).waitFor();await page.getByRole('button',{name:'Done',exact:true}).click();
  });
  await check('Picker browses personal/group libraries and nested collections with pagination',async()=>{
    await openNotebook();await page.getByRole('button',{name:'Add citation',exact:true}).click();
    await page.getByLabel('Select Copper coupling methods',{exact:true}).waitFor();
    await page.getByRole('button',{name:'Load more references',exact:true}).click();await page.getByLabel('Select Reference 052',{exact:true}).waitFor();
    await page.getByLabel('Zotero library',{exact:true}).selectOption('group/42');
    await page.getByLabel('Zotero collection',{exact:true}).selectOption('COLL0002');
    await page.getByLabel('Search Zotero references',{exact:true}).fill('Copper');
    await page.getByLabel('Select Copper coupling methods',{exact:true}).waitFor();
    await page.screenshot({path:path.join(output,'01-picker.png')});
  });
  await check('Adding a source once associates it with the experiment, preserves pending text, and marks duplicates Added',async()=>{
    await page.getByLabel('Select Copper coupling methods',{exact:true}).check();
    await page.getByRole('button',{name:'Add to experiment (1)',exact:true}).click();
    await page.getByText('Citations added to every run of this experiment.',{exact:true}).waitFor();
    let s=await api('records.snapshot');assert.equal(s.citations.length,1);assert.equal(s.citations[0].experimentId,experiment.id);
    assert.equal(s.citations[0].libraryType,'group');
    assert.equal(await page.getByLabel('Select Copper coupling methods',{exact:true}).isDisabled(),true);
    await page.getByRole('button',{name:'Done',exact:true}).click();
    const editor=page.locator('.tiptap').first();await editor.click();await editor.press('End');await editor.type('Pending citation acceptance text');
    await page.getByRole('button',{name:'Copper coupling methods',exact:true}).click();
    await page.getByRole('region',{name:'Reference details'}).waitFor();
    await page.getByRole('button',{name:'Done',exact:true}).click();
    await page.waitForFunction(()=>document.querySelector('.entry-status')?.textContent?.includes('Saved'));
    s=await api('records.snapshot');assert.ok(s.runs.some(r=>JSON.stringify(r.documents).includes('Pending citation acceptance text')));
    await page.screenshot({path:path.join(output,'02-linked-run.png')});
  });
  await check('Every repeat shows the same reference while another experiment remains independent',async()=>{
    const buttons=page.locator('.entry-items button');
    for(let i=0;i<await buttons.count();i++){
      await buttons.nth(i).click();
      const text=await page.locator('.entry-document-header').innerText();
      assert.equal(await page.locator('.citation-chips').getByRole('button',{name:'Copper coupling methods',exact:true}).count(),text.includes('Independent')?0:1);
    }
    await buttons.first().click();
  });
  await check('Refresh requires review and saved reference metadata survives missing or changed sources',async()=>{
    await page.getByRole('button',{name:'Copper coupling methods',exact:true}).click();title='Revised copper coupling methods';
    await page.getByRole('button',{name:'Refresh details',exact:true}).click();
    await page.getByRole('region',{name:'Updated reference preview'}).waitFor();
    assert.equal((await api('records.snapshot')).citations[0].snapshot.title,'Copper coupling methods');
    await page.getByRole('button',{name:'Use updated details',exact:true}).click();
    await page.getByText('Reference details updated for every run.',{exact:true}).waitFor();
    await page.getByRole('button',{name:'Done',exact:true}).click();await page.getByRole('button',{name:title,exact:true}).click();
    missing=true;await page.getByRole('button',{name:'Refresh details',exact:true}).click();await page.getByRole('alert').filter({hasText:'no longer available'}).waitFor();
    assert.equal((await api('records.snapshot')).citations[0].snapshot.title,title);missing=false;
    await page.screenshot({path:path.join(output,'03-saved-reference.png')});
    await page.getByRole('button',{name:'Done',exact:true}).click();
    source='different-source';const status=await api('zotero.status');assert.equal(status.state,'source-changed');
    assert.equal((await api('records.snapshot')).citations[0].sourceInstance,'fixture-source');source='fixture-source';
    await api('zotero.connect');
  });
  await check('Disconnected/restarted app keeps citations and offline removal updates every run',async()=>{
    await api('zotero.disconnect');await application.close();application=null;await launch();await openNotebook();
    const editor=page.locator('.tiptap').first();await editor.click();await editor.press('End');await editor.type('Draft survives citation removal');
    await page.getByRole('button',{name:title,exact:true}).click();await page.getByRole('region',{name:'Reference details'}).waitFor();
    assert.equal(await page.getByRole('button',{name:'Refresh details',exact:true}).isDisabled(),true);
    await page.getByRole('button',{name:'Remove from experiment',exact:true}).click();await page.getByText('Citation removed from every run of this experiment.',{exact:true}).waitFor();
    assert.equal((await api('records.snapshot')).citations.length,0);await page.getByRole('button',{name:'Done',exact:true}).click();
    assert.match(await page.locator('.tiptap').first().innerText(),/Draft survives citation removal/);
    assert.equal(await page.locator('.citation-chips').getByRole('button',{name:title,exact:true}).count(),0);
  });
  await check('Disabled local access is explicit and empty searches never show fictional references',async()=>{
    disabled=true;await page.getByRole('button',{name:'Add citation',exact:true}).click();await page.getByRole('button',{name:'Connect Zotero',exact:true}).click();
    await page.getByText(/enable “Allow other applications/).waitFor();assert.equal(await page.locator('.citation-result').count(),0);
    disabled=false;await page.getByRole('button',{name:'Retry connection',exact:true}).click();await page.getByLabel('Search Zotero references',{exact:true}).fill('No such reference');
    await page.getByText('No references on this page.',{exact:true}).waitFor();
  });
  await check('Narrow Midnight Purple layout supports keyboard selection and modal dismissal',async()=>{
    await page.getByRole('button',{name:'Done',exact:true}).click();
    await api('preferences.update',{palette:'midnight',appearance:100,layout:'tabs'});
    await application.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(1000,780));
    await page.reload();await openNotebook();await page.getByRole('button',{name:'Add citation',exact:true}).click();
    const checkbox=page.getByLabel(`Select ${title}`,{exact:true});await checkbox.waitFor();await checkbox.focus();await page.keyboard.press('Space');
    assert.equal(await checkbox.isChecked(),true);
    assert.equal(await page.locator('.modal').evaluate(el=>el.scrollWidth<=el.clientWidth+1),true);
    await page.screenshot({path:path.join(output,'04-dark-narrow.png')});
    await page.keyboard.press('Escape');await page.getByRole('dialog').waitFor({state:'hidden'});
  });
  await check('Citation label settings require an explicit style, update existing links, and persist offline',async()=>{
    await page.getByRole('button',{name:'Add citation',exact:true}).click();
    await page.getByLabel(`Select ${title}`,{exact:true}).check();
    await page.getByRole('button',{name:'Add to experiment (1)',exact:true}).click();
    await page.getByText('Citations added to every run of this experiment.',{exact:true}).waitFor();
    await page.getByRole('button',{name:'Done',exact:true}).click();
    assert.equal((await api('records.snapshot')).citations[0].snapshot.formattedCitation,undefined);
    assert.ok(requests.every(r=>!r.path.includes('style=')));
    await page.getByRole('button',{name:'Settings',exact:true}).click();await page.getByRole('tab',{name:'Integrations',exact:true}).click();
    assert.equal(await page.getByLabel('Citation style',{exact:true}).inputValue(),'');
    await page.getByLabel('Show citations as',{exact:true}).selectOption('formatted');
    await page.getByText('Choose a citation style to use formatted labels. Paper titles are shown until then.',{exact:true}).waitFor();
    assert.equal(await page.getByLabel('Citation style',{exact:true}).inputValue(),'');
    await page.getByLabel('Citation style',{exact:true}).selectOption('american-chemical-society');
    await page.getByText('1 citation label updated.',{exact:true}).waitFor();
    let s=await api('records.snapshot');assert.equal(s.preferences.citationStyle,'american-chemical-society');
    assert.equal(s.citations[0].snapshot.title,title);assert.equal(s.citations[0].snapshot.formattedCitation.text,`Research Group. ${title}. 2025.`);
    await page.screenshot({path:path.join(output,'05-citation-settings.png')});
    await page.getByRole('button',{name:'Done',exact:true}).click();
    await page.locator('.citation-chips').getByRole('button',{name:`Research Group. ${title}. 2025.`,exact:true}).waitFor();
    await page.getByRole('button',{name:'Settings',exact:true}).click();await page.getByRole('tab',{name:'Integrations',exact:true}).click();
    await page.getByLabel('Citation style',{exact:true}).selectOption('chicago-author-date');await page.getByText('1 citation label updated.',{exact:true}).waitFor();
    await page.getByRole('button',{name:'Done',exact:true}).click();
    await api('zotero.disconnect');await application.close();application=null;await launch();await openNotebook();
    await page.locator('.citation-chips').getByRole('button',{name:'(Research Group 2025)',exact:true}).waitFor();
    await page.screenshot({path:path.join(output,'06-formatted-label.png')});
    s=await api('records.snapshot');assert.equal(s.preferences.citationLabel,'formatted');assert.equal(s.preferences.citationStyle,'chicago-author-date');
    await page.getByRole('button',{name:'Settings',exact:true}).click();await page.getByRole('tab',{name:'Integrations',exact:true}).click();
    await page.getByLabel('Show citations as',{exact:true}).selectOption('title');await page.getByRole('button',{name:'Done',exact:true}).click();
    await page.locator('.citation-chips').getByRole('button',{name:title,exact:true}).waitFor();
  });
  assert.deepEqual(errors,[]);assert.ok(requests.every(r=>r.method==='GET'&&r.path.startsWith('/api/')));
  await writeFile(path.join(output,'checks.json'),JSON.stringify({checks,errors,requestCount:requests.length,packaged:!!process.env.LABMATE_APP_BINARY},null,2));
  console.log(`${checks.length} Zotero workflow checks passed.`);
} finally {
  if(application)await application.close();server.closeAllConnections();server.close();await rm(root,{recursive:true,force:true});
}
