'use strict';

const UNITS = Object.freeze({ mol: 1, mmol: 1e-3, 'µmol': 1e-6, nmol: 1e-9 });
const DEFAULT_YIELD_INPUTS = Object.freeze({ version: 1, materialLabel: '', productLabel: '', startingAmount: '', startingUnit: 'mmol', productAmount: '', productUnit: 'mmol', startingEquivalents: '1', productEquivalents: '1' });
const numericFields = ['startingAmount', 'productAmount', 'startingEquivalents', 'productEquivalents'];
function validateYieldInputs(value) {
  if (!value || typeof value !== 'object' || value.version !== 1) return false;
  if (!Object.hasOwn(UNITS, value.startingUnit) || !Object.hasOwn(UNITS, value.productUnit)) return false;
  return numericFields.every(key => typeof value[key] === 'string' && value[key].length <= 100)
    && ['materialLabel', 'productLabel'].every(key => typeof value[key] === 'string' && value[key].length <= 500);
}
function parseAmount(value) {
  const trimmed = value.trim();
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(trimmed)) return null;
  const result = Number(trimmed);
  return Number.isFinite(result) ? result : null;
}
function calculateYield(inputs) {
  if (!validateYieldInputs(inputs)) return { status: 'invalid', message: 'This yield calculation has unsupported inputs.' };
  if (numericFields.some(key => inputs[key].trim() === '')) return { status: 'incomplete', message: 'Enter both amounts and positive equivalents to calculate yield.' };
  const [starting, product, startingEq, productEq] = numericFields.map(key => parseAmount(inputs[key]));
  if ([starting, product, startingEq, productEq].some(value => value === null)) return { status: 'invalid', message: 'Use a finite decimal or scientific notation for every amount and equivalent.' };
  if (starting <= 0 || startingEq <= 0 || productEq <= 0 || product < 0) return { status: 'invalid', message: 'Starting amount and equivalents must be positive; product amount may be zero.' };
  const theoreticalMol = starting * UNITS[inputs.startingUnit] * productEq / startingEq;
  const productMol = product * UNITS[inputs.productUnit];
  const percentage = productMol / theoreticalMol * 100;
  const theoreticalAmount = theoreticalMol / UNITS[inputs.productUnit];
  if (![theoreticalMol, productMol, percentage, theoreticalAmount].every(Number.isFinite) || theoreticalMol <= 0 || (product > 0 && productMol === 0)) return { status: 'invalid', message: 'These values exceed the supported numeric range.' };
  return { status: 'valid', theoreticalMol, theoreticalAmount, percentage, above100: percentage > 100 };
}
function formatAmount(value) { return Number(value.toPrecision(10)).toString(); }
function formatPercentage(value) { return value >= 1e12 ? value.toExponential(2) : value.toLocaleString('en-US', { maximumFractionDigits: 2, useGrouping: false }); }
function yieldSummary(inputs) {
  if (!validateYieldInputs(inputs)) return ['Yield calculation: unsupported inputs'];
  const result = calculateYield(inputs);
  const rows = ['Yield calculation', `Starting material${inputs.materialLabel ? ` (${inputs.materialLabel})` : ''}: ${inputs.startingAmount || '[not entered]'} ${inputs.startingUnit}; equivalents: ${inputs.startingEquivalents || '[not entered]'}`, `Product${inputs.productLabel ? ` (${inputs.productLabel})` : ''}: ${inputs.productAmount || '[not entered]'} ${inputs.productUnit}; equivalents: ${inputs.productEquivalents || '[not entered]'}`];
  if (result.status === 'valid') rows.push(`Theoretical product: ${formatAmount(result.theoreticalAmount)} ${inputs.productUnit}`, `Yield: ${formatPercentage(result.percentage)}%${result.above100 ? ' — above 100%; check inputs and experimental result' : ''}`);
  else rows.push(result.message);
  rows.push('Basis: theoretical product = starting amount × product equivalents ÷ starting-material equivalents; yield = actual ÷ theoretical × 100 (amounts converted to matching units).');
  return rows;
}
module.exports = { UNITS, DEFAULT_YIELD_INPUTS, validateYieldInputs, calculateYield, formatAmount, formatPercentage, yieldSummary };
