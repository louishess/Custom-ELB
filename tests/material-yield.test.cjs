'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseMaterial, validateManualMaterial, resolveMaterial, collectMarkedMaterials, calculateMarkedYield } = require('../shared/material-yield.cjs');
const mark = (role, id) => ({ type: 'yieldMaterial', attrs: { role, id } });
const text = (value, role, id, extraMarks = []) => ({ type: 'text', text: value, marks: role ? [mark(role, id), ...extraMarks] : extraMarks });
const paragraph = (...content) => ({ type: 'paragraph', content });
const doc = (...content) => ({ type: 'doc', content });
const starting = 'Substrate (0.2 g, 2 mmol, 2 eq.)';
const product = 'Product (50 mg, 750 µmol, 1 equiv.)';
const pair = (s = starting, p = product) => ({ information: doc(paragraph(text(s, 'starting', 's'))), data: doc(paragraph(text(p, 'product', 'p'))) });

test('material parser detects quantities with no, single, multiple and Unicode spaces', () => {
  for (const space of ['', ' ', '  ', '\t', '\u00a0', '\u202f', '\n']) {
    const parsed = parseMaterial(`Chemical (1${space}g, 2${space}mmol, 1${space}eq.)`);
    assert.equal(parsed.status, 'valid', JSON.stringify(space));
    assert.equal(parsed.molarAmount, '2');
    assert.deepEqual(parsed.quantity, { amount: '1', unit: 'g', kind: 'mass' });
  }
});

test('material parser canonicalizes all supported amount units without confusing mass and molar units', () => {
  for (const [unit, expected] of Object.entries({ mol: 'mol', mmol: 'mmol', umol: 'µmol', 'µmol': 'µmol', 'μmol': 'µmol', nmol: 'nmol', MMOL: 'mmol' })) {
    assert.equal(parseMaterial(`Chemical (1g, 2${unit}, 1eq.)`).molarUnit, expected);
  }
  for (const [unit, expected] of Object.entries({ kg: 'kg', g: 'g', mg: 'mg', ug: 'µg', 'µg': 'µg', 'μg': 'µg', ng: 'ng' })) {
    assert.deepEqual(parseMaterial(`Chemical (1${unit}, 2mmol, 1eq.)`).quantity, { amount: '1', unit: expected, kind: 'mass' });
  }
  for (const [unit, expected] of Object.entries({ L: 'L', mL: 'mL', ml: 'mL', uL: 'µL', 'µL': 'µL', 'μL': 'µL', nL: 'nL' })) {
    assert.deepEqual(parseMaterial(`Chemical (1${unit}, 2mmol, 1eq.)`).quantity, { amount: '1', unit: expected, kind: 'volume' });
  }
});

test('material parser accepts equivalents aliases, scientific notation and reordered fields', () => {
  for (const unit of ['eq', 'eq.', 'equiv', 'equiv.', 'equivalents', 'EQUIVALENTS', 'EQ.']) {
    const parsed = parseMaterial(`Chemical (1.2E+1${unit}, +2.5e-3mol, .10mL)`);
    assert.equal(parsed.status, 'valid');
    assert.equal(parsed.equivalents, '1.2E+1');
    assert.equal(parsed.molarAmount, '+2.5e-3');
    assert.equal(parsed.quantity.amount, '.10');
  }
});

test('material parser preserves chemical names with nested parentheses and commas', () => {
  const label = '1,2-bis(2-(dimethylamino)ethyl)benzene';
  assert.equal(parseMaterial(`${label} (1g, 2mmol, 1eq.)`).label, label);
});

test('material parser rejects incomplete, duplicate, unsupported and malformed selections', () => {
  const examples = [
    '', 'Chemical', '(1g, 2mmol, 1eq.)', 'Chemical (1g, 2mmol)',
    'Chemical (1g, 2mmol, 1eq.', 'Chemical ((1g, 2mmol, 1eq.)',
    'Chemical) (1g, 2mmol, 1eq.)', 'Chemical (1g, 2mmol, 1eq.) trailing',
    'Chemical (1g, 2mmol, 3mmol)', 'Chemical (1eq., 2mmol, 3equiv)',
    'Chemical (1g, 2mmol, 3mL)', 'Chemical (1g, 2mmol, 1eq., 5mg)',
    'Chemical (1g, 2mmol, eq.)', 'Chemical (1g, 2mmol, 1unknown)',
    'Chemical (1g, 2moles, 1eq.)', 'Chemical (1g, 2mmol approx, 1eq.)',
    'Chemical (1,000g, 2mmol, 1eq.)', 'Chemical (1 000g, 2mmol, 1eq.)',
    'Chemical (1g 2mg, 2mmol, 1eq.)', 'Chemical (1g, (2mmol), 1eq.)',
    'A (1g, 2mmol, 1eq.) and B (2g, 3mmol, 1eq.)',
    'Chemical (-1g, 2mmol, 1eq.)', 'Chemical (1g, -2mmol, 1eq.)',
    'Chemical (1g, 2mmol, 0eq.)', 'Chemical (1g, 2mmol, -1eq.)',
    'Chemical (NaNg, 2mmol, 1eq.)', 'Chemical (Infinityg, 2mmol, 1eq.)',
    'Chemical (1e309g, 2mmol, 1eq.)', 'Chemical (1g, 1e-999mmol, 1eq.)',
    'Chemical (1g, 2mmol, 1e-999eq.)',
  ];
  for (const input of examples) assert.equal(parseMaterial(input).status, 'invalid', input);
});

test('marked yield converts mixed units and applies the user-designated equivalents ratio', () => {
  const result = calculateMarkedYield(pair());
  assert.equal(result.status, 'valid');
  assert.ok(Math.abs(result.theoreticalAmount - 1000) < 1e-10);
  assert.equal(result.percentage, 75);
  assert.equal(result.above100, false);
  assert.match(result.summary, /Theoretical yield: 1000 µmol \(100%\)/);
  assert.match(result.summary, /Actual yield: 50 mg; 750 µmol \(75%\)/);
  assert.match(result.summary, /2 mmol × 1 ÷ 2/);
  assert.doesNotMatch(result.summary, /Theoretical yield:.*(?:mg|g) /);
});

test('marked yield permits zero actual product and flags rather than rejects yields above 100%', () => {
  const zero = calculateMarkedYield(pair(starting, 'Product (0mg, 0mol, 1eq.)'));
  assert.equal(zero.status, 'valid');
  assert.equal(zero.percentage, 0);
  assert.match(zero.summary, /Actual yield: 0 mg; 0 mol \(0%\)/);
  const high = calculateMarkedYield(pair(starting, 'Product (1mL, 2mmol, 1eq.)'));
  assert.equal(high.status, 'valid');
  assert.equal(high.percentage, 200);
  assert.equal(high.above100, true);
  assert.match(high.summary, /above 100%/);
});

test('marked yield rejects zero starting amounts and arithmetic overflow or underflow', () => {
  for (const [s, p] of [
    ['A (1g, 0mmol, 1eq.)', product],
    ['A (1g, 1e308mol, 1eq.)', 'B (1g, 1mol, 1e308eq.)'],
    ['A (1g, 1e-320nmol, 1eq.)', product],
    [starting, 'B (1g, 1e-320nmol, 1eq.)'],
    ['A (1g, 1mol, 1e-300eq.)', 'B (1g, 1mol, 1e300eq.)'],
  ]) assert.equal(calculateMarkedYield(pair(s, p)).status, 'invalid', s + p);
});

test('marked yield recalculates edited text and rounds only displayed percentages', () => {
  const result = calculateMarkedYield(pair('A (1g, 3mmol, 1eq.)', 'B (1g, 1mmol, 1eq.)'));
  assert.equal(result.status, 'valid');
  assert.ok(Math.abs(result.percentage - 100 / 3) < 1e-12);
  assert.match(result.summary, /\(33\.33%\)/);
});

test('scanner preserves adjacent highlights across formatting leaves and accepts section maps, arrays and one document', () => {
  const fragmentedFormatting = doc(paragraph(text('Substrate (0.2 g, ', 'starting', 's'), text('2 mmol', 'starting', 's', [{ type: 'bold' }]), text(', 2 eq.)', 'starting', 's', [{ type: 'italic' }]), text(' and '), text(product, 'product', 'p')));
  for (const documents of [fragmentedFormatting, [fragmentedFormatting], { method: fragmentedFormatting }]) {
    const collected = collectMarkedMaterials(documents);
    assert.deepEqual(collected.errors, []);
    assert.deepEqual(collected.starting, [{ id: 's', text: starting }]);
    assert.equal(calculateMarkedYield(documents).status, 'valid');
  }
});

test('scanner rejects split highlights across unmarked text, hard breaks, paragraphs, table cells and documents', () => {
  const first = text('Substrate (0.2 g, ', 'starting', 's');
  const last = text('2 mmol, 2 eq.)', 'starting', 's');
  const variants = [
    doc(paragraph(first, text(' '), last)),
    doc(paragraph(first, { type: 'hardBreak' }, last)),
    doc(paragraph(first), paragraph(last)),
    doc({ type: 'table', content: [{ type: 'tableRow', content: [{ type: 'tableCell', content: [paragraph(first)] }, { type: 'tableCell', content: [paragraph(last)] }] }] }),
    [doc(paragraph(first)), doc(paragraph(last))],
  ];
  for (const documents of variants) {
    assert.match(collectMarkedMaterials(documents).errors.join(' '), /fragmented or repeated/);
    assert.equal(calculateMarkedYield(documents).status, 'invalid');
  }
});

test('scanner rejects multiple role selections without choosing a starting material or product silently', () => {
  for (const role of ['starting', 'product']) {
    const documents = pair();
    documents.notes = doc(paragraph(text(role === 'starting' ? starting : product, role, 'extra')));
    assert.equal(calculateMarkedYield(documents).status, 'invalid');
  }
  const duplicated = [pair().information, pair().information, pair().data];
  assert.equal(calculateMarkedYield(duplicated).status, 'invalid');
});

test('scanner rejects conflicting, malformed and nontext marks', () => {
  const examples = [
    { type: 'text', text: starting, marks: [mark('starting', 's'), mark('product', 'p')] },
    text(starting, 'unknown', 's'), text(starting, 'starting', ''),
    { type: 'hardBreak', marks: [mark('starting', 's')] },
    { type: 'text', text: starting, marks: [{ type: 'yieldMaterial' }] },
  ];
  for (const node of examples) assert.equal(calculateMarkedYield(doc(paragraph(node))).status, 'invalid');
});

test('unmarked text and existing calculation cards do not become implicit material choices', () => {
  const document = doc(paragraph(text(starting + ' ' + product)), { type: 'yieldCalculation', attrs: { inputs: {} } });
  assert.deepEqual(collectMarkedMaterials(document), { starting: [], product: [], errors: [] });
  assert.equal(calculateMarkedYield(document).status, 'incomplete');
  assert.equal(calculateMarkedYield(pair().information).status, 'incomplete');
  assert.equal(calculateMarkedYield([]).status, 'incomplete');
});

test('invalid selected material reports its role and never returns a plausible result', () => {
  const result = calculateMarkedYield(pair('Substrate (1g, 1eq.)'));
  assert.equal(result.status, 'invalid');
  assert.match(result.message, /^Starting material:/);
  assert.equal(calculateMarkedYield(pair(starting, 'Product (1g, 1eq.)')).status, 'invalid');
});

const manual = (sourceText, amount = '2', unit = 'mmol', equivalents = '2') => ({ version: 1, sourceText, label: sourceText, molarAmount: amount, molarUnit: unit, equivalents });
const manualText = (value, role, id, values = manual(value)) => ({ type: 'text', text: value, marks: [{ ...mark(role, id), attrs: { role, id, manual: values } }] });

test('manual fallback validates required finite amounts and keeps unknown mass or volume absent', () => {
  const value = manual('Unformatted substrate');
  assert.equal(validateManualMaterial(value), true);
  const resolved = resolveMaterial(value.sourceText, value);
  assert.equal(resolved.status, 'valid');
  assert.equal(resolved.molarAmount, '2');
  assert.equal(resolved.quantity, undefined);
  const result = calculateMarkedYield(doc(paragraph(manualText(value.sourceText, 'starting', 's', value), text(' '), manualText('Isolated product', 'product', 'p', manual('Isolated product', '750', 'µmol', '1')))));
  assert.equal(result.status, 'valid');
  assert.equal(result.percentage, 75);
  assert.match(result.summary, /Theoretical yield: 1000 µmol \(100%\)/);
  assert.match(result.summary, /Actual yield: 750 µmol \(75%\)/);
  assert.doesNotMatch(result.summary, /undefined|NaN|(?:\d) mg/);
});

test('manual fallback rejects unsupported fields, invalid inputs and out-of-range values', () => {
  const valid = manual('Substrate');
  const examples = [null, [], {}, { ...valid, version: 2 }, { ...valid, extra: true },
    { ...valid, sourceText: '' }, { ...valid, sourceText: 'x'.repeat(10001) },
    { ...valid, label: ' ' }, { ...valid, label: 'x'.repeat(501) },
    { ...valid, molarAmount: -1 }, { ...valid, molarAmount: '-1' },
    { ...valid, molarAmount: '' }, { ...valid, molarAmount: '1e309' },
    { ...valid, molarAmount: '1e-999' }, { ...valid, molarAmount: '1mmol' },
    { ...valid, molarAmount: '  '.repeat(100) + '1' },
    { ...valid, molarUnit: 'umol' }, { ...valid, molarUnit: {} },
    { ...valid, equivalents: '0' }, { ...valid, equivalents: '-1' },
    { ...valid, equivalents: 'NaN' }, { ...valid, equivalents: '1e-999' },
  ];
  for (const value of examples) {
    assert.equal(validateManualMaterial(value), false, JSON.stringify(value));
    assert.equal(resolveMaterial('Substrate', value).status, 'invalid');
  }
  assert.equal(validateManualMaterial({ ...valid, molarAmount: '0' }), true);
  assert.equal(validateManualMaterial({ ...valid, molarAmount: ' +1.25e-3 ', equivalents: ' 1.0 ' }), true);
});

test('manual fallback becomes invalid when source text changes, including whitespace', () => {
  const value = manual('Substrate');
  for (const changed of ['Different substrate', 'Substrate ', 'substrate']) {
    const result = resolveMaterial(changed, value);
    assert.equal(result.status, 'invalid');
    assert.match(result.message, /text has changed/);
  }
  const result = calculateMarkedYield(doc(paragraph(manualText('Changed substrate', 'starting', 's', value), text(' '), text(product, 'product', 'p'))));
  assert.equal(result.status, 'invalid');
  assert.match(result.message, /re-enter/);
});

test('manual fallback survives formatting leaf splits but rejects conflicting values', () => {
  const value = manual('Unformatted substrate');
  const first = manualText('Unformatted ', 'starting', 's', value);
  const second = manualText('substrate', 'starting', 's', { ...value });
  second.marks.push({ type: 'bold' });
  const document = doc(paragraph(first, second, text(' '), text(product, 'product', 'p')));
  assert.equal(calculateMarkedYield(document).status, 'valid');
  assert.deepEqual(collectMarkedMaterials(document).starting[0].manual, value);
  second.marks[0].attrs.manual.molarAmount = '3';
  assert.equal(calculateMarkedYield(document).status, 'invalid');
  delete second.marks[0].attrs.manual;
  assert.equal(calculateMarkedYield(document).status, 'invalid');
});

test('positive actual yield that underflows to zero is rejected instead of displayed as zero', () => {
  const result = calculateMarkedYield(pair('A (1g, 1e300mol, 1eq.)', 'B (1g, 1e-300mol, 1eq.)'));
  assert.equal(result.status, 'invalid');
  assert.match(result.message, /numeric range/);
});
