'use strict';

const yieldMath = require('./yield.cjs');
const NUMBER = '[+-]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:[eE][+-]?\\d+)?';
const NUMERIC = new RegExp(`^${NUMBER}$`);
const MANUAL_FIELDS = ['version', 'sourceText', 'label', 'molarAmount', 'molarUnit', 'equivalents'];
const TOKEN = new RegExp(`^(${NUMBER})\\s*([a-zµμ]+\\.?)$`, 'iu');
const MOLAR_UNITS = Object.freeze({ mol: 'mol', mmol: 'mmol', umol: 'µmol', 'µmol': 'µmol', 'μmol': 'µmol', nmol: 'nmol' });
const MASS_UNITS = Object.freeze({ kg: 'kg', g: 'g', mg: 'mg', ug: 'µg', 'µg': 'µg', 'μg': 'µg', ng: 'ng' });
const VOLUME_UNITS = Object.freeze({ l: 'L', ml: 'mL', ul: 'µL', 'µl': 'µL', 'μl': 'µL', nl: 'nL' });
const invalid = message => ({ status: 'invalid', message });

function finiteNumber(text) {
  const value = Number(text);
  // Reject overflow and numbers rounded all the way down to zero.
  const nonzeroMantissa = /[1-9]/.test(text.split(/[eE]/)[0]);
  return text.length <= 100 && Number.isFinite(value) && !(value === 0 && nonzeroMantissa) ? value : null;
}

function parseMaterial(text) {
  if (typeof text !== 'string' || text.length > 5000) return invalid('Select one complete material, including its parenthesized amounts.');
  const normalized = text.replace(/\s+/gu, ' ').trim();
  if (!normalized.endsWith(')')) return invalid('Include the complete parentheses with mass or volume, molar amount, and equivalents.');
  let depth = 0;
  let opening = -1;
  for (let index = normalized.length - 1; index >= 0; index--) {
    if (normalized[index] === ')') depth++;
    else if (normalized[index] === '(' && --depth === 0) { opening = index; break; }
  }
  if (opening < 0) return invalid('The material has unbalanced parentheses.');
  const label = normalized.slice(0, opening).trim();
  if (!label || label.length > 500) return invalid('Include a chemical name before its amounts (up to 500 characters).');
  depth = 0;
  for (const character of label) {
    if (character === '(') depth++;
    else if (character === ')' && --depth < 0) return invalid('The chemical name has unbalanced parentheses.');
  }
  if (depth !== 0) return invalid('The chemical name has unbalanced parentheses.');
  // Names may contain parentheses and commas, but an earlier quantity group
  // means the selection contains more than one material.
  if (new RegExp(`\\([^)]*${NUMBER}\\s*(?:mol|mmol|[uµμ]mol|nmol|eq(?:uiv(?:alents)?)?\\.?)\\b`, 'iu').test(label)) {
    return invalid('Select exactly one material; this selection contains another amount or equivalents group.');
  }
  const fields = normalized.slice(opening + 1, -1).split(',').map(field => field.trim());
  if (fields.length !== 3) return invalid('Use exactly one mass or volume, one molar amount, and one equivalents value, separated by commas.');
  let quantity;
  let molarAmount;
  let molarUnit;
  let equivalents;
  for (const field of fields) {
    const match = TOKEN.exec(field);
    if (!match) return invalid(`Cannot read “${field}”. Use a number followed by a supported unit or eq./equiv.`);
    const [, amount, rawUnit] = match;
    const value = finiteNumber(amount);
    if (value === null) return invalid('Amounts and equivalents must be finite decimal numbers or scientific notation within the supported numeric range.');
    const unit = rawUnit.toLowerCase();
    if (Object.hasOwn(MOLAR_UNITS, unit)) {
      if (molarAmount !== undefined) return invalid('The material has more than one molar amount.');
      if (value < 0) return invalid('The molar amount cannot be negative.');
      molarAmount = amount;
      molarUnit = MOLAR_UNITS[unit];
    } else if (/^(?:eq|equiv|equivalents)\.?$/.test(unit)) {
      if (equivalents !== undefined) return invalid('The material has more than one equivalents value.');
      if (value <= 0) return invalid('Equivalents must be positive.');
      equivalents = amount;
    } else if (Object.hasOwn(MASS_UNITS, unit) || Object.hasOwn(VOLUME_UNITS, unit)) {
      if (quantity) return invalid('The material has more than one mass or volume.');
      if (value < 0) return invalid('Mass or volume cannot be negative.');
      const kind = Object.hasOwn(MASS_UNITS, unit) ? 'mass' : 'volume';
      quantity = { amount, unit: (kind === 'mass' ? MASS_UNITS : VOLUME_UNITS)[unit], kind };
    } else return invalid(`Unsupported unit “${rawUnit}”. Use mol/mmol/µmol/nmol, a mass or volume unit, and eq./equiv.`);
  }
  if (!quantity || molarAmount === undefined || equivalents === undefined) return invalid('Include one mass or volume, one molar amount, and one equivalents value.');
  return { status: 'valid', label, molarAmount, molarUnit, equivalents, quantity };
}

function validateManualMaterial(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.version !== 1 || Object.keys(value).length !== MANUAL_FIELDS.length || Object.keys(value).some(key => !MANUAL_FIELDS.includes(key))) return false;
  if (typeof value.sourceText !== 'string' || !value.sourceText.trim() || value.sourceText.length > 10000 || typeof value.label !== 'string' || !value.label.trim() || value.label.length > 500) return false;
  if (typeof value.molarUnit !== 'string' || !Object.hasOwn(yieldMath.UNITS, value.molarUnit)) return false;
  for (const key of ['molarAmount', 'equivalents']) {
    if (typeof value[key] !== 'string' || value[key].length > 100 || !NUMERIC.test(value[key].trim()) || finiteNumber(value[key].trim()) === null) return false;
  }
  return Number(value.molarAmount) >= 0 && Number(value.equivalents) > 0;
}

function resolveMaterial(text, manual) {
  if (manual == null) return parseMaterial(text);
  if (!validateManualMaterial(manual)) return invalid('The manually entered material amounts are unsupported. Mark this material again and re-enter its amounts.');
  if (manual.sourceText !== text) return invalid('The highlighted text has changed since its amounts were entered manually. Mark this material again and re-enter its amounts.');
  return { status: 'valid', label: manual.label.trim(), molarAmount: manual.molarAmount.trim(), molarUnit: manual.molarUnit, equivalents: manual.equivalents.trim() };
}

function collectMarkedMaterials(documents) {
  const result = { starting: [], product: [], errors: [] };
  const seen = new Map();
  let active = null;
  let nodes = 0;
  function close() {
    if (!active) return;
    if (seen.has(active.id)) result.errors.push('A material highlight is fragmented or repeated. Clear and mark the complete material again.');
    seen.set(active.id, active.role);
    result[active.role].push({ id: active.id, text: active.text, ...(active.manual === undefined ? {} : { manual: active.manual }) });
    active = null;
  }
  function visit(node, depth = 0) {
    if (!node || typeof node !== 'object' || depth > 100 || ++nodes > 100000) {
      close();
      result.errors.push('The document cannot be read safely for yield calculation.');
      return;
    }
    const marks = Array.isArray(node.marks) ? node.marks.filter(mark => mark?.type === 'yieldMaterial') : [];
    if (node.type === 'text' && typeof node.text === 'string') {
      if (!marks.length) { close(); return; }
      const attrs = marks[0]?.attrs;
      if (marks.length !== 1 || !attrs || !['starting', 'product'].includes(attrs.role) || typeof attrs.id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(attrs.id) || (attrs.manual != null && !validateManualMaterial(attrs.manual))) {
        close();
        result.errors.push('A material highlight has unsupported or conflicting attributes. Mark the material again.');
        return;
      }
      if (active && (active.id !== attrs.id || active.role !== attrs.role)) close();
      if (active && MANUAL_FIELDS.some(key => active.manual?.[key] !== attrs.manual?.[key])) result.errors.push('A material highlight contains conflicting manual amounts. Mark the complete material again.');
      if (!active) active = { id: attrs.id, role: attrs.role, text: '', manual: attrs.manual ?? undefined };
      active.text += node.text;
      return;
    }
    close();
    if (marks.length) result.errors.push('Material highlights must contain only text in one uninterrupted paragraph or table cell.');
    if (Array.isArray(node.content)) for (const child of node.content) visit(child, depth + 1);
    close();
  }
  const docs = Array.isArray(documents) ? documents : documents?.type ? [documents] : documents && typeof documents === 'object' ? Object.values(documents) : [];
  for (const doc of docs) { if (doc != null) visit(doc); close(); }
  result.errors = [...new Set(result.errors)];
  return result;
}

function calculateMarkedYield(documents) {
  const materials = collectMarkedMaterials(documents);
  if (materials.errors.length) return invalid(materials.errors.join(' '));
  if (materials.starting.length > 1 || materials.product.length > 1) return invalid('Keep exactly one starting-material highlight and one product highlight in this run.');
  if (!materials.starting.length || !materials.product.length) return { status: 'incomplete', message: 'Mark one complete starting material and one complete product in this run to calculate yield.' };
  const starting = resolveMaterial(materials.starting[0].text, materials.starting[0].manual);
  if (starting.status !== 'valid') return invalid(`Starting material: ${starting.message}`);
  const product = resolveMaterial(materials.product[0].text, materials.product[0].manual);
  if (product.status !== 'valid') return invalid(`Product: ${product.message}`);
  const calculation = yieldMath.calculateYield({ version: 1, materialLabel: starting.label, productLabel: product.label, startingAmount: starting.molarAmount, startingUnit: starting.molarUnit, productAmount: product.molarAmount, productUnit: product.molarUnit, startingEquivalents: starting.equivalents, productEquivalents: product.equivalents });
  if (calculation.status !== 'valid') return calculation;
  if (Number(product.molarAmount) > 0 && calculation.percentage === 0) return invalid('These values exceed the supported numeric range.');
  const percent = yieldMath.formatPercentage(calculation.percentage);
  const theoretical = yieldMath.formatAmount(calculation.theoreticalAmount);
  const describe = material => `${material.label} (${material.quantity ? `${material.quantity.amount} ${material.quantity.unit}, ` : ''}${material.molarAmount} ${material.molarUnit}, ${material.equivalents} eq.)`;
  const summary = [
    `Starting material: ${describe(starting)}`,
    `Product: ${describe(product)}`,
    `Theoretical yield: ${theoretical} ${product.molarUnit} (100%)`,
    `Actual yield: ${product.quantity ? `${product.quantity.amount} ${product.quantity.unit}; ` : ''}${product.molarAmount} ${product.molarUnit} (${percent}%)`,
    `Basis: ${starting.molarAmount} ${starting.molarUnit} × ${product.equivalents} ÷ ${starting.equivalents} = ${theoretical} ${product.molarUnit} theoretical product (molar units converted); actual ÷ theoretical × 100 = ${percent}%.`,
  ];
  if (calculation.above100) summary.push('Yield is above 100%; check the marked amounts and experimental result.');
  return { status: 'valid', starting, product, theoreticalAmount: calculation.theoreticalAmount, percentage: calculation.percentage, above100: calculation.above100, summary: summary.join('\n') };
}

module.exports = { parseMaterial, validateManualMaterial, resolveMaterial, collectMarkedMaterials, calculateMarkedYield };
