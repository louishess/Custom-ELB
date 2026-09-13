'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const JSZip = require('jszip');
const { fixture, png, paragraph, document, cell } = require('./helpers/export-fixture.cjs');
const { resolveExportDocument, renderExportDocument } = require('../electron/backend/exports.cjs');
const { displayDate, imageDimensions, fitImage, contentWidth } = require('../electron/backend/export-design.cjs');

async function render(format, options = {}) {
  const data = fixture();
  options.change?.(data);
  const model = await resolveExportDocument({snapshot:()=>data.snapshot},{preview:async ({id})=>data.previews[id]}, {
    scope:'entry',notebookId:'notebook',runIds:['run-1'],format,order:'oldest',sections:['method','information','data'],data:'previews',jobId:'design',...options.request,
  });
  const {bytes} = await renderExportDocument(model);
  const zip = format === 'docx' ? await JSZip.loadAsync(bytes) : null;
  return {model,bytes,zip,text:zip ? await zip.file('word/document.xml').async('string') : bytes.toString()};
}

test('all formats separate entry identity, preserve metadata, and number the requested section order', async () => {
  for (const format of ['txt','md','html','rtf','docx']) {
    const {text,model} = await render(format,{request:{sections:['method','information'],data:'none'}});
    assert.match(text,/Catalyst loading study/);
    assert.match(text,/Sep 12, 2026/);
    assert.match(text,/Alex Rivera/);
    assert.match(text,/2 of experiment 12/);
    assert.deepEqual(model.entries[0].sections.map(s=>s.id),['method','information']);
    if(format==='html') {
      assert.match(text,/class="entry-code">Catalyst-screen-12-2<\/span><h1/);
      assert.match(text,/section-number">01<\/span>Method/);
      assert.match(text,/section-number">02<\/span>Experimental information/);
      assert.doesNotMatch(text,/section-number">03/);
    } else {
      assert.ok(text.indexOf('01  Method') < text.indexOf('02  Experimental information'));
      assert.doesNotMatch(text,/03  Data/);
    }
  }
  assert.equal(displayDate('2026-01-01'),'Jan 1, 2026');
});

test('white rich-format presentation is independent of all seven palettes and brightness', async () => {
  for(const format of ['html','rtf','docx']) {
    let baseline;
    for(const palette of ['sage','ocean','lavender','terracotta','rose','graphite','midnight']) {
      for(const appearance of [0,100]) {
        const result=await render(format,{request:{data:'none'},change:({snapshot})=>{snapshot.preferences={palette,appearance};}});
        const content=result.text+(result.zip ? await result.zip.file('word/styles.xml').async('string') : '');
        if(baseline===undefined)baseline=content;
        assert.equal(content,baseline,`${format} ${palette} ${appearance}`);
      }
    }
  }
});

test('DOCX defines portable fonts, hierarchy, page layout and proportional figures', async () => {
  const {zip,text}=await render('docx',{request:{scope:'notebook',runIds:[],sections:['data']}});
  const styles=await zip.file('word/styles.xml').async('string');
  const fonts=await zip.file('word/fontTable.xml').async('string');
  assert.match(styles,/w:ascii="Arial"/);
  assert.match(styles,/w:styleId="LabMateEntry"/);
  assert.match(styles,/w:styleId="LabMateSection"/);
  assert.match(styles,/w:sz w:val="44"/);
  assert.match(styles,/w:sz w:val="22"/);
  assert.match(fonts,/w:family w:val="swiss"/);
  assert.match(text,/w:pgSz w:w="12240" w:h="15840"/);
  assert.match(text,/w:pageBreakBefore/);
  assert.ok(zip.file('word/header1.xml'));
  assert.ok(zip.file('word/footer1.xml'));
  const images=[...text.matchAll(/<wp:extent cx="(\d+)" cy="(\d+)"/g)].map(match=>Number(match[1])/Number(match[2]));
  assert.equal(images.length,2);
  assert.ok(Math.abs(images[0]-640/260)<0.0001);
  assert.ok(Math.abs(images[1]-240/360)<0.0001);
  assert.match(text,/response-curve.png/);
  assert.match(text,/sample-profile.png/);
});

test('raster fitting uses real geometry, bounds tall images, and rejects truncated headers', () => {
  assert.deepEqual(imageDimensions(png(240,360)),{width:240,height:360});
  const large=fitImage(png(1000,2000));
  assert.equal(large.width/large.height,0.5);
  assert.ok(large.width<=contentWidth && large.height<=600);
  assert.deepEqual(fitImage(png(1,1)),{width:1,height:1});
  for(const invalid of [Buffer.alloc(0),Buffer.from([0xff,0xd8,0xff,0xc0,0,9]),Buffer.from('GIF89a')])assert.equal(imageDimensions(invalid),null);
});

test('extremely wide rich tables retain all cells in labeled rows and explain the layout loss', async () => {
  const table={type:'table',content:[{type:'tableRow',content:Array.from({length:24},(_,i)=>cell(`Value-${i}`,i===0,{colwidth:[200]}))}]};
  for(const format of ['html','rtf','docx']) {
    const {text,model}=await render(format,{request:{sections:['data'],data:'none'},change:({snapshot})=>{snapshot.runs[0].documents.data=document(table);}});
    assert.ok(model.warnings.some(w=>w.includes('wide table')&&w.includes('labeled rows')));
    for(let i=0;i<24;i++)assert.equal((text.match(new RegExp(`Value-${i}(?![0-9])`,'g'))||[]).length,1);
    assert.match(text,/Row 1, column 24/);
  }
});

test('RTF keeps image proportions, uses neutral styles and falls back honestly for unsupported rasters', async () => {
  const {text}=await render('rtf');
  assert.match(text,/\\fs44/);assert.match(text,/\\fs22/);assert.match(text,/\\fs18/);
  assert.match(text,/\\fswiss Arial/);
  const notebook = await render('rtf',{request:{scope:'notebook',runIds:undefined}});
  assert.equal((notebook.text.match(/\\pagebb/g)||[]).length,1, 'each subsequent entry starts a fresh page');
  assert.match(notebook.text,/\\pard\\plain\\pagebb[^\n]*Catalyst-screen-12-3/);
  const images=[...text.matchAll(/\\picwgoal(\d+)\\pichgoal(\d+)/g)];
  assert.equal(images.length,2);
  assert.equal(Number(images[0][1])/Number(images[0][2]),640/260);
  assert.equal(Number(images[1][1])/Number(images[1][2]),240/360);
  const fallback=await render('rtf',{change:({previews})=>{previews.landscape.mime='image/webp';}});
  assert.match(fallback.text,/response-curve.png/);
  assert.ok(fallback.model.warnings.some(w=>w.includes('could not be sized or embedded safely in RTF')));
});

test('Markdown preserves block boundaries, nested list indentation, and fenced code containing backticks', async () => {
  const {text}=await render('md',{request:{sections:['notes'],data:'none'},change:({snapshot})=>{snapshot.runs[0].documents.notes=document(paragraph('First paragraph'),paragraph('Second paragraph'),{type:'codeBlock',content:[{type:'text',text:'```\nscientific_code()'}]});}});
  assert.match(text,/First paragraph\n\nSecond paragraph/);
  assert.match(text,/````\n```\nscientific_code\(\)\n````/);
  const method=await render('md',{request:{sections:['method'],data:'none'}});
  assert.match(method.text,/3\. Charge/);
  assert.match(method.text,/\n   - Keep/);
  assert.match(method.text,/\n4\. Stir/);
});
