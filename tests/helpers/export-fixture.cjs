'use strict';
const zlib = require('node:zlib');
const { DEFAULT_YIELD_INPUTS } = require('../../shared/yield.cjs');
const text = (value, marks) => ({ type: 'text', text: value, ...(marks ? { marks } : {}) });
const paragraph = (...content) => ({ type: 'paragraph', content: content.map(value => typeof value === 'string' ? text(value) : value) });
const document = (...content) => ({ type: 'doc', content });
const cell = (value, header = false, attrs = {}) => ({ type: header ? 'tableHeader' : 'tableCell', attrs, content: [paragraph(value)] });
function png(width, height) {
  const chunk = (name, bytes) => {
    const data = Buffer.concat([Buffer.from(name), bytes]); let crc = 0xffffffff;
    for (const byte of data) { crc ^= byte; for (let i = 0; i < 8; i++) crc = crc >>> 1 ^ (crc & 1 ? 0xedb88320 : 0); }
    const result = Buffer.alloc(data.length + 8); result.writeUInt32BE(bytes.length); data.copy(result, 4); result.writeUInt32BE((crc ^ 0xffffffff) >>> 0, data.length + 4); return result;
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  const pixels = Buffer.alloc((width * 3 + 1) * height, 255);
  for (let y = 0; y < height; y++) {
    pixels[y * (width * 3 + 1)] = 0;
    for (let x = 0; x < width; x++) {
      const at = y * (width * 3 + 1) + x * 3 + 1;
      const line = Math.abs(y / height - (0.7 - 0.4 * Math.sin(x / width * Math.PI))) < .015;
      const grid = x % Math.max(1, Math.round(width / 8)) === 0 || y % Math.max(1, Math.round(height / 6)) === 0;
      pixels.set(line ? [53,101,79] : grid ? [220,220,220] : [250,250,250], at);
    }
  }
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]);
}
function fixture() {
  const rows = [
    { type: 'tableRow', content: [cell('Sample', true, {colwidth:[140]}), cell('Loading / mol %', true, {colwidth:[170]}), cell('Isolated yield / %', true, {colwidth:[190]})] },
    ...[['A', '0.5', '62'], ['B', '1.0', '75'], ['C', '2.0', '76']].map(row => ({ type: 'tableRow', content: row.map(value => cell(value)) })),
  ];
  const method = document(
    {type:'heading',attrs:{level:1},content:[text('Procedure')]},
    {type:'orderedList',attrs:{start:3},content:[
      {type:'listItem',content:[paragraph('Charge a clean vial with substrate and solvent.'),{type:'bulletList',content:[{type:'listItem',content:[paragraph('Keep the vessel sealed between samples.')]}]}]},
      {type:'listItem',content:[paragraph('Stir at 25 °C for 2 h, then collect an aliquot.')]},
      {type:'listItem',content:[paragraph('Concentrate the remaining solution and record the product mass.')]},
    ]},
    {type:'blockquote',content:[paragraph('Observation: the solution remained clear throughout the run.')]},
  );
  const starting = {type:'yieldMaterial',attrs:{role:'starting',id:'fixture-start'}};
  const product = {type:'yieldMaterial',attrs:{role:'product',id:'fixture-product'}};
  const docs = {
    information: document(paragraph('Compare catalyst loading while keeping reaction conditions constant. This example records the setup, observations, and measured results.'),paragraph(text('Substrate', [starting,{type:'bold'}]),text(' (200 mg, 2 mmol, 2 eq.)',[starting]),' was charged with catalyst.'),paragraph('Product: ',text('isolated material (150 mg, 750 µmol, 1 eq.)',[product])),paragraph('Solvent: H',text('2',[{type:'subscript'}]),'O. Calibration: R',text('2',[{type:'superscript'}]),' = 0.998. ',text('Check the balance',[{type:'highlight',attrs:{color:'#fff0a8'}}]),'.')),
    method,
    notes: document(paragraph('A pale suspension developed after workup. Samples A–C were processed in the same order as their labels.'),{type:'codeBlock',content:[text('sample_id, signal\nA, 0.62\nB, 0.75')]},paragraph(text('Reference protocol',[{type:'link',attrs:{href:'https://example.org/protocol'}}]))),
    data: document({type:'table',content:rows},{type:'yieldCalculation',attrs:{...DEFAULT_YIELD_INPUTS,materialLabel:'Substrate',startingAmount:'2',startingEquivalents:'2',productAmount:'750',productUnit:'µmol'}}),
  };
  const run = {id:'run-1',notebookId:'notebook',experimentId:'experiment',label:'Catalyst-screen',experimentNumber:12,runNumber:2,title:'Catalyst loading study',date:'2026-09-12',author:'Alex Rivera',documents:docs};
  const snapshot = {notebooks:[{id:'notebook',name:'Catalysis & synthesis',discipline:'Organic chemistry',color:'sage'}],experiments:[{id:'experiment',notebookId:'notebook',label:'Catalyst-screen'}],runs:[run,{...run,id:'run-2',runNumber:3,date:'2026-09-13',title:'Repeat at lower catalyst loading with an extended title to verify natural wrapping',documents:{information:document(paragraph('Repeat the recorded procedure using a lower catalyst loading.')),method,notes:document(paragraph('Workup and characterization are pending.')),data:document({type:'yieldCalculation',attrs:{...DEFAULT_YIELD_INPUTS,startingAmount:'2e-'}})}}],schemes:[{id:'scheme',notebookId:'notebook',name:'Loading comparison',runIds:['run-1','run-2']}],attachments:[]};
  const images = {landscape:png(640,260),portrait:png(240,360)};
  const previews = {landscape:{kind:'image',mime:'image/png',bytes:images.landscape},portrait:{kind:'image',mime:'image/png',bytes:images.portrait},sheet:{kind:'spreadsheet',sheets:[{name:'Replicates',rows:[['Sample','Response'],['A','0.62'],['B','0.75']]}]},pdf:{kind:'pdf'}};
  for (const [id,name,caption,mime] of [['landscape','response-curve.png','Landscape figure; original data colors are retained.','image/png'],['portrait','sample-profile.png','Portrait figure; proportions are retained.','image/png'],['sheet','measurements.csv','Measured responses.','text/csv'],['pdf','instrument-report.pdf','Original instrument report; caption-only export.','application/pdf']]) snapshot.attachments.push({id,runId:'run-1',name,caption,mime});
  return {snapshot,previews};
}
module.exports = {fixture,png,paragraph,document,cell};
