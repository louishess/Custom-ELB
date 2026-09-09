'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { DEFAULT_YIELD_INPUTS, calculateYield, validateYieldInputs, yieldSummary } = require('../shared/yield.cjs');
const inputs = patch => ({ ...DEFAULT_YIELD_INPUTS, startingAmount: '2', productAmount: '1', ...patch });
test('mixed units and equivalents produce 75 percent without mutating inputs', () => {
  const value = inputs({ startingEquivalents: '2', productUnit: 'µmol', productAmount: '750' });
  const before = structuredClone(value);
  const result = calculateYield(value);
  assert.equal(result.status, 'valid'); assert.equal(result.percentage, 75); assert.equal(result.above100, false);
  assert.ok(Math.abs(result.theoreticalAmount - 1000) < 1e-9);
  assert.equal(result.theoreticalMol, .001);
  assert.deepEqual(value, before);
});
test('all unit pairs convert and decimal/scientific notation work', () => {
  for (const [unit, amount] of Object.entries({ mol: '0.001', mmol: '1', 'µmol': '1e3', nmol: '1000000' })) {
    const result = calculateYield(inputs({ startingAmount: '+2e0', productAmount: amount, productUnit: unit }));
    assert.equal(result.status, 'valid'); assert.ok(Math.abs(result.percentage - 50) < 1e-10);
  }
});
test('zero product, incomplete strings, invalid numeric syntax and extreme inputs', () => {
  assert.equal(calculateYield(inputs({ productAmount: '0' })).percentage, 0);
  for (const field of ['startingAmount', 'productAmount', 'startingEquivalents', 'productEquivalents']) {
    assert.equal(calculateYield(inputs({ [field]: '' })).status, 'incomplete');
    for (const value of ['1e', 'NaN', 'Infinity', '0x10', '1 2', '1,000', '1e999']) assert.equal(calculateYield(inputs({ [field]: value })).status, 'invalid');
  }
  for (const field of ['startingAmount', 'startingEquivalents', 'productEquivalents']) assert.equal(calculateYield(inputs({ [field]: '0' })).status, 'invalid');
  assert.equal(calculateYield(inputs({ productAmount: '-1' })).status, 'invalid');
  assert.equal(calculateYield(inputs({ startingAmount: '1e-320', startingUnit: 'nmol' })).status, 'invalid');
  assert.equal(calculateYield(inputs({ productAmount: '1e308' })).status, 'invalid');
});
test('above 100 percent is flagged and summaries contain inputs and calculation basis', () => {
  assert.equal(calculateYield(inputs({ productAmount: '3' })).above100, true);
  assert.match(yieldSummary(inputs({ productAmount: '3' })).join('\n'), /150%.*above 100/);
  assert.match(yieldSummary(inputs({ productAmount: '' })).join('\n'), /not entered/);
  assert.match(yieldSummary(inputs()).join('\n'), /Basis:/);
});
test('version and units are validated while unfinished numeric input is preserved', () => {
  assert.equal(validateYieldInputs(inputs({ startingAmount: '1e-' })), true);
  for (const patch of [{ version: 2 }, { startingUnit: 'kg' }, { productAmount: 1 }, { materialLabel: 'x'.repeat(501) }]) assert.equal(validateYieldInputs(inputs(patch)), false);
});
