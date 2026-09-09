const test = require('node:test');
const assert = require('node:assert/strict');
const ExcelJS = require('exceljs');

test('ExcelJS UUID override preserves XLSX conditional formatting and Unicode', async () => {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Measurements');
  sheet.addRows([['Sample', 'Response'], ['α – H₂O', 1.25], ['β', 2.5]]);
  sheet.addConditionalFormatting({
    ref: 'B2:B3',
    rules: [{ type: 'dataBar', cfvo: [{ type: 'min' }, { type: 'max' }], color: { argb: 'FF52947C' }, showValue: true }],
  });
  const buffer = await workbook.xlsx.writeBuffer();
  const reopened = new ExcelJS.Workbook();
  await reopened.xlsx.load(buffer);
  const result = reopened.getWorksheet('Measurements');
  assert.equal(result.getCell('A2').value, 'α – H₂O');
  assert.equal(result.getCell('B3').value, 2.5);
  assert.equal(result.conditionalFormattings.length, 1);
  assert.equal(result.conditionalFormattings[0].rules[0].type, 'dataBar');
});
