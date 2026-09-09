'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const JSZip = require('jszip');
const { resolveExportDocument, renderExportDocument } = require('../electron/backend/exports.cjs');

const paragraph = text => ({ type: 'paragraph', content: [{ type: 'text', text }] });
const cell = (type, texts, attrs = {}) => ({ type, attrs, content: texts.map(paragraph) });
const table = { type: 'table', content: [
  { type: 'tableRow', content: [
    cell('tableCell', ['Merged first', 'Separate paragraph'], { colspan: 2, rowspan: 2, colwidth: [100, 150] }),
    cell('tableHeader', ['Side header'], { colwidth: [200] }),
  ] },
  { type: 'tableRow', content: [cell('tableCell', ['Bottom right'], { colwidth: [200] })] },
  { type: 'tableRow', content: [
    cell('tableCell', ['A'], { colwidth: [100] }),
    cell('tableHeader', ['Middle header'], { colwidth: [150] }),
    cell('tableCell', ['C'], { colwidth: [200] }),
  ] },
] };
async function exported(format, documentTable = table) {
  const snapshot = {
    notebooks: [{ id: 'notebook', name: 'Notebook', discipline: 'Chemistry' }],
    experiments: [{ id: 'experiment', notebookId: 'notebook', label: 'Series' }],
    runs: [{ id: 'run', notebookId: 'notebook', experimentId: 'experiment', label: 'Series', experimentNumber: 1, runNumber: 1, title: 'Table run', date: '2026-09-09', author: 'Tester', documents: { data: { type: 'doc', content: [documentTable] } } }],
    attachments: [], schemes: [],
  };
  const model = await resolveExportDocument({ snapshot: () => snapshot }, null, {
    scope: 'entry', notebookId: 'notebook', runIds: ['run'], format, order: 'newest', sections: ['data'], data: 'none', jobId: 'tables',
  });
  return { model, ...(await renderExportDocument(model)) };
}

test('HTML retains widths, simultaneous spans, cell header identity, and paragraphs', async () => {
  const { bytes, model } = await exported('html');
  assert.deepEqual(model.entries[0].sections[0].document.content[0].content[0].content[0].attrs.colwidth, [100, 150]);
  const html = bytes.toString();
  assert.match(html, /<col style="width:100px"><col style="width:150px"><col style="width:200px">/);
  assert.match(html, /<td colspan="2" rowspan="2"><p>Merged first<\/p><p>Separate paragraph<\/p><\/td>/);
  assert.match(html, /<th colspan="1" rowspan="1"><p>Middle header<\/p><\/th>/);
  assert.equal((html.match(/Merged first/g) || []).length, 1);
  assert.equal((html.match(/<th /g) || []).length, 2);
});

test('RTF uses logical grid boundaries, horizontal and vertical merges, and genuine headers', async () => {
  const { bytes } = await exported('rtf');
  const rtf = bytes.toString();
  for (const control of ['\\cellx1500', '\\cellx3750', '\\cellx6750', '\\clmgf', '\\clmrg', '\\clvmgf', '\\clvmrg']) assert.ok(rtf.includes(control), control);
  assert.match(rtf, /Merged first\\par\nSeparate paragraph/);
  assert.ok(rtf.includes('{\\b Side header}'));
  assert.ok(rtf.includes('{\\b Middle header}'));
  assert.ok(!rtf.includes('{\\b Merged first'));
  assert.equal((rtf.match(/Merged first/g) || []).length, 1);
});

test('DOCX retains column dimensions, combined merges, paragraphs and actual header styling', async () => {
  const { bytes } = await exported('docx');
  const zip = await JSZip.loadAsync(bytes);
  const xml = await zip.file('word/document.xml').async('string');
  for (const width of [1500, 2250, 3000]) assert.ok(xml.includes(`<w:gridCol w:w="${width}"/>`));
  assert.match(xml, /<w:gridSpan w:val="2"\/>/);
  assert.match(xml, /<w:vMerge w:val="restart"\/>/);
  assert.match(xml, /<w:vMerge w:val="continue"\/>/);
  const cells = xml.match(/<w:tc>.*?<\/w:tc>/g);
  const merged = cells.find(value => value.includes('Merged first'));
  assert.equal((merged.match(/<w:p>/g) || []).length, 2);
  assert.ok(!merged.includes('<w:b/>'));
  assert.ok(cells.find(value => value.includes('Middle header')).includes('<w:b/>'));
  assert.equal((xml.match(/Merged first/g) || []).length, 1);
});

for (const format of ['txt', 'md']) test(`${format} keeps paragraphs readable and explicitly warns about width and merge losses`, async () => {
  const { bytes, model } = await exported(format);
  const text = bytes.toString();
  assert.ok(text.includes('Merged first Separate paragraph'));
  assert.equal((text.match(/Merged first/g) || []).length, 1);
  assert.ok(model.warnings.some(warning => warning.includes('column widths') && warning.includes('merged-cell')));
});


test('all 50 rows remain merged when a full chooser-sized table is exported', async () => {
  const large = { type:'table', content:Array.from({length:50}, (_, index) => ({ type:'tableRow', content:index === 0 ? [cell('tableCell',['Fifty rows'],{rowspan:50,colspan:1,colwidth:[160]})] : [] })) };
  const html = await exported('html',large);
  assert.match(html.bytes.toString(), /rowspan="50"/);
  const rtf = await exported('rtf',large);
  assert.equal((rtf.bytes.toString().match(/\\clvmrg/g) || []).length,49);
  const document = await exported('docx',large);
  const zip = await JSZip.loadAsync(document.bytes);
  const xml = await zip.file('word/document.xml').async('string');
  assert.equal((xml.match(/w:vMerge w:val="continue"/g) || []).length,49);
});
