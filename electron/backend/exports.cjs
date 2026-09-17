'use strict';

/*
 * Local export pipeline.
 *
 * The renderer supplies a selection request and the main process supplies the
 * destination.  This module deliberately only knows about the backend
 * snapshot and file service.  It does not read renderer fixtures or accept a
 * filesystem path as part of the selection itself.
 */

const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { EXPORT_ORDERS, compareRuns } = require('../../shared/ordering.cjs');
const { yieldSummary } = require('../../shared/yield.cjs');
const { DESIGN, twips, contentWidth, sectionLabel, metadata, notebookContext, fitColumns, fitImage, htmlStyles } = require('./export-design.cjs');

let docx;
try {
  // docx is a declared runtime dependency.  Keep loading lazy so source-only
  // diagnostics can still import this module and report a useful failure at
  // render time when dependencies have not been installed yet.
  docx = require('docx');
} catch {
  docx = null;
}

const SECTION_TITLES = Object.freeze({
  information: 'Experimental information',
  method: 'Method',
  notes: 'Notes',
  data: 'Data',
});

const SECTION_IDS = Object.freeze(Object.keys(SECTION_TITLES));
const ORDER_VALUES = new Set([...EXPORT_ORDERS, 'az', 'za']);
const FORMAT_VALUES = new Set(['txt', 'md', 'html', 'rtf', 'docx']);
const DATA_VALUES = new Set(['none', 'captions', 'previews']);
const NODE_TYPE_ALIASES = Object.freeze({
  bulletList: 'bullet_list',
  orderedList: 'ordered_list',
  listItem: 'list_item',
  codeBlock: 'code_block',
  horizontalRule: 'horizontal_rule',
  hardBreak: 'hard_break',
  tableRow: 'table_row',
  tableCell: 'table_cell',
  tableHeader: 'table_header',
});
const MAX_DOC_DEPTH = 80;
const MAX_DOC_NODES = 250000;
const MAX_PREVIEW_BYTES = 64 * 1024 * 1024;
const MAX_TOTAL_PREVIEW_BYTES = 128 * 1024 * 1024;
const MAX_TOTAL_SHEET_CELLS = 100000;
const MAX_SHEET_ROWS = 5000;
const MAX_SHEET_COLUMNS = 200;

const RASTER_MIMES = new Set([
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/gif',
  'image/webp',
  'image/bmp',
  'image/tiff',
]);

const IMAGE_EXTENSIONS = Object.freeze({
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/bmp': '.bmp',
  'image/tiff': '.tiff',
});

class ExportError extends Error {
  constructor(code, message, options = {}) {
    super(message);
    this.name = 'ExportError';
    this.code = code;
    if (options.cause) this.cause = options.cause;
  }
}

function errorCode(error) {
  return error && typeof error.code === 'string' ? error.code : '';
}

function asExportError(error, fallbackCode = 'IO') {
  if (error instanceof ExportError) return error;
  const code = errorCode(error);
  if (code === 'CANCELLED' || code === 'ABORT_ERR' || error?.name === 'AbortError') {
    return new ExportError('CANCELLED', 'Export cancelled', { cause: error });
  }
  return new ExportError(fallbackCode, error?.message || 'Export failed', { cause: error });
}

function unwrap(value) {
  if (value && value.ok === true && Object.prototype.hasOwnProperty.call(value, 'value')) return value.value;
  if (value && value.ok === false && value.error) {
    throw new ExportError(value.error.code || 'IO', value.error.message || 'Backend operation failed');
  }
  return value;
}

function requireObject(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ExportError('VALIDATION', `${name} must be an object`);
  }
  return value;
}

function safeText(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/[\u2028\u2029]/g, '\n');
}

function escapeHtml(value) {
  return safeText(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeXml(value) {
  return safeText(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function sanitizeFilenameComponent(value, fallback = 'export') {
  let result = safeText(value).normalize('NFKC')
    .replace(/[\\/\u0000-\u001F\u007F]/g, '-')
    .replace(/[^a-zA-Z0-9._ -]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[.]+|[.]+$/g, '');
  if (!result || result === '.' || result === '..') result = fallback;
  return result.slice(0, 120) || fallback;
}

function sanitizeAssetStem(value) {
  return sanitizeFilenameComponent(value, 'labmate-export').replace(/[ .]+/g, '-').replace(/-+/g, '-') || 'labmate-export';
}

function sanitizeHref(value) {
  const href = safeText(value).trim();
  if (!href) return null;
  if (/^(https?:|mailto:)/i.test(href)) return href;
  return null;
}

function sanitizeHighlightColor(value) {
  const color = safeText(value).trim();
  if (!color) return null;
  if (/^#[0-9a-f]{3,8}$/i.test(color)) return color.toLowerCase();
  if (/^[a-z]{1,24}$/i.test(color)) return color.toLowerCase();
  return null;
}

function clampInteger(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isInteger(number)) return fallback;
  return Math.max(min, Math.min(max, number));
}

function makeWarning(message, warnings) {
  if (warnings instanceof Set) {
    warnings.add(message);
    return;
  }
  if (!warnings.includes(message)) warnings.push(message);
}

function checkCancelled(context) {
  if (context?.signal?.aborted) throw new ExportError('CANCELLED', 'Export cancelled');
}

function reportProgress(context, request, phase, completed, total, message) {
  if (typeof context?.onProgress !== 'function') return;
  try {
    context.onProgress({
      jobId: safeText(request?.jobId),
      operation: 'exports.write',
      phase,
      ...(Number.isFinite(completed) ? { completed } : {}),
      ...(Number.isFinite(total) ? { total } : {}),
      ...(message ? { message: safeText(message) } : {}),
    });
  } catch {
    // Progress reporting must never fail an export.
  }
}

function normalizeRequest(input) {
  const request = requireObject(input, 'Export request');
  const normalized = {
    scope: safeText(request.scope),
    notebookId: safeText(request.notebookId),
    runIds: Array.isArray(request.runIds) ? request.runIds.map(safeText) : [],
    format: safeText(request.format).toLowerCase(),
    order: safeText(request.order || 'newest').toLowerCase(),
    schemeId: request.schemeId === undefined || request.schemeId === null ? undefined : safeText(request.schemeId),
    sections: Array.isArray(request.sections) ? request.sections.map(safeText) : [],
    data: safeText(request.data || 'none').toLowerCase(),
    jobId: safeText(request.jobId),
    destination: request.destination,
  };

  if (!['entry', 'selected', 'notebook'].includes(normalized.scope)) {
    throw new ExportError('VALIDATION', 'Export scope must be entry, selected, or notebook');
  }
  if (!normalized.notebookId) throw new ExportError('VALIDATION', 'Export notebookId is required');
  if (!FORMAT_VALUES.has(normalized.format)) throw new ExportError('VALIDATION', `Unsupported export format: ${normalized.format || '(empty)'}`);
  if (!ORDER_VALUES.has(normalized.order)) throw new ExportError('VALIDATION', `Unsupported export order: ${normalized.order || '(empty)'}`);
  if (!DATA_VALUES.has(normalized.data)) throw new ExportError('VALIDATION', `Unsupported attachment data mode: ${normalized.data || '(empty)'}`);
  if (!normalized.jobId) throw new ExportError('VALIDATION', 'Export jobId is required');
  if (!normalized.sections.length) throw new ExportError('VALIDATION', 'At least one export section is required');
  const seenSections = new Set();
  for (const section of normalized.sections) {
    if (!SECTION_IDS.includes(section)) throw new ExportError('VALIDATION', `Unknown export section: ${section}`);
    if (seenSections.has(section)) throw new ExportError('VALIDATION', `Export section is repeated: ${section}`);
    seenSections.add(section);
  }
  if (normalized.runIds.some(id => !id)) throw new ExportError('VALIDATION', 'Export runIds must be non-empty IDs');
  if (new Set(normalized.runIds).size !== normalized.runIds.length) throw new ExportError('VALIDATION', 'Export runIds must be unique');
  if (normalized.scope === 'entry' && normalized.runIds.length !== 1) throw new ExportError('VALIDATION', 'Entry export requires exactly one runId');
  if (normalized.scope === 'selected' && normalized.runIds.length === 0) throw new ExportError('VALIDATION', 'Selected export requires at least one runId');
  if (normalized.scope === 'notebook' && normalized.runIds.length) {
    throw new ExportError('VALIDATION', 'Notebook export does not accept runIds');
  }
  return normalized;
}

function normalizeDocNode(node, state, depth = 0) {
  if (depth > MAX_DOC_DEPTH) {
    state.losses.add('Document nesting beyond the supported depth was flattened.');
    return { type: 'paragraph', content: [{ type: 'text', text: '[content omitted]' }] };
  }
  if (!node || typeof node !== 'object' || Array.isArray(node)) {
    state.losses.add('Malformed document content was omitted.');
    return { type: 'paragraph', content: [] };
  }
  state.nodes += 1;
  if (state.nodes > MAX_DOC_NODES) {
    throw new ExportError('VALIDATION', 'Document is too large to export');
  }

  const rawType = safeText(node.type || 'paragraph');
  // A calculation is an editable input node in the library. Export derived,
  // readable paragraphs through the same writers used for ordinary prose.
  if (rawType === 'yieldCalculation') {
    state.lastMaterialKey = null;
    return { type: 'doc', presentation: 'yield-summary', content: yieldSummary(node.attrs).map((text, index) => ({ type: 'paragraph', content: [{ type: 'text', text: safeText(text), ...(index === 0 ? {marks:[{type:'bold'}]} : {}) }] })) };
  }
  const knownTypes = new Set([
    'doc', 'paragraph', 'heading', 'blockquote', 'bullet_list', 'ordered_list', 'list_item',
    'code_block', 'horizontal_rule', 'table', 'table_row', 'table_cell', 'table_header',
    'text', 'hard_break', 'image', 'attachment', 'unsupported',
  ]);
  const canonicalType = NODE_TYPE_ALIASES[rawType] || rawType;
  const type = knownTypes.has(canonicalType) ? canonicalType : 'unsupported';
  if (type === 'unsupported') state.losses.add(`Unsupported rich-text node “${rawType || 'unknown'}” was flattened.`);
  const normalized = { type };

  // Material roles are meaningful without an interactive editor. Emit a role
  // label once for a contiguous selection, even when bold/italic split its text.
  const material = (Array.isArray(node.marks) ? node.marks : []).find(mark => mark?.type === 'yieldMaterial'
    && ['starting', 'product'].includes(mark.attrs?.role)
    && typeof mark.attrs?.id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(mark.attrs.id));
  const materialKey = type === 'text' && material ? `${material.attrs.role}:${material.attrs.id}` : null;
  const beginsMaterial = materialKey && materialKey !== state.lastMaterialKey;
  state.lastMaterialKey = materialKey;

  if (node.text !== undefined) normalized.text = safeText(node.text);
  if (beginsMaterial) normalized.text = `[${material.attrs.role === 'starting' ? 'Starting material' : 'Product'}] ${normalized.text || ''}`;
  const attrs = {};
  if (type === 'heading') attrs.level = clampInteger(node.attrs?.level, 1, 6, 2);
  if (type === 'ordered_list') attrs.order = clampInteger(node.attrs?.start ?? node.attrs?.order, 1, 999999, 1);
  if (node.attrs && typeof node.attrs === 'object') {
    if (type === 'text' || type === 'paragraph' || type === 'heading' || type === 'table_cell' || type === 'table_header') {
      if (typeof node.attrs.colspan === 'number') attrs.colspan = clampInteger(node.attrs.colspan, 1, MAX_DOC_NODES, 1);
      if (typeof node.attrs.rowspan === 'number') attrs.rowspan = clampInteger(node.attrs.rowspan, 1, MAX_DOC_NODES, 1);
      if (['table_cell', 'table_header'].includes(type) && Array.isArray(node.attrs.colwidth)) {
        attrs.colwidth = node.attrs.colwidth.slice(0, attrs.colspan || 1).map(width => Number.isFinite(width) && width > 0 ? Math.min(10000, Math.round(width)) : null);
      }
      const textAlign = node.attrs.textAlign ?? node.attrs.align;
      if (typeof textAlign === 'string' && ['left', 'center', 'right'].includes(textAlign)) attrs.align = textAlign;
    }
    if (type === 'text' && node.attrs.href) {
      const href = sanitizeHref(node.attrs.href);
      if (href) attrs.href = href;
      else state.losses.add('Unsafe links were emitted as plain text.');
    }
    if (type === 'image' && typeof node.attrs.alt === 'string') attrs.alt = safeText(node.attrs.alt);
  }
  if (Object.keys(attrs).length) normalized.attrs = attrs;
  if (Array.isArray(node.marks) && node.marks.length) {
    normalized.marks = node.marks.map(mark => {
      const markType = safeText(mark?.type);
      const allowed = new Set(['bold', 'italic', 'underline', 'strike', 'code', 'superscript', 'subscript', 'link', 'highlight', 'yieldMaterial']);
      if (!allowed.has(markType)) {
        state.losses.add(`Unsupported text mark “${markType || 'unknown'}” was flattened.`);
        return null;
      }
      const markOut = { type: markType };
      if (markType === 'yieldMaterial') {
        if (mark !== material) {
          state.losses.add('Invalid yield material marks were flattened.');
          return null;
        }
        return { type: 'highlight', attrs: {
          color: mark.attrs.role === 'starting' ? DESIGN.starting : DESIGN.product,
          materialRole: mark.attrs.role,
        } };
      }
      if (markType === 'link') {
        const href = sanitizeHref(mark?.attrs?.href);
        if (href) markOut.attrs = { href };
        else {
          state.losses.add('Unsafe links were emitted as plain text.');
          return null;
        }
      }
      if (markType === 'highlight') {
        if (material) return null; // Role colors take precedence over ordinary highlighting.
        const color = sanitizeHighlightColor(mark?.attrs?.color);
        if (color) markOut.attrs = { color };
      }
      return markOut;
    }).filter(Boolean);
    if (!normalized.marks.length) delete normalized.marks;
  }
  if (Array.isArray(node.content)) normalized.content = node.content.map(child => normalizeDocNode(child, state, depth + 1));
  return normalized;
}

function normalizeDocument(document, state) {
  if (!document || typeof document !== 'object') return { type: 'doc', content: [] };
  const normalized = normalizeDocNode(document, state);
  if (normalized.type === 'doc') return normalized;
  state.losses.add('A non-document root was wrapped for export.');
  return { type: 'doc', content: [normalized] };
}

function dateCompare(first, second) {
  const a = safeText(first.date);
  const b = safeText(second.date);
  return a < b ? -1 : a > b ? 1 : 0;
}

function stableCompare(first, second, comparator) {
  const result = comparator(first, second);
  if (result) return result;
  return safeText(first.id).localeCompare(safeText(second.id));
}

function orderRuns(runs, order, scheme) {
  if (order === 'scheme') {
    if (!scheme) throw new ExportError('VALIDATION', 'Scheme order requires a schemeId');
    const index = new Map(scheme.runIds.map((id, position) => [id, position]));
    return [...runs].sort((a, b) => {
      const ai = index.has(a.id) ? index.get(a.id) : Number.MAX_SAFE_INTEGER;
      const bi = index.has(b.id) ? index.get(b.id) : Number.MAX_SAFE_INTEGER;
      return ai - bi || safeText(a.id).localeCompare(safeText(b.id));
    });
  }
  return [...runs].sort((a, b) => compareRuns(a, b, order));
}

function inferMime(record) {
  const mime = safeText(record?.mime).toLowerCase();
  if (mime) return mime;
  const extension = path.extname(safeText(record?.name)).toLowerCase();
  if (extension === '.png') return 'image/png';
  if (extension === '.jpg' || extension === '.jpeg') return 'image/jpeg';
  if (extension === '.gif') return 'image/gif';
  if (extension === '.webp') return 'image/webp';
  return 'application/octet-stream';
}

function sanitizeAttachment(record) {
  return {
    id: safeText(record?.id),
    name: safeText(record?.name) || 'attachment',
    mime: inferMime(record),
    size: Number.isFinite(Number(record?.size)) ? Number(record.size) : 0,
    caption: safeText(record?.caption),
    kind: safeText(record?.kind || 'file'),
    hash: safeText(record?.hash),
  };
}

function normalizePreview(preview) {
  if (!preview || typeof preview !== 'object') return null;
  const kind = safeText(preview.kind).toLowerCase();
  if (!['image', 'pdf', 'spreadsheet', 'unsupported'].includes(kind)) return { kind: 'unsupported', message: 'Unsupported preview type' };
  const normalized = { kind };
  if (preview.mime) normalized.mime = safeText(preview.mime).toLowerCase();
  if (preview.message) normalized.message = safeText(preview.message);
  if (preview.bytes !== undefined && preview.bytes !== null) {
    let bytes;
    try { bytes = Buffer.from(preview.bytes); } catch { bytes = null; }
    if (bytes && bytes.length <= MAX_PREVIEW_BYTES) normalized.bytes = bytes;
    else normalized.message = 'Preview exceeds export size limit';
  }
  if (Array.isArray(preview.sheets)) {
    normalized.sheets = preview.sheets.slice(0, 100).map(sheet => ({
      name: safeText(sheet?.name) || 'Sheet',
      rows: Array.isArray(sheet?.rows) ? sheet.rows.slice(0, MAX_SHEET_ROWS).map(row =>
        (Array.isArray(row) ? row.slice(0, MAX_SHEET_COLUMNS) : []).map(cell => safeText(cell))) : [],
    }));
  }
  return normalized;
}

function spreadsheetCellCount(preview) {
  if (preview?.kind !== 'spreadsheet' || !Array.isArray(preview.sheets)) return 0;
  return preview.sheets.reduce((total, sheet) => total + (sheet.rows || []).reduce((rowTotal, row) => rowTotal + row.length, 0), 0);
}

function boundAggregatePreview(attachment, preview, totals, warnings) {
  if (!preview) return preview;
  if (preview.kind === 'image' && preview.bytes) {
    const bytes = Buffer.byteLength(preview.bytes);
    if (totals.bytes + bytes > MAX_TOTAL_PREVIEW_BYTES) {
      makeWarning(`Attachment “${attachment.name}” exceeded the aggregate ${MAX_TOTAL_PREVIEW_BYTES / (1024 * 1024)} MiB image-preview budget; its filename and caption were retained.`, warnings);
      return { kind: 'unsupported', mime: preview.mime, message: 'Aggregate image preview budget exceeded' };
    }
    totals.bytes += bytes;
  }
  if (preview.kind === 'spreadsheet') {
    const cells = spreadsheetCellCount(preview);
    if (totals.cells + cells > MAX_TOTAL_SHEET_CELLS) {
      makeWarning(`Attachment “${attachment.name}” exceeded the aggregate ${MAX_TOTAL_SHEET_CELLS.toLocaleString('en-US')} spreadsheet-cell budget; its filename and caption were retained.`, warnings);
      return { kind: 'unsupported', mime: preview.mime, message: 'Aggregate spreadsheet preview budget exceeded' };
    }
    totals.cells += cells;
  }
  return preview;
}

function imageMime(preview, attachment) {
  const mime = safeText(preview?.mime || attachment?.mime).toLowerCase();
  return RASTER_MIMES.has(mime) ? mime : null;
}

function imageExtension(mime, name) {
  if (IMAGE_EXTENSIONS[mime]) return IMAGE_EXTENSIONS[mime];
  const ext = path.extname(safeText(name)).toLowerCase();
  return ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.tif', '.tiff'].includes(ext) ? ext : '.bin';
}

async function loadImageBytes(fileService, attachment, preview, request, context) {
  if (preview?.bytes && imageMime(preview, attachment)) return Buffer.from(preview.bytes);
  if (!fileService || typeof fileService.getPath !== 'function') return null;
  try {
    checkCancelled(context);
    let managedPath = unwrap(await fileService.getPath(attachment.id));
    if (typeof managedPath !== 'string' || !path.isAbsolute(managedPath)) return null;
    const bytes = await fsp.readFile(managedPath);
    if (bytes.length > MAX_PREVIEW_BYTES) return null;
    return bytes;
  } catch (error) {
    if (errorCode(error) === 'CANCELLED') throw error;
    return null;
  }
}

async function resolveExportDocument(store, fileService, input, context = {}) {
  const request = normalizeRequest(input);
  checkCancelled(context);
  if (!store || typeof store.snapshot !== 'function') throw new ExportError('UNAVAILABLE', 'Library store is unavailable');
  const snapshot = requireObject(unwrap(store.snapshot()), 'Library snapshot');
  const notebooks = Array.isArray(snapshot.notebooks) ? snapshot.notebooks : [];
  const experiments = Array.isArray(snapshot.experiments) ? snapshot.experiments : [];
  const runs = Array.isArray(snapshot.runs) ? snapshot.runs : [];
  const schemes = Array.isArray(snapshot.schemes) ? snapshot.schemes : [];
  const attachments = Array.isArray(snapshot.attachments) ? snapshot.attachments : [];
  const notebook = notebooks.find(item => item && item.id === request.notebookId);
  if (!notebook) throw new ExportError('NOT_FOUND', `Notebook not found: ${request.notebookId}`);
  if (notebook.trashedAt) throw new ExportError('NOT_FOUND', `Notebook is in the trash: ${request.notebookId}`);

  let scheme;
  if (request.schemeId) {
    scheme = schemes.find(item => item && item.id === request.schemeId);
    if (!scheme) throw new ExportError('NOT_FOUND', `Scheme not found: ${request.schemeId}`);
    if (scheme.notebookId !== request.notebookId) throw new ExportError('VALIDATION', 'Scheme belongs to a different notebook');
  }

  const activeRuns = runs.filter(item => item && item.notebookId === request.notebookId && !item.trashedAt && experiments.some(parent => parent.id === item.experimentId && !parent.trashedAt));
  let selectedRuns;
  if (request.scope === 'notebook') {
    selectedRuns = scheme ? activeRuns.filter(run => scheme.runIds.includes(run.id)) : activeRuns;
    if (request.order === 'scheme' && !scheme) throw new ExportError('VALIDATION', 'Notebook scheme order requires a schemeId');
  } else {
    const selectedSet = new Set(request.runIds);
    const missing = request.runIds.find(id => !activeRuns.some(run => run.id === id));
    if (missing) throw new ExportError('NOT_FOUND', `Run not found in notebook: ${missing}`);
    if ((request.scope === 'selected' || request.scope === 'entry') && scheme) {
      const outside = request.runIds.find(id => !scheme.runIds.includes(id));
      if (outside) throw new ExportError('VALIDATION', `Selected run is outside scheme “${safeText(scheme.name)}”: ${outside}`);
    }
    selectedRuns = activeRuns.filter(run => selectedSet.has(run.id));
  }
  selectedRuns = orderRuns(selectedRuns, request.order, scheme);
  if (!selectedRuns.length) throw new ExportError('VALIDATION', 'Export selection contains no active runs');

  const losses = new Set();
  const entryAttachments = new Map();
  for (const record of attachments) {
    if (!record || !record.runId) continue;
    if (!entryAttachments.has(record.runId)) entryAttachments.set(record.runId, []);
    entryAttachments.get(record.runId).push(sanitizeAttachment(record));
  }

  const experimentById = new Map(experiments.map(item => [item.id, item]));
  const totalPreviewCount = request.data === 'previews' && request.sections.includes('data')
    ? selectedRuns.reduce((count, run) => count + (entryAttachments.get(run.id) || []).length, 0) : 0;
  let completedPreviews = 0;
  const previewTotals = { bytes: 0, cells: 0 };
  reportProgress(context, request, 'resolve', 0, totalPreviewCount || selectedRuns.length, 'Resolving export selection');

  const entries = [];
  for (const run of selectedRuns) {
    checkCancelled(context);
    const experiment = experimentById.get(run.experimentId);
    if (!experiment) throw new ExportError('CORRUPT_BACKUP', `Experiment not found for run: ${run.id}`);
    const sections = request.sections.map(id => ({
      id,
      title: SECTION_TITLES[id],
      document: normalizeDocument(run.documents?.[id], { losses, nodes: 0 }),
    }));
    const references = (snapshot.citations || []).filter(citation => citation.experimentId === experiment.id);
    if (references.length) {
      const {referenceText, safeURL} = require('../../shared/citations.cjs');
      const paragraphs = references.map(citation => {
        const label = referenceText(citation.snapshot);
        const url = safeURL(citation.snapshot.doi
          ? `https://doi.org/${citation.snapshot.doi.replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '')}`
          : citation.snapshot.url);
        const content = url && label.endsWith(url)
          ? [{type: 'text', text: label.slice(0, -url.length)}, {type: 'text', text: url, marks: [{type: 'link', attrs: {href: url}}]}]
          : [{type: 'text', text: label}];
        return {type: 'paragraph', content: content.filter(node => node.text)};
      });
      sections.push({id: 'references', title: 'References', document: normalizeDocument({type: 'doc', content: paragraphs}, {losses, nodes: 0})});
    }
    const resolvedAttachments = request.sections.includes('data') && request.data !== 'none'
      ? (entryAttachments.get(run.id) || []).map(item => ({ ...item })) : [];
    if (request.data === 'previews' && request.sections.includes('data')) {
      for (const item of resolvedAttachments) {
        checkCancelled(context);
        let preview = null;
        try {
          if (fileService && typeof fileService.preview === 'function') {
            preview = normalizePreview(unwrap(await fileService.preview({ id: item.id, jobId: request.jobId }, context)));
          }
        } catch (error) {
          if (errorCode(error) === 'CANCELLED') throw error;
          preview = null;
        }
        const bytes = preview?.kind === 'image' ? await loadImageBytes(fileService, item, preview, request, context) : null;
        if (preview?.kind === 'image' && bytes && imageMime(preview, item)) {
          preview = { ...preview, bytes, mime: imageMime(preview, item) };
        }
        // PDF/scientific previews are intentionally caption-only in exports;
        // discard their payload before it can inflate the resolved model.
        if (preview?.kind === 'pdf') preview = { kind: 'pdf', mime: preview.mime, message: preview.message };
        preview = boundAggregatePreview(item, preview, previewTotals, losses);
        item.preview = preview;
        if (preview?.kind !== 'image' && preview?.kind !== 'spreadsheet') {
          makeWarning(`Attachment “${item.name}” has no embeddable preview; its filename and caption were retained.`, losses);
        } else if (preview.kind === 'image' && !preview.bytes) {
          makeWarning(`Attachment “${item.name}” image preview was unavailable; its filename and caption were retained.`, losses);
        } else if (preview.kind === 'spreadsheet' && !preview.sheets?.length) {
          makeWarning(`Attachment “${item.name}” spreadsheet preview was unavailable; its filename and caption were retained.`, losses);
        }
        completedPreviews += 1;
        reportProgress(context, request, 'preview', completedPreviews, totalPreviewCount, item.name);
      }
    }
    entries.push({
      id: safeText(run.id),
      code: `${safeText(run.label)}-${Number(run.experimentNumber)}-${Number(run.runNumber)}`,
      title: safeText(run.title),
      label: safeText(run.label),
      experimentNumber: Number(run.experimentNumber),
      runNumber: Number(run.runNumber),
      date: safeText(run.date),
      author: safeText(run.author),
      experiment: { id: safeText(experiment.id), label: safeText(experiment.label) },
      sections,
      attachments: resolvedAttachments,
    });
    if (!totalPreviewCount) reportProgress(context, request, 'resolve', entries.length, selectedRuns.length, run.title);
  }

  for (const loss of losses) {
    // Resolve-time metadata is explicit and available to callers before a writer runs.
  }
  const formatLoss = formatLossMetadata(request.format);
  for (const item of formatLoss) losses.add(item.message);
  const destinationName = typeof request.destination === 'string' ? path.basename(request.destination) : '';
  const outputStem = sanitizeAssetStem(path.basename(destinationName, path.extname(destinationName)) || safeText(notebook.name));
  const model = {
    schemaVersion: 1,
    format: request.format,
    scope: request.scope,
    order: request.order,
    scheme: scheme ? { id: safeText(scheme.id), name: safeText(scheme.name) } : null,
    notebook: { id: safeText(notebook.id), name: safeText(notebook.name), discipline: safeText(notebook.discipline) },
    sections: request.sections.map(id => ({ id, title: SECTION_TITLES[id] })),
    data: request.data,
    outputStem,
    entries,
    formatLoss: formatLoss.map(item => ({ ...item })),
    warnings: [...losses],
  };
  reportProgress(context, request, 'resolved', selectedRuns.length, selectedRuns.length, 'Export document resolved');
  return model;
}

function formatLossMetadata(format) {
  const items = [];
  if (format === 'txt') {
    items.push({ feature: 'marks', behavior: 'flattened', message: 'Plain text flattens rich-text marks.' });
    items.push({ feature: 'tables', behavior: 'text rows', message: 'Plain text renders tables as delimited text rows; column widths and merged-cell formatting are lost.' });
    items.push({ feature: 'previews', behavior: 'caption fallback', message: 'Plain text cannot embed previews; attachment filenames and captions are used.' });
  } else if (format === 'md') {
    items.push({ feature: 'tables', behavior: 'text rows', message: 'Markdown tables lose column widths, merged-cell formatting, and individual header-cell styling.' });
    items.push({ feature: 'unsupported-nodes', behavior: 'flattened', message: 'Markdown flattens unsupported rich-text nodes.' });
    items.push({ feature: 'images', behavior: 'relative companions', message: 'Markdown stores image previews as relative companion assets.' });
  } else if (format === 'html') {
    items.push({ feature: 'unsupported-nodes', behavior: 'flattened', message: 'HTML flattens unsupported rich-text nodes.' });
  } else if (format === 'rtf') {
    items.push({ feature: 'unsupported-nodes', behavior: 'flattened', message: 'RTF flattens unsupported rich-text nodes.' });
    items.push({ feature: 'links', behavior: 'label and URL text', message: 'RTF preserves links as readable label and URL text.' });
  } else if (format === 'docx') {
    items.push({ feature: 'unsupported-nodes', behavior: 'flattened', message: 'DOCX flattens unsupported rich-text nodes.' });
    items.push({ feature: 'images', behavior: 'embedded', message: 'DOCX embeds supported raster previews in the document package.' });
  }
  return items;
}

function inlineText(node) {
  if (!node) return '';
  if (node.type === 'text') return safeText(node.text);
  if (node.type === 'hard_break') return '\n';
  return (node.content || []).map(inlineText).join('');
}

function nodeChildren(node) {
  return Array.isArray(node?.content) ? node.content : [];
}

function cellText(cell) {
  return nodeChildren(cell).map(child => ['text', 'hard_break'].includes(child.type) ? inlineText(child) : renderPlainBlocks(child).join(' ')).join(' ').replace(/\s+/g, ' ').trim();
}

function tableRows(node) {
  const layout = tableLayout(node);
  return layout.grid.map((row, rowIndex) => Array.from({ length: layout.width }, (_, column) => {
    const slot = row[column];
    return slot && slot.row === rowIndex && slot.column === column ? cellText(slot.cell) : '';
  }));
}

function tableNodeRows(node) {
  return nodeChildren(node).filter(row => row.type === 'table_row').map(row => ({
    cells: nodeChildren(row).filter(cell => ['table_cell', 'table_header'].includes(cell.type)),
  }));
}

// Tiptap omits cells covered by a rowspan. Lay out the logical grid once so
// widths and cell positions agree across all five writers.
function tableLayout(node) {
  const rows = tableNodeRows(node);
  const grid = rows.map(() => []);
  const placements = rows.map(() => []);
  const columnWidths = [];
  let width = 0;
  let slots = 0;
  rows.forEach((row, rowIndex) => {
    let column = 0;
    for (const cell of row.cells) {
      const colspan = cell.attrs?.colspan || 1;
      const rowspan = Math.min(cell.attrs?.rowspan || 1, rows.length - rowIndex);
      slots += colspan * rowspan;
      if (slots > 1000000) throw new ExportError('VALIDATION', 'Table is too large to export');
      while (Array.from({ length: colspan }, (_, offset) => grid[rowIndex][column + offset]).some(Boolean)) column++;
      const placement = { cell, row: rowIndex, column, colspan, rowspan };
      placements[rowIndex].push(placement);
      for (let dy = 0; dy < rowspan; dy++) for (let dx = 0; dx < colspan; dx++) grid[rowIndex + dy][column + dx] = placement;
      for (let dx = 0; dx < colspan; dx++) if (cell.attrs?.colwidth?.[dx]) columnWidths[column + dx] = cell.attrs.colwidth[dx];
      column += colspan;
      width = Math.max(width, column);
    }
  });
  if (rows.length * width > 1000000) throw new ExportError('VALIDATION', 'Table is too large to export');
  return { grid, placements, width, columnWidths: Array.from({ length: width }, (_, i) => columnWidths[i] || null) };
}

function styledTable(node, model) {
  const layout = tableLayout(node);
  const fitted = fitColumns(layout.columnWidths);
  if (fitted.readable) return { ...layout, columnWidths: fitted.widths };
  const message = 'A wide table was rendered as labeled rows to keep every cell readable; original row/column spans are stated in the labels.';
  makeWarning(message, model.warnings);
  const content = [{ type: 'paragraph', content: [{ type: 'text', text: message }] }];
  layout.placements.forEach((row, rowIndex) => row.forEach(({ cell, column, colspan, rowspan }) => {
    const label = `Row ${rowIndex + 1}, column ${column + 1}${colspan > 1 ? `–${column + colspan}` : ''}${rowspan > 1 ? ` (spans ${rowspan} rows)` : ''}${cell.type === 'table_header' ? ' · Header' : ''}`;
    content.push({ type: 'paragraph', content: [{ type: 'text', text: label, marks: [{type:'bold'}] }] }, ...nodeChildren(cell).map(child => ['text','hard_break'].includes(child.type) ? {type:'paragraph',content:[child]} : child));
  }));
  return { ...layout, fallback: { type: 'doc', content } };
}

function sheetTable(sheet) {
  const rows = sheet.rows || [];
  const width = Math.max(1, ...rows.map(row => row.length));
  return { type: 'table', content: rows.map((row, index) => ({ type: 'table_row', content: Array.from({length:width}, (_, column) => ({type:index === 0 ? 'table_header' : 'table_cell',content:[{type:'paragraph',content:[{type:'text',text:row[column] || ''}]}]})) })) };
}

function renderPlainBlocks(node, indent = '') {
  if (!node) return [];
  const children = nodeChildren(node);
  if (node.type === 'doc') return children.flatMap(child => renderPlainBlocks(child, indent));
  if (['paragraph', 'heading', 'blockquote', 'code_block', 'unsupported'].includes(node.type)) {
    const text = inlineText(node);
    return [indent + text];
  }
  if (node.type === 'horizontal_rule') return [indent + '---'];
  if (node.type === 'bullet_list' || node.type === 'ordered_list') {
    const lines = [];
    children.filter(child => child.type === 'list_item').forEach((item, index) => {
      const nested = renderPlainBlocks(item, indent + '  ');
      if (!nested.length) lines.push(`${indent}${node.type === 'ordered_list' ? `${index + (node.attrs?.order || 1)}.` : '-'} `);
      else {
        const marker = node.type === 'ordered_list' ? `${index + (node.attrs?.order || 1)}. ` : '- ';
        lines.push(indent + marker + nested[0].trimStart());
        lines.push(...nested.slice(1));
      }
    });
    return lines;
  }
  if (node.type === 'list_item') return children.flatMap(child => renderPlainBlocks(child, indent));
  if (node.type === 'table') return tableRows(node).map(row => indent + row.join(' | '));
  if (node.type === 'table_row' || node.type === 'table_cell' || node.type === 'table_header') return [indent + inlineText(node)];
  if (node.type === 'hard_break' || node.type === 'text') return [indent + inlineText(node)];
  return children.flatMap(child => renderPlainBlocks(child, indent));
}

function renderPlainInline(node) {
  return inlineText(node);
}

function renderEntryPlain(entry, model, lines) {
  lines.push(`[${entry.code}]`, entry.title, '');
  lines.push(...metadata(entry).map(([label, value]) => `${label}: ${value}`));
  lines.push('');
  for (const [index, section] of entry.sections.entries()) {
    lines.push(sectionLabel(section, index));
    lines.push(...renderPlainBlocks(section.document));
    if (section.id === 'data' && entry.attachments.length) {
      lines.push('Attachments:');
      for (const attachment of entry.attachments) lines.push(`- ${attachment.name}${attachment.caption ? ` — ${attachment.caption}` : ''}`);
    }
    lines.push('');
  }
}

function renderPlain(model) {
  const lines = [`LabMate · ${model.notebook.name}`, notebookContext(model), ''].filter((line, index) => line || index === 2);
  model.entries.forEach((entry, index) => {
    renderEntryPlain(entry, model, lines);
    if (index !== model.entries.length - 1) lines.push('─'.repeat(32), '');
  });
  return Buffer.from(lines.join('\n').replace(/[ \t]+\n/g, '\n').trimEnd() + '\n', 'utf8');
}

function escapeMarkdownText(value) {
  return safeText(value).replace(/([\\`*{}\[\]()#+\-.!_|>])/g, '\\$1');
}

function renderMarkdownInline(node) {
  if (!node) return '';
  if (node.type === 'hard_break') return '  \n';
  if (node.type !== 'text') return nodeChildren(node).map(renderMarkdownInline).join('');
  let text = escapeMarkdownText(node.text);
  const marks = node.marks || [];
  for (const mark of marks) {
    switch (mark.type) {
      case 'bold': text = `**${text}**`; break;
      case 'italic': text = `*${text}*`; break;
      case 'underline': text = `<u>${text}</u>`; break;
      case 'strike': text = `~~${text}~~`; break;
      case 'code': text = `\`${text.replace(/`/g, '\\`')}\``; break;
      case 'superscript': text = `<sup>${text}</sup>`; break;
      case 'subscript': text = `<sub>${text}</sub>`; break;
      case 'link': if (mark.attrs?.href) text = `[${text}](${mark.attrs.href.replace(/[()\s]/g, encodeURIComponent)})`; break;
      default: break;
    }
  }
  return text;
}

function renderMarkdownBlocks(node, depth = 0) {
  if (!node) return [];
  const children = nodeChildren(node);
  if (node.type === 'doc') return children.flatMap(child => [...renderMarkdownBlocks(child, depth), '']);
  if (node.type === 'paragraph' || node.type === 'unsupported') return [renderMarkdownInline(node)];
  if (node.type === 'blockquote') return children.flatMap(child => [...renderMarkdownBlocks(child, depth), '']).map(line => `> ${line}`);
  if (node.type === 'code_block') {
    const value = inlineText(node);
    const runs = value.match(/`+/g) || [];
    const fence = '`'.repeat(Math.max(3, ...runs.map(run => run.length + 1)));
    return [fence, ...value.split('\n'), fence];
  }
  if (node.type === 'heading') return [`${'#'.repeat(Math.min(6, (node.attrs?.level || 2) + 3))} ${renderMarkdownInline(node)}`];
  if (node.type === 'horizontal_rule') return ['---'];
  if (node.type === 'bullet_list' || node.type === 'ordered_list') {
    return children.filter(child => child.type === 'list_item').flatMap((item,index) => {
      const marker = node.type === 'ordered_list' ? `${index + (node.attrs?.order || 1)}. ` : '- ';
      const output = [];
      nodeChildren(item).forEach((child, childIndex) => {
        const lines = renderMarkdownBlocks(child, depth + 1);
        if (!childIndex) output.push(marker + (lines.shift() || ''));
        else if (!['bullet_list','ordered_list'].includes(child.type)) output.push('');
        output.push(...lines.map(line => ' '.repeat(marker.length) + line));
      });
      return output;
    });
  }
  if (node.type === 'list_item') return children.flatMap(child => renderMarkdownBlocks(child, depth));
  if (node.type === 'table') {
    const rows = tableRows(node);
    if (!rows.length) return [];
    const width = Math.max(...rows.map(row => row.length), 1);
    const normalized = rows.map(row => Array.from({length:width}, (_,index) => row[index] || ''));
    return [`| ${normalized[0].map(escapeMarkdownText).join(' | ')} |`, `| ${normalized[0].map(()=>'---').join(' | ')} |`, ...normalized.slice(1).map(row=>`| ${row.map(escapeMarkdownText).join(' | ')} |`)];
  }
  return children.flatMap(child => renderMarkdownBlocks(child, depth));
}

function markdownAttachmentLines(entry, outputStem, assets) {
  if (!entry.attachments.length) return [];
  const lines = ['#### Attachments', ''];
  entry.attachments.forEach(attachment => {
    lines.push('');
    const preview = attachment.preview;
    const mime = imageMime(preview, attachment);
    if (preview?.kind === 'image' && preview.bytes && mime) {
      const assetNumber = assets.length + 1;
      const base = sanitizeFilenameComponent(path.basename(attachment.name, path.extname(attachment.name)), `attachment-${assetNumber}`);
      const fileName = `${outputStem}-${String(assetNumber).padStart(2, '0')}-${sanitizeAssetStem(base)}${imageExtension(mime, attachment.name)}`;
      const directory = `${outputStem}_assets`;
      const relativePath = `${directory}/${fileName}`;
      assets.push({ name: fileName, directory, relativePath, bytes: Buffer.from(preview.bytes), mime });
      const relative = relativePath.replace(/([\\()\s])/g, '\\$1');
      lines.push(`- ![${escapeMarkdownText(attachment.caption || attachment.name)}](${relative}) **${escapeMarkdownText(attachment.name)}**${attachment.caption ? ` — ${escapeMarkdownText(attachment.caption)}` : ''}`);
    } else if (preview?.kind === 'spreadsheet' && preview.sheets?.length) {
      lines.push(`- **${escapeMarkdownText(attachment.name)}**${attachment.caption ? ` — ${escapeMarkdownText(attachment.caption)}` : ''}`);
      for (const sheet of preview.sheets) {
        lines.push('', `##### ${escapeMarkdownText(sheet.name)}`);
        const rows = sheet.rows || [];
        if (rows.length) {
          const width = Math.max(...rows.map(row => row.length), 1);
          const normalized = rows.map(row => Array.from({ length: width }, (_, col) => row[col] || ''));
          lines.push(`| ${normalized[0].map(cell => escapeMarkdownText(cell).replace(/\|/g, '\\|')).join(' | ')} |`);
          lines.push(`| ${normalized[0].map(() => '---').join(' | ')} |`);
          lines.push(...normalized.slice(1).map(row => `| ${row.map(cell => escapeMarkdownText(cell).replace(/\|/g, '\\|')).join(' | ')} |`));
        }
      }
    } else {
      lines.push(`- **${escapeMarkdownText(attachment.name)}**${attachment.caption ? ` — ${escapeMarkdownText(attachment.caption)}` : ''}`);
    }
  });
  return lines;
}

function renderMarkdown(model) {
  const assets = [];
  const lines = ['LabMate', '', `# ${escapeMarkdownText(model.notebook.name)}`, '', escapeMarkdownText(notebookContext(model)), ''];
  model.entries.forEach((entry, index) => {
    lines.push(escapeMarkdownText(`[${entry.code}]`), '', `## ${escapeMarkdownText(entry.title)}`, '', ...metadata(entry).map(([label,value]) => `- **${label}:** ${escapeMarkdownText(value)}`), '');
    for (const [sectionIndex, section] of entry.sections.entries()) {
      lines.push(`### ${escapeMarkdownText(sectionLabel(section, sectionIndex))}`, '', ...renderMarkdownBlocks(section.document), '');
      if (section.id === 'data') lines.push(...markdownAttachmentLines(entry, model.outputStem, assets), '');
    }
    if (index !== model.entries.length - 1) lines.push('---', '');
  });
  return { bytes: Buffer.from(lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n', 'utf8'), assets, assetsDirectory: `${model.outputStem}_assets` };
}

function renderHtmlInline(node) {
  if (!node) return '';
  if (node.type === 'hard_break') return '<br>\n';
  if (node.type !== 'text') return nodeChildren(node).map(renderHtmlInline).join('');
  let text = escapeHtml(node.text);
  for (const mark of node.marks || []) {
    switch (mark.type) {
      case 'bold': text = `<strong>${text}</strong>`; break;
      case 'italic': text = `<em>${text}</em>`; break;
      case 'underline': text = `<u>${text}</u>`; break;
      case 'strike': text = `<del>${text}</del>`; break;
      case 'code': text = `<code>${text}</code>`; break;
      case 'superscript': text = `<sup>${text}</sup>`; break;
      case 'subscript': text = `<sub>${text}</sub>`; break;
      case 'highlight': {
        const color = sanitizeHighlightColor(mark.attrs?.color);
        const title = mark.attrs?.materialRole === 'starting' ? ' title="Starting material"' : mark.attrs?.materialRole === 'product' ? ' title="Product"' : '';
        text = color ? `<mark${title} style="background-color:${escapeHtml(color)}">${text}</mark>` : `<mark${title}>${text}</mark>`;
        break;
      }
      case 'link': if (mark.attrs?.href) text = `<a href="${escapeHtml(mark.attrs.href)}">${text}</a>`; break;
      default: break;
    }
  }
  return text;
}

function htmlBlockStyle(node) {
  return node?.attrs?.align ? ` style="text-align:${node.attrs.align}"` : '';
}

function renderHtmlBlocks(node, model) {
  if (!node) return '';
  const children = nodeChildren(node);
  const blocks = items => items.map(child => renderHtmlBlocks(child, model)).join('');
  if (node.type === 'doc') {
    const body = blocks(children);
    return node.presentation === 'yield-summary' ? `<div class="yield-summary">${body}</div>` : body;
  }
  if (node.type === 'paragraph' || node.type === 'unsupported') return `<p${htmlBlockStyle(node)}>${renderHtmlInline(node)}</p>`;
  if (node.type === 'heading') {
    const level = clampInteger(node.attrs?.level, 1, 6, 2);
    const semantic = Math.min(6, level + (model.scope === 'entry' ? 2 : 3));
    return `<h${semantic} class="content-heading level-${level}"${htmlBlockStyle(node)}>${renderHtmlInline(node)}</h${semantic}>`;
  }
  if (node.type === 'blockquote') return `<blockquote>${blocks(children)}</blockquote>`;
  if (node.type === 'code_block') return `<pre><code>${escapeHtml(inlineText(node))}</code></pre>`;
  if (node.type === 'horizontal_rule') return '<hr>';
  if (node.type === 'bullet_list' || node.type === 'ordered_list') {
    const tag = node.type === 'bullet_list' ? 'ul' : 'ol';
    return `<${tag}${tag === 'ol' ? ` start="${node.attrs?.order || 1}"` : ''}>${children.filter(item => item.type === 'list_item').map(item => `<li>${blocks(nodeChildren(item))}</li>`).join('')}</${tag}>`;
  }
  if (node.type === 'list_item') return blocks(children);
  if (node.type === 'table') {
    const { placements, columnWidths, fallback } = styledTable(node, model);
    if (fallback) return `<div class="table-fallback">${renderHtmlBlocks(fallback, model)}</div>`;
    if (!placements.length) return '';
    const columns = `<colgroup>${columnWidths.map(width => `<col style="width:${width}px">`).join('')}</colgroup>`;
    const rows = placements.map(row => `<tr>${row.map(({ cell, colspan, rowspan }) => {
      const tag = cell.type === 'table_header' ? 'th' : 'td';
      const content = nodeChildren(cell).map(child => ['text', 'hard_break'].includes(child.type) ? renderHtmlInline(child) : renderHtmlBlocks(child, model)).join('');
      return `<${tag} colspan="${colspan}" rowspan="${rowspan}"${htmlBlockStyle(cell)}>${content}</${tag}>`;
    }).join('')}</tr>`);
    let headers = 0;
    while (headers < placements.length && placements[headers].length && placements[headers].every(({cell}) => cell.type === 'table_header')) headers++;
    if (placements.slice(0,headers).some((row,index) => row.some(slot => index + slot.rowspan > headers))) headers = 0;
    return `<div class="table-wrap"><table style="width:${columnWidths.reduce((a,b)=>a+b,0)}px">${columns}${headers ? `<thead>${rows.slice(0,headers).join('')}</thead>` : ''}<tbody>${rows.slice(headers).join('')}</tbody></table></div>`;
  }
  return blocks(children);
}

function htmlAttachmentMarkup(entry, model) {
  if (!entry.attachments.length) return '';
  const body = entry.attachments.map(attachment => {
    const preview = attachment.preview;
    const mime = imageMime(preview, attachment);
    const caption = `${escapeHtml(attachment.name)}${attachment.caption ? ` — ${escapeHtml(attachment.caption)}` : ''}`;
    if (preview?.kind === 'image' && preview.bytes && mime) {
      const uri = `data:${mime};base64,${Buffer.from(preview.bytes).toString('base64')}`;
      return `<figure><img src="${uri}" alt="${escapeHtml(attachment.caption || attachment.name)}"><figcaption>${caption}</figcaption></figure>`;
    }
    if (preview?.kind === 'spreadsheet' && preview.sheets?.length) {
      return `<div class="spreadsheet"><h4 class="attachment-heading">${escapeHtml(attachment.name)}</h4>${preview.sheets.map(sheet => `<p class="caption">${escapeHtml(sheet.name)}</p>${renderHtmlBlocks(sheetTable(sheet), model)}`).join('')}${attachment.caption ? `<p class="caption">${escapeHtml(attachment.caption)}</p>` : ''}</div>`;
    }
    return `<p class="attachment">${caption}</p>`;
  }).join('');
  return `<div class="attachments"><h4 class="attachment-heading">Attachments</h4>${body}</div>`;
}

function renderHtml(model) {
  const single = model.scope === 'entry';
  const entries = model.entries.map(entry => `<article class="entry"><header class="entry-header"><span class="entry-code">${escapeHtml(entry.code)}</span><h${single ? 1 : 2} class="entry-title">${escapeHtml(entry.title)}</h${single ? 1 : 2}><div class="entry-metadata">${metadata(entry).map(([label,value]) => `<span><span class="metadata-label">${label}:</span> ${escapeHtml(value)}</span>`).join('')}</div></header>${entry.sections.map((section,index) => `<section class="export-section"><h${single ? 2 : 3} class="section-title"><span class="section-number">${String(index+1).padStart(2,'0')}</span>${escapeHtml(section.title)}</h${single ? 2 : 3}><div class="prose">${renderHtmlBlocks(section.document, model)}${section.id === 'data' ? htmlAttachmentMarkup(entry, model) : ''}</div></section>`).join('')}</article>`).join('');
  return Buffer.from(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(model.notebook.name)}</title><style>${htmlStyles}</style></head><body><main class="labmate-export"><header class="export-context"><span class="wordmark">LabMate</span>${single ? escapeHtml(model.notebook.name) : `<h1 class="notebook-title">${escapeHtml(model.notebook.name)}</h1>`}${notebookContext(model) ? `<p class="notebook-context">${escapeHtml(notebookContext(model))}</p>` : ''}</header>${entries}</main></body></html>`, 'utf8');
}

function rtfEscape(value) {
  let output = '';
  for (const codePoint of Array.from(safeText(value))) {
    const code = codePoint.codePointAt(0);
    if (code === 0x0a) { output += '\\line '; continue; }
    if (code === 0x0d) continue;
    if (code === 0x5c) { output += '\\\\'; continue; }
    if (code === 0x7b) { output += '\\{'; continue; }
    if (code === 0x7d) { output += '\\}'; continue; }
    if (code >= 0x20 && code <= 0x7e) { output += String.fromCodePoint(code); continue; }
    const units = String.fromCodePoint(code).split('').map(char => char.charCodeAt(0));
    for (const unit of units) output += `\\u${unit > 32767 ? unit - 65536 : unit}?`;
  }
  return output;
}

function rtfColorValue(color) {
  const normalized = sanitizeHighlightColor(color) || '#ffff00';
  const named = {
    yellow: [255, 255, 0], red: [255, 0, 0], blue: [0, 0, 255], green: [0, 128, 0],
    cyan: [0, 255, 255], magenta: [255, 0, 255], orange: [255, 165, 0], pink: [255, 192, 203],
  };
  if (named[normalized]) return named[normalized];
  const hex = normalized.replace(/^#/, '');
  const expanded = hex.length === 3 ? hex.split('').map(char => char + char).join('') : hex.padEnd(6, '0').slice(0, 6);
  return [parseInt(expanded.slice(0, 2), 16), parseInt(expanded.slice(2, 4), 16), parseInt(expanded.slice(4, 6), 16)];
}

function collectRtfHighlightColors(model) {
  const colors = [];
  const seen = new Set();
  const visit = node => {
    if (!node) return;
    for (const mark of node.marks || []) {
      if (mark.type !== 'highlight') continue;
      const color = sanitizeHighlightColor(mark.attrs?.color) || '#ffff00';
      if (!seen.has(color)) { seen.add(color); colors.push(color); }
    }
    nodeChildren(node).forEach(visit);
  };
  for (const entry of model.entries) for (const section of entry.sections) visit(section.document);
  return colors;
}

function renderRtfInline(node, state = {}) {
  if (!node) return '';
  if (node.type === 'hard_break') return '\\line ';
  if (node.type !== 'text') return nodeChildren(node).map(child => renderRtfInline(child, state)).join('');
  let text = rtfEscape(node.text);
  const marks = node.marks || [];
  // Controls are nested in reverse order to keep the generated group valid.
  for (const mark of marks) {
    switch (mark.type) {
      case 'bold': text = `{\\b ${text}}`; break;
      case 'italic': text = `{\\i ${text}}`; break;
      case 'underline': text = `{\\ul ${text}}`; break;
      case 'strike': text = `{\\strike ${text}}`; break;
      case 'code': text = `{\\f1 ${text}}`; break;
      case 'superscript': text = `{\\super ${text}\\nosupersub}`; break;
      case 'subscript': text = `{\\sub ${text}\\nosupersub}`; break;
      case 'highlight': {
        const color = sanitizeHighlightColor(mark.attrs?.color) || '#ffff00';
        const index = state.colorIndexes?.get(color) || 1;
        text = `{\\highlight${index} ${text}}`;
        break;
      }
      case 'link': if (mark.attrs?.href) text += ` (${rtfEscape(mark.attrs.href)})`; break;
      default: break;
    }
  }
  return text;
}

function rtfAlignment(node) {
  if (node?.attrs?.align === 'center') return '\\qc ';
  if (node?.attrs?.align === 'right') return '\\qr ';
  if (node?.attrs?.align === 'left') return '\\ql ';
  return '';
}

function rtfParagraph(content, role = 'body', state = {}) {
  const sizes = { body:DESIGN.body, title:DESIGN.title, notebook:DESIGN.notebook, section:DESIGN.section, small:DESIGN.small, caption:DESIGN.small, table:DESIGN.table, code:10, heading1:15, heading2:13.5, heading3:12, heading4:11, heading5:11, heading6:11 };
  const heading = ['title','notebook','section'].includes(role) || role.startsWith('heading');
  const small = ['small','caption'].includes(role);
  const size = state.inTable ? DESIGN.table : (sizes[role] || DESIGN.body);
  const spacing = state.inTable ? '\\sa60\\sl300\\slmult1' : `\\sa${small ? 100 : 160}\\sl372\\slmult1`;
  const indent = (state.listDepth || 0) * 300 + (state.quote ? 240 : 0);
  const rule = role === 'section' ? '\\brdrt\\brdrs\\brdrw5\\brdrcf3\\brsp120' : state.quote ? '\\brdrl\\brdrs\\brdrw10\\brdrcf3\\brsp80\\cbpat4' : '';
  const badge = role === 'badge' ? '\\cbpat4' : '';
  const before = role === 'section' ? '\\sb400' : role.startsWith('heading') ? '\\sb220' : role === 'title' ? '\\sb120' : '';
  return `\\pard\\plain${state.inTable ? '\\intbl' : ''}${state.pageBreakBefore ? '\\pagebb' : ''}\\f${role === 'code' ? 1 : 0}\\fs${Math.round(size*2)}\\cf${small ? 2 : 1}${spacing}${before}\\li${indent}${state.prefix ? '\\fi-220' : ''}${heading ? '\\keepn\\b' : ''}${state.keepNext ? '\\keepn' : ''}${rule}${badge}${state.align || '\\ql'} ${state.prefix || ''}${content}\\par\n`;
}

function renderRtfBlocks(node, state = {}) {
  if (!node) return '';
  const children = nodeChildren(node);
  if (node.type === 'doc') {
    const card = node.presentation === 'yield-summary';
    const keepCard = card && inlineText(node).length < 900;
    return children.map((child,index) => renderRtfBlocks(child, {...state, quote:state.quote || card, keepNext:keepCard && index < children.length - 1})).join('');
  }
  if (node.type === 'blockquote') return children.map(child => renderRtfBlocks(child, {...state,quote:true})).join('');
  if (['paragraph','heading','unsupported'].includes(node.type)) return rtfParagraph(renderRtfInline(node,state), node.type === 'heading' ? `heading${node.attrs?.level || 2}` : state.inTable ? 'table' : 'body', {...state,align:rtfAlignment(node)});
  if (node.type === 'code_block') return rtfParagraph(rtfEscape(inlineText(node)).replace(/\n/g,'\\line '),'code',state);
  if (node.type === 'horizontal_rule') return '\\pard\\brdrb\\brdrs\\brdrw5\\brdrcf3\\sa160 \\par\n';
  if (node.type === 'bullet_list' || node.type === 'ordered_list') {
    return children.filter(item => item.type === 'list_item').map((item,index) => nodeChildren(item).map((child,childIndex) => renderRtfBlocks(child,{...state,listDepth:(state.listDepth || 0)+1,prefix:childIndex === 0 ? `${node.type === 'ordered_list' ? `${index+(node.attrs?.order || 1)}.` : '\\bullet'}\\tab ` : ''})).join('')).join('');
  }
  if (node.type === 'list_item') return children.map(child=>renderRtfBlocks(child,state)).join('');
  if (node.type === 'table') {
    const { grid, width, columnWidths, fallback } = styledTable(node,state.model);
    if (fallback) return renderRtfBlocks(fallback,state);
    let leadingHeaders = true;
    return grid.map((row,rowIndex) => {
      let boundary=0;
      const headerRow = row.length > 0 && row.every(slot=>slot?.cell.type==='table_header');
      const repeat = leadingHeaders && headerRow;
      leadingHeaders = repeat;
      const properties = Array.from({length:width},(_,column)=>{
        const slot=row[column];boundary+=Math.round(columnWidths[column]*15);
        const horizontal=slot?.colspan>1?(slot.column===column?'\\clmgf':'\\clmrg'):'';
        const vertical=slot?.rowspan>1?(slot.row===rowIndex?'\\clvmgf':'\\clvmrg'):'';
        return `${horizontal}${vertical}${['t','b','l','r'].map(side=>`\\clbrdr${side}\\brdrs\\brdrw5\\brdrcf3`).join('')}${slot?.cell.type==='table_header'?'\\clcbpat4':''}\\cellx${boundary}`;
      }).join('');
      const content=Array.from({length:width},(_,column)=>{
        const slot=row[column];let value='';
        if(slot && slot.row===rowIndex && slot.column===column) {
          const cellState={...state,inTable:true,listDepth:0,prefix:''};
          value=nodeChildren(slot.cell).map(child=>['text','hard_break'].includes(child.type)?rtfParagraph(renderRtfInline(child,state),'table',cellState):renderRtfBlocks(child,cellState)).join('').replace(/\\par\n$/,'');
          if(slot.cell.type==='table_header') value=value.replace(/(\\ql |\\qc |\\qr )/g,'$1\\b ');
        }
        return `\\pard\\intbl\\f0\\fs20 ${value}\\cell `;
      }).join('');
      const keepRow = row.every(slot => !slot || inlineText(slot.cell).length < 600);
      return `{\\trowd\\trgaph100\\trleft0${keepRow?'\\trkeep':''}${repeat?'\\trhdr':''}${properties}${content}\\row}\n`;
    }).join('')+'\\pard\\plain\\intbl0\\f0\\fs22\\sa0\\sb0\n';
  }
  return children.map(child=>renderRtfBlocks(child,state)).join('');
}

function rtfImage(attachment, state) {
  const preview=attachment.preview;
  const mime=imageMime(preview,attachment);
  if (!preview?.bytes) return '';
  const size=fitImage(preview.bytes);
  if (!['image/png','image/jpeg','image/jpg'].includes(mime) || !size) {
    makeWarning(`Attachment “${attachment.name}” could not be sized or embedded safely in RTF; its filename and caption were retained.`,state.model.warnings);
    return '';
  }
  const control=mime==='image/png'?'pngblip':'jpegblip';
  const hex=Buffer.from(preview.bytes).toString('hex').replace(/(.{128})/g,'$1\n');
  return rtfParagraph(`{\\pict\\${control}\\picwgoal${Math.round(size.width*15)}\\pichgoal${Math.round(size.height*15)}\n${hex}}`,'body',{keepNext:true});
}

function renderRtfAttachments(entry,state) {
  if (!entry.attachments.length) return '';
  let output=rtfParagraph('Attachments','heading3');
  for (const attachment of entry.attachments) {
    const preview=attachment.preview;
    if (preview?.kind==='image') output+=rtfImage(attachment,state);
    if (preview?.kind==='spreadsheet' && preview.sheets?.length) {
      output+=rtfParagraph(rtfEscape(attachment.name),'heading3');
      for (const sheet of preview.sheets) output+=rtfParagraph(rtfEscape(sheet.name),'small',{keepNext:true})+renderRtfBlocks(sheetTable(sheet),state);
      if (attachment.caption) output+=rtfParagraph(rtfEscape(attachment.caption),'caption');
    } else output+=rtfParagraph(rtfEscape(`${attachment.name}${attachment.caption?` — ${attachment.caption}`:''}`),'caption');
  }
  return output;
}

function renderRtf(model) {
  const colors=[`#${DESIGN.ink}`,`#${DESIGN.secondary}`,`#${DESIGN.line}`,`#${DESIGN.soft}`,...collectRtfHighlightColors(model)];
  const colorIndexes=new Map(colors.map((color,index)=>[color,index+1]));
  const colorTable=`{\\colortbl ;${colors.map(color=>{const [r,g,b]=rtfColorValue(color);return `\\red${r}\\green${g}\\blue${b};`;}).join('')}}`;
  const state={colors,colorIndexes,model};
  let output=`{\\rtf1\\ansi\\deff0{\\fonttbl{\\f0\\fswiss ${DESIGN.font};}{\\f1\\fmodern ${DESIGN.mono};}}${colorTable}\\viewkind4\\uc1\\paperw${twips(DESIGN.pageWidth)}\\paperh${twips(DESIGN.pageHeight)}\\margl${twips(DESIGN.margin)}\\margr${twips(DESIGN.margin)}\\margt${twips(DESIGN.margin)}\\margb${twips(DESIGN.margin)}\\widowctrl\\deftab360\n`;
  if(model.entries.length>1) output+=`{\\header ${rtfParagraph(rtfEscape(model.notebook.name),'small')}}{\\footer\\pard\\plain\\f0\\fs18\\cf2\\qr {\\field{\\*\\fldinst PAGE}{\\fldrslt 1}}\\par}\n`;
  output+=rtfParagraph(model.scope==='entry'?`{\\b LabMate}   ${rtfEscape(model.notebook.name)}`:'{\\b LabMate}','small',{keepNext:true});
  if(model.scope!=='entry') output+=rtfParagraph(rtfEscape(model.notebook.name),'notebook');
  if(notebookContext(model)) output+=rtfParagraph(rtfEscape(notebookContext(model)),'small',{keepNext:true});
  model.entries.forEach((entry,index)=>{
    output+=rtfParagraph(`{\\highlight4 ${rtfEscape(entry.code)}}`,'small',{keepNext:true,pageBreakBefore:index>0});
    output+=rtfParagraph(rtfEscape(entry.title),'title');
    output+=rtfParagraph(metadata(entry).map(([label,value])=>`${label}: ${rtfEscape(value)}`).join('    '),'small');
    entry.sections.forEach((section,sectionIndex)=>{
      output+=rtfParagraph(rtfEscape(sectionLabel(section,sectionIndex)),'section')+renderRtfBlocks(section.document,state);
      if(section.id==='data') output+=renderRtfAttachments(entry,state);
    });
  });
  return Buffer.from(output+'}','utf8');
}

function docxMarkOptions(marks) {
  const options = {};
  for (const mark of marks || []) {
    if (mark.type === 'bold') options.bold = true;
    else if (mark.type === 'italic') options.italics = true;
    else if (mark.type === 'underline') options.underline = { type: docx.UnderlineType?.SINGLE || 'single' };
    else if (mark.type === 'strike') options.strike = true;
    else if (mark.type === 'code') options.font = DESIGN.mono;
    else if (mark.type === 'superscript') options.superScript = true;
    else if (mark.type === 'subscript') options.subScript = true;
    else if (mark.type === 'highlight') {
      const color = sanitizeHighlightColor(mark.attrs?.color);
      const named = { black: 'black', blue: 'blue', cyan: 'cyan', green: 'green', magenta: 'magenta', red: 'red', yellow: 'yellow', white: 'white' };
      if (color && named[color]) options.highlight = named[color];
      else if (color && /^#[0-9a-f]{6}$/i.test(color)) options.shading = { fill: color.slice(1).toUpperCase() };
      else options.highlight = 'yellow';
    }
  }
  return options;
}

function docxInlineChildren(node, model, extraMarks = []) {
  if (!node) return [];
  if (node.type === 'hard_break') return [new docx.TextRun({ break: 1 })];
  if (node.type === 'text') {
    const marks = [...(node.marks || []), ...extraMarks];
    const link = marks.find(mark => mark.type === 'link' && mark.attrs?.href);
    const run = new docx.TextRun({ text: safeText(node.text), ...docxMarkOptions(marks) });
    return link ? [new docx.ExternalHyperlink({ link: link.attrs.href, children: [run] })] : [run];
  }
  return nodeChildren(node).flatMap(child => docxInlineChildren(child, model, extraMarks));
}

function docxParagraphNode(node, model, options = {}) {
  const children = docxInlineChildren(node, model);
  return new docx.Paragraph({ children: children.length ? children : [new docx.TextRun('')], ...options });
}

function docxAlignment(node) {
  if (node?.attrs?.align === 'center') return docx.AlignmentType?.CENTER || 'center';
  if (node?.attrs?.align === 'right') return docx.AlignmentType?.RIGHT || 'right';
  if (node?.attrs?.align === 'left') return docx.AlignmentType?.LEFT || 'left';
  return undefined;
}

function docxTableNode(node, model) {
  const { placements, columnWidths, fallback } = styledTable(node,model);
  if (fallback) return docxBlockNodes(fallback,model);
  if (!placements.length) return null;
  const widths=columnWidths.map(width=>Math.round(width*15));
  const headerMarks=node=>({...node,...(node.type==='text'?{marks:[...(node.marks||[]),{type:'bold'}]}:{}),...(node.content?{content:node.content.map(headerMarks)}:{})});
  const border={style:docx.BorderStyle.SINGLE,size:4,color:DESIGN.line};
  let leadingHeaders=true;
  return new docx.Table({
    rows:placements.map(row=>{
      const header=row.length>0 && row.every(({cell})=>cell.type==='table_header');
      const repeat=leadingHeaders && header;leadingHeaders=repeat;
      return new docx.TableRow({tableHeader:repeat,children:row.map(({cell,column,colspan,rowspan})=>{
        const content=cell.type==='table_header'?headerMarks(cell):cell;
        const blocks=nodeChildren(content).flatMap(child=>['text','hard_break'].includes(child.type)?[docxParagraphNode({content:[child]},model,{style:'LabMateTable'})]:docxBlockNodes(child,model,{style:'LabMateTable'}));
        return new docx.TableCell({columnSpan:colspan,rowSpan:rowspan,
          width:{size:widths.slice(column,column+colspan).reduce((a,b)=>a+b,0),type:docx.WidthType.DXA},
          margins:{top:100,bottom:100,left:130,right:130},
          ...(cell.type==='table_header'?{shading:{fill:DESIGN.soft}}:{}),
          children:blocks.length?blocks:[new docx.Paragraph({text:'',style:'LabMateTable'})],
        });
      })});
    }),
    borders:{top:border,bottom:border,left:border,right:border,insideHorizontal:border,insideVertical:border},
    columnWidths:widths,layout:docx.TableLayoutType.FIXED,
    width:{size:widths.reduce((a,b)=>a+b,0),type:docx.WidthType.DXA},
  });
}

function docxBlockNodes(node, model, state = {}) {
  if (!node) return [];
  const children=nodeChildren(node);
  if(node.type==='doc') return children.flatMap((child,index)=>{
    const blocks=docxBlockNodes(child,model,node.presentation==='yield-summary'?{...state,style:'LabMateYield',keepNext:inlineText(node).length<900 && index<children.length-1}:state);
    return blocks;
  });
  if(node.type==='blockquote') return children.flatMap(child=>docxBlockNodes(child,model,{...state,style:'LabMateQuote'}));
  if(node.type==='paragraph'||node.type==='unsupported') return [docxParagraphNode(node,model,{style:state.style||'Normal',keepNext:state.keepNext,...(docxAlignment(node)?{alignment:docxAlignment(node)}:{})})];
  if(node.type==='heading') return [docxParagraphNode(node,model,{style:`LabMateBodyH${clampInteger(node.attrs?.level,1,6,2)}`,...(docxAlignment(node)?{alignment:docxAlignment(node)}:{})})];
  if(node.type==='code_block') return [new docx.Paragraph({style:'LabMateCode',children:inlineText(node).split('\n').flatMap((line,index)=>[...(index?[new docx.TextRun({break:1})]:[]),new docx.TextRun({text:line,font:DESIGN.mono})])})];
  if(node.type==='horizontal_rule') return [new docx.Paragraph({border:{bottom:{style:docx.BorderStyle.SINGLE,color:DESIGN.line,size:4}},spacing:{after:160}})];
  if(node.type==='bullet_list'||node.type==='ordered_list') {
    const depth=Math.min(state.depth||0,8);
    const reference=`labmate-list-${model.numbering.length}`;
    const numbered=node.type==='ordered_list';
    model.numbering.push({reference,levels:Array.from({length:9},(_,level)=>({level,format:numbered?docx.LevelFormat.DECIMAL:docx.LevelFormat.BULLET,text:numbered?`%${level+1}.`:'•',start:node.attrs?.order||1,alignment:docx.AlignmentType.LEFT,style:{paragraph:{indent:{left:360*(level+1),hanging:240}},run:{font:DESIGN.font,color:DESIGN.ink,size:22}}}))});
    return children.filter(child=>child.type==='list_item').flatMap(item=>{
      const output=[];let first=true;
      for(const child of nodeChildren(item)) {
        if(['bullet_list','ordered_list'].includes(child.type)) output.push(...docxBlockNodes(child,model,{...state,depth:depth+1}));
        else if(first && ['paragraph','heading'].includes(child.type)) {output.push(docxParagraphNode(child,model,{style:state.style||'Normal',numbering:{reference,level:depth}}));first=false;}
        else output.push(...docxBlockNodes(child,model,state));
      }
      return output;
    });
  }
  if(node.type==='table') {
    const table=docxTableNode(node,model);
    return table?(Array.isArray(table)?table:[table]):[];
  }
  return children.flatMap(child=>docxBlockNodes(child,model,state));
}

function docxImageNode(attachment, model) {
  const preview=attachment.preview;
  const mime=imageMime(preview,attachment);
  const type=({'image/png':'png','image/jpeg':'jpg','image/jpg':'jpg','image/gif':'gif','image/bmp':'bmp'})[mime];
  const size=fitImage(preview?.bytes);
  if(!preview?.bytes||!type||!size) {
    if(preview?.bytes) makeWarning(`Attachment “${attachment.name}” could not be sized or embedded safely in DOCX; its filename and caption were retained.`,model.warnings);
    return null;
  }
  return new docx.ImageRun({type,data:Buffer.from(preview.bytes),transformation:size,altText:{title:attachment.name,description:attachment.caption||attachment.name,name:attachment.name}});
}

function docxAttachmentNodes(entry, model) {
  if(!entry.attachments.length) return [];
  const output=[new docx.Paragraph({text:'Attachments',style:'LabMateBodyH3'})];
  for(const attachment of entry.attachments) {
    const image=attachment.preview?.kind==='image'?docxImageNode(attachment,model):null;
    if(image) output.push(new docx.Paragraph({children:[image],keepNext:true,spacing:{before:160,after:100}}));
    else if(attachment.preview?.kind==='spreadsheet'&&attachment.preview.sheets?.length) {
      output.push(new docx.Paragraph({text:attachment.name,style:'LabMateBodyH3'}));
      for(const sheet of attachment.preview.sheets) {
        output.push(new docx.Paragraph({text:sheet.name,style:'LabMateCaption',keepNext:true}));
        output.push(...docxBlockNodes(sheetTable(sheet),model));
      }
      if(attachment.caption) output.push(new docx.Paragraph({text:attachment.caption,style:'LabMateCaption'}));
      continue;
    }
    output.push(new docx.Paragraph({text:`${attachment.name}${attachment.caption?` — ${attachment.caption}`:''}`,style:'LabMateCaption'}));
  }
  return output;
}

function docxStyles(single) {
  const run={font:DESIGN.font,size:DESIGN.body*2,color:DESIGN.ink};
  const paragraph={spacing:{after:160,line:372},widowControl:true};
  const style=(id,name,size,extraRun={},extraParagraph={})=>({id,name,basedOn:'Normal',next:'Normal',quickFormat:true,run:{...run,size:size*2,...extraRun},paragraph:{...paragraph,...extraParagraph}});
  const rule={style:docx.BorderStyle.SINGLE,color:DESIGN.line,size:4,space:12};
  const inset={indent:{left:240,right:160},border:{left:{...rule,size:8}},shading:{fill:DESIGN.soft},spacing:{before:100,after:100,line:350}};
  return {
    default:{document:{run,paragraph},title:{run,paragraph},heading1:{run,paragraph},heading2:{run,paragraph},heading3:{run,paragraph},heading4:{run,paragraph},heading5:{run,paragraph},heading6:{run,paragraph},hyperlink:{run:{color:DESIGN.ink,underline:{type:docx.UnderlineType.SINGLE}}}},
    paragraphStyles:[
      style('LabMateNotebook','LabMate Notebook',DESIGN.notebook,{bold:true},{keepNext:true,outlineLevel:0,spacing:{before:100,after:120}}),
      style('LabMateEntry','LabMate Experiment',DESIGN.title,{bold:true},{keepNext:true,outlineLevel:single?0:1,spacing:{before:140,after:160,line:300}}),
      style('LabMateSection','LabMate Section',DESIGN.section,{bold:true},{keepNext:true,outlineLevel:single?1:2,spacing:{before:400,after:240},border:{top:rule}}),
      style('LabMateMetadata','LabMate Metadata',DESIGN.small,{color:DESIGN.secondary},{spacing:{after:100,line:300}}),
      style('LabMateCaption','LabMate Caption',DESIGN.small,{color:DESIGN.secondary},{spacing:{before:100,after:160,line:300}}),
      style('LabMateTable','LabMate Table',DESIGN.table,{}, {spacing:{after:60,line:300}}),
      style('LabMateCode','LabMate Code',10,{font:DESIGN.mono},{...inset}),
      style('LabMateQuote','LabMate Quote',DESIGN.body,{},inset),
      style('LabMateYield','LabMate Yield',DESIGN.body,{},inset),
      ...[15,13.5,12,11,11,11].map((size,index)=>style(`LabMateBodyH${index+1}`,`LabMate Content Heading ${index+1}`,size,{bold:true},{keepNext:true,outlineLevel:Math.min(8,index+(single?2:3)),spacing:{before:240,after:120,line:300}})),
    ],
    characterStyles:[{id:'LabMateBadge',name:'LabMate Entry Code',run:{...run,size:18,color:DESIGN.secondary,shading:{fill:DESIGN.soft},border:{style:docx.BorderStyle.SINGLE,color:DESIGN.line,size:4,space:3}}}],
  };
}

async function renderDocx(model) {
  if(!docx) throw new ExportError('UNAVAILABLE','The DOCX writer dependency is unavailable');
  // Writer-local numbering state is never attached to the shared resolved model.
  const context={...model,numbering:[]};
  const single=model.scope==='entry';
  const children=[new docx.Paragraph({style:'LabMateMetadata',keepNext:true,children:[new docx.TextRun({text:'LabMate',bold:true}),...(single?[new docx.TextRun(`   ${model.notebook.name}`)]:[])]})];
  if(!single) children.push(new docx.Paragraph({text:model.notebook.name,style:'LabMateNotebook'}));
  if(notebookContext(model)) children.push(new docx.Paragraph({text:notebookContext(model),style:'LabMateMetadata',keepNext:true}));
  model.entries.forEach((entry,index)=>{
    children.push(new docx.Paragraph({style:'LabMateMetadata',keepNext:true,pageBreakBefore:index>0,children:[new docx.TextRun({text:entry.code,style:'LabMateBadge'})]}));
    children.push(new docx.Paragraph({text:entry.title,style:'LabMateEntry'}));
    children.push(new docx.Paragraph({text:metadata(entry).map(([label,value])=>`${label}: ${value}`).join('    '),style:'LabMateMetadata'}));
    entry.sections.forEach((section,sectionIndex)=>{
      children.push(new docx.Paragraph({text:sectionLabel(section,sectionIndex),style:'LabMateSection'}));
      children.push(...docxBlockNodes(section.document,context));
      if(section.id==='data') children.push(...docxAttachmentNodes(entry,context));
    });
  });
  const multiple=model.entries.length>1;
  const document=new docx.Document({creator:'LabMate',title:model.notebook.name,background:{color:'FFFFFF'},styles:docxStyles(single),numbering:{config:context.numbering},sections:[{
    properties:{page:{size:{width:twips(DESIGN.pageWidth),height:twips(DESIGN.pageHeight)},margin:{top:twips(DESIGN.margin),bottom:twips(DESIGN.margin),left:twips(DESIGN.margin),right:twips(DESIGN.margin),header:540,footer:540}}},
    ...(multiple?{headers:{default:new docx.Header({children:[new docx.Paragraph({text:model.notebook.name,style:'LabMateMetadata'})]})},footers:{default:new docx.Footer({children:[new docx.Paragraph({style:'LabMateMetadata',alignment:docx.AlignmentType.RIGHT,children:[new docx.TextRun({children:[docx.PageNumber.CURRENT]})]})]})}}:{}),children,
  }]});
  // Explicit family and alternate names keep readers without these faces
  // in the sans-serif/monospace families. No font files are embedded.
  const fonts = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:fonts xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:font w:name="Arial"><w:altName w:val="Liberation Sans"/><w:family w:val="swiss"/><w:pitch w:val="variable"/></w:font><w:font w:name="Courier New"><w:altName w:val="Liberation Mono"/><w:family w:val="modern"/><w:pitch w:val="fixed"/></w:font></w:fonts>`;
  return {bytes:await docx.Packer.toBuffer(document, false, [{path:'word/fontTable.xml',data:fonts}]),assets:[],assetsDirectory:null};
}

async function renderExportDocument(model) {
  requireObject(model, 'Export document');
  switch (model.format) {
    case 'txt': return { bytes: renderPlain(model), assets: [], assetsDirectory: null };
    case 'md': return renderMarkdown(model);
    case 'html': return { bytes: renderHtml(model), assets: [], assetsDirectory: null };
    case 'rtf': return { bytes: renderRtf(model), assets: [], assetsDirectory: null };
    case 'docx': return renderDocx(model);
    default: throw new ExportError('VALIDATION', `Unsupported export format: ${safeText(model.format)}`);
  }
}

function normalizeDestination(destination) {
  if (typeof destination !== 'string' || !destination.trim()) throw new ExportError('VALIDATION', 'Export destination is required');
  if (!path.isAbsolute(destination)) throw new ExportError('VALIDATION', 'Export destination must be an absolute path');
  const resolved = path.resolve(destination);
  if (resolved === path.parse(resolved).root) throw new ExportError('VALIDATION', 'Export destination must name a file');
  return resolved;
}

async function commitStagedFiles(stagingDir, destination, mainName, assets, assetsDirectory, context, request) {
  const destinationDir = path.dirname(destination);
  const targets = [{ staged: path.join(stagingDir, mainName), destination }];
  if (assetsDirectory) {
    const safeDirectory = sanitizeFilenameComponent(assetsDirectory, 'labmate-export_assets');
    if (safeDirectory !== assetsDirectory || assetsDirectory.includes('/') || assetsDirectory.includes('\\') || assetsDirectory === '.' || assetsDirectory === '..') {
      throw new ExportError('VALIDATION', 'Generated companion asset directory was unsafe');
    }
    targets.unshift({ staged: path.join(stagingDir, assetsDirectory), destination: path.join(destinationDir, assetsDirectory), directory: true });
  }
  for (const asset of assets) {
    if (!asset || typeof asset.name !== 'string' || !/^[a-zA-Z0-9._ -]+$/.test(asset.name) || asset.name.includes('..')) {
      throw new ExportError('VALIDATION', 'Generated companion asset name was unsafe');
    }
    if (assetsDirectory && asset.relativePath !== `${assetsDirectory}/${asset.name}`) {
      throw new ExportError('VALIDATION', 'Generated companion asset path was unsafe');
    }
  }

  // The save dialog has already obtained overwrite confirmation. Move any
  // selected destination aside, then promote the complete staged set with
  // rename (atomic per path). If a later promotion fails, restore every
  // original path before returning the error.
  const backupDir = await fsp.mkdtemp(path.join(destinationDir, '.labmate-export-backup-'));
  const backups = [];
  const promoted = [];
  let preserveBackup = false;
  try {
    for (let index = 0; index < targets.length; index += 1) {
      checkCancelled(context);
      let stat;
      try { stat = await fsp.lstat(targets[index].destination); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (stat) {
        if (targets[index].directory) throw new ExportError('IO', 'The new companion directory already exists; choose another export filename.');
        const backupPath = path.join(backupDir, `${String(index).padStart(3, '0')}-${sanitizeFilenameComponent(path.basename(targets[index].destination), 'previous')}`);
        await fsp.rename(targets[index].destination, backupPath);
        backups.push({ original: targets[index].destination, backup: backupPath });
      }
    }
    for (const target of targets) {
      checkCancelled(context);
      await fsp.rename(target.staged, target.destination);
      promoted.push(target);
    }
  } catch (error) {
    // Remove promoted outputs first so restoring a previous output cannot be
    // shadowed by a partially committed replacement.
    for (const target of promoted.reverse()) {
      await fsp.rm(target.destination, { recursive: Boolean(target.directory), force: true }).catch(() => undefined);
    }
    for (const backup of backups.reverse()) {
      await fsp.rename(backup.backup, backup.original).catch(() => { preserveBackup = true; });
    }
    throw error;
  } finally {
    if (!preserveBackup) await fsp.rm(backupDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function writeExport(store, fileService, input, context = {}) {
  const request = normalizeRequest(input);
  const destination = normalizeDestination(request.destination);
  const destinationName = path.basename(destination);
  const destinationDir = path.dirname(destination);
  let stagingDir;
  try {
    checkCancelled(context);
    await fsp.access(destinationDir, fs.constants.W_OK);
    const model = await resolveExportDocument(store, fileService, request, context);
    checkCancelled(context);
    reportProgress(context, request, 'render', 0, 1, `Writing ${request.format.toUpperCase()} output`);
    if (request.format === 'md') model.outputStem += '-' + randomUUID();
    const rendered = await renderExportDocument(model);
    stagingDir = await fsp.mkdtemp(path.join(destinationDir, '.labmate-export-'));
    await fsp.writeFile(path.join(stagingDir, destinationName), rendered.bytes, { mode: 0o600, flag: 'wx' });
    if (rendered.assetsDirectory) await fsp.mkdir(path.join(stagingDir, rendered.assetsDirectory), { mode: 0o700 });
    for (const asset of rendered.assets || []) {
      if (!/^[a-zA-Z0-9._ -]+$/.test(asset.name) || asset.name.includes('..')) throw new ExportError('VALIDATION', 'Generated companion asset name was unsafe');
      if (!rendered.assetsDirectory || asset.relativePath !== `${rendered.assetsDirectory}/${asset.name}`) throw new ExportError('VALIDATION', 'Generated companion asset path was unsafe');
      await fsp.writeFile(path.join(stagingDir, asset.relativePath), asset.bytes, { mode: 0o600, flag: 'wx' });
    }
    reportProgress(context, request, 'commit', 0, 1, 'Committing export');
    await commitStagedFiles(stagingDir, destination, destinationName, rendered.assets || [], rendered.assetsDirectory || null, context, request);
    context.markCommitted?.();
    reportProgress(context, request, 'complete', 1, 1, destinationName);
    return { cancelled: false, name: destinationName, warnings: model.warnings };
  } catch (error) {
    const normalized = asExportError(error);
    if (normalized.code === 'CANCELLED') return { cancelled: true, warnings: [] };
    throw normalized;
  } finally {
    if (stagingDir) await fsp.rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

function createExportService(store, fileService) {
  if (!store) throw new ExportError('UNAVAILABLE', 'Library store is unavailable');
  return {
    resolve: (request, context = {}) => resolveExportDocument(store, fileService, request, context),
    render: renderExportDocument,
    write: (request, context = {}) => writeExport(store, fileService, request, context),
  };
}

module.exports = {
  ExportError,
  createExportService,
  resolveExportDocument,
  renderExportDocument,
  // Exported for focused backend tests and worker diagnostics.
  normalizeRequest,
  formatLossMetadata,
  MAX_TOTAL_PREVIEW_BYTES,
  MAX_TOTAL_SHEET_CELLS,
};
