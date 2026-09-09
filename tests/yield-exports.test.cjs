'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const JSZip = require('jszip');
const { resolveExportDocument, renderExportDocument } = require('../electron/backend/exports.cjs');
const { DEFAULT_YIELD_INPUTS } = require('../shared/yield.cjs');
function snapshot(attrs) {
  return { notebooks: [{id:'n',name:'Yield review',discipline:'Chemistry',trashedAt:null}], experiments: [{id:'e',notebookId:'n',label:'Series'}], runs: [{id:'r',notebookId:'n',experimentId:'e',label:'Series',experimentNumber:1,runNumber:1,title:'Yield run',date:'2026-09-09',author:'A',trashedAt:null,documents:{data:{type:'doc',content:[{type:'yieldCalculation',attrs}]}}}], attachments:[],schemes:[] };
}
async function render(format, attrs) {
  const model = await resolveExportDocument({snapshot:()=>snapshot(attrs)}, null, {scope:'entry',notebookId:'n',runIds:['r'],format,order:'newest',sections:['data'],data:'none',jobId:'yield-test'});
  const output = await renderExportDocument(model);
  return {model, text: format === 'docx' ? await (await JSZip.loadAsync(output.bytes)).file('word/document.xml').async('string') : output.bytes.toString('utf8')};
}
test('every export recomputes yield from inputs and includes readable basis', async () => {
  const attrs = {...DEFAULT_YIELD_INPUTS, materialLabel:'Substrate',startingAmount:'2',startingEquivalents:'2',productAmount:'750',productUnit:'µmol', percentage:999};
  for (const format of ['txt','md','html','rtf','docx']) {
    const {model,text} = await render(format, attrs);
    assert.match(text, /Yield calculation/); assert.match(text, /75%/); assert.match(text, /1000/); assert.match(text, /Substrate/); assert.match(text, /Basis:/); assert.doesNotMatch(text, /999/);
    assert.ok(!model.warnings.some(value => value.includes('“yieldCalculation”')));
  }
});
test('unfinished and unsupported yield cards export clearly without misleading numbers', async () => {
  const {text} = await render('txt', {...DEFAULT_YIELD_INPUTS, startingAmount:'2e-'});
  assert.match(text, /2e-/); assert.match(text, /not entered/); assert.doesNotMatch(text, /Yield: \d/);
  const unsupported = await render('html', {...DEFAULT_YIELD_INPUTS,version:2});
  assert.match(unsupported.text, /unsupported inputs/);
});
