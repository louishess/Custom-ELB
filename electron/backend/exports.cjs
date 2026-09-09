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
const { yieldSummary } = require('../../shared/yield.cjs');

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
const ORDER_VALUES = new Set(['newest', 'oldest', 'az', 'za', 'number-asc', 'number-desc', 'scheme']);
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
  if (rawType === 'yieldCalculation') return { type: 'doc', content: yieldSummary(node.attrs).map(text => ({ type: 'paragraph', content: [{ type: 'text', text: safeText(text) }] })) };
  const knownTypes = new Set([
    'doc', 'paragraph', 'heading', 'blockquote', 'bullet_list', 'ordered_list', 'list_item',
    'code_block', 'horizontal_rule', 'table', 'table_row', 'table_cell', 'table_header',
    'text', 'hard_break', 'image', 'attachment', 'unsupported',
  ]);
  const canonicalType = NODE_TYPE_ALIASES[rawType] || rawType;
  const type = knownTypes.has(canonicalType) ? canonicalType : 'unsupported';
  if (type === 'unsupported') state.losses.add(`Unsupported rich-text node “${rawType || 'unknown'}” was flattened.`);
  const normalized = { type };

  if (node.text !== undefined) normalized.text = safeText(node.text);
  const attrs = {};
  if (type === 'heading') attrs.level = clampInteger(node.attrs?.level, 1, 6, 2);
  if (type === 'ordered_list') attrs.order = clampInteger(node.attrs?.order, 1, 999999, 1);
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
      const allowed = new Set(['bold', 'italic', 'underline', 'strike', 'code', 'superscript', 'subscript', 'link', 'highlight']);
      if (!allowed.has(markType)) {
        state.losses.add(`Unsupported text mark “${markType || 'unknown'}” was flattened.`);
        return null;
      }
      const markOut = { type: markType };
      if (markType === 'link') {
        const href = sanitizeHref(mark?.attrs?.href);
        if (href) markOut.attrs = { href };
        else {
          state.losses.add('Unsafe links were emitted as plain text.');
          return null;
        }
      }
      if (markType === 'highlight') {
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
  let comparator;
  switch (order) {
    case 'newest': comparator = (a, b) => -dateCompare(a, b); break;
    case 'oldest': comparator = dateCompare; break;
    case 'az': comparator = (a, b) => safeText(a.title).localeCompare(safeText(b.title), 'en', { sensitivity: 'base' }); break;
    case 'za': comparator = (a, b) => -safeText(a.title).localeCompare(safeText(b.title), 'en', { sensitivity: 'base' }); break;
    case 'number-asc': comparator = (a, b) => Number(a.experimentNumber) - Number(b.experimentNumber) || Number(a.runNumber) - Number(b.runNumber); break;
    case 'number-desc': comparator = (a, b) => Number(b.experimentNumber) - Number(a.experimentNumber) || Number(b.runNumber) - Number(a.runNumber); break;
    default: comparator = () => 0;
  }
  return [...runs].sort((a, b) => stableCompare(a, b, comparator));
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

  const activeRuns = runs.filter(item => item && item.notebookId === request.notebookId && !item.trashedAt);
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
      if (!nested.length) lines.push(`${indent}${node.type === 'ordered_list' ? `${index + 1}.` : '-'} `);
      else {
        const marker = node.type === 'ordered_list' ? `${index + 1}. ` : '- ';
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
  lines.push(`${entry.code} — ${entry.title}`);
  lines.push(`Date: ${entry.date}`);
  lines.push(`Author: ${entry.author}`);
  lines.push(`Experiment: ${entry.experiment.label}`);
  lines.push('');
  for (const section of entry.sections) {
    lines.push(section.title.toUpperCase());
    lines.push(...renderPlainBlocks(section.document));
    if (section.id === 'data' && entry.attachments.length) {
      lines.push('Attachments:');
      for (const attachment of entry.attachments) lines.push(`- ${attachment.name}${attachment.caption ? ` — ${attachment.caption}` : ''}`);
    }
    lines.push('');
  }
}

function renderPlain(model) {
  const lines = [model.notebook.name, model.notebook.discipline, ''];
  model.entries.forEach((entry, index) => {
    renderEntryPlain(entry, model, lines);
    if (index !== model.entries.length - 1) lines.push('='.repeat(72), '');
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
  if (node.type === 'doc') return children.flatMap(child => renderMarkdownBlocks(child, depth));
  if (node.type === 'paragraph' || node.type === 'blockquote' || node.type === 'code_block' || node.type === 'unsupported') {
    const text = node.type === 'code_block' ? `    ${inlineText(node).replace(/\n/g, '\n    ')}` : node.type === 'blockquote' ? `> ${renderMarkdownInline(node)}` : renderMarkdownInline(node);
    return [text];
  }
  if (node.type === 'heading') {
    const level = clampInteger(node.attrs?.level, 1, 6, 2);
    return [`${'#'.repeat(level)} ${renderMarkdownInline(node)}`];
  }
  if (node.type === 'horizontal_rule') return ['---'];
  if (node.type === 'bullet_list' || node.type === 'ordered_list') {
    const rows = [];
    children.filter(child => child.type === 'list_item').forEach((item, index) => {
      const nested = renderMarkdownBlocks(item, depth + 1);
      if (!nested.length) nested.push('');
      const marker = node.type === 'ordered_list' ? `${index + 1}. ` : '- ';
      rows.push('  '.repeat(depth) + marker + nested[0]);
      rows.push(...nested.slice(1).map(line => '  '.repeat(depth + 1) + line));
    });
    return rows;
  }
  if (node.type === 'list_item') return children.flatMap(child => renderMarkdownBlocks(child, depth));
  if (node.type === 'table') {
    const rows = tableRows(node);
    if (!rows.length) return [];
    const width = Math.max(...rows.map(row => row.length), 1);
    const normalized = rows.map(row => Array.from({ length: width }, (_, index) => row[index] || ''));
    return [
      `| ${normalized[0].map(cell => escapeMarkdownText(cell).replace(/\|/g, '\\|')).join(' | ')} |`,
      `| ${normalized[0].map(() => '---').join(' | ')} |`,
      ...normalized.slice(1).map(row => `| ${row.map(cell => escapeMarkdownText(cell).replace(/\|/g, '\\|')).join(' | ')} |`),
    ];
  }
  return children.flatMap(child => renderMarkdownBlocks(child, depth));
}

function markdownAttachmentLines(entry, outputStem, assets) {
  if (!entry.attachments.length) return [];
  const lines = ['### Attachments', ''];
  entry.attachments.forEach(attachment => {
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
        lines.push('', `#### ${escapeMarkdownText(sheet.name)}`);
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
  const lines = [`# ${escapeMarkdownText(model.notebook.name)}`, '', `_${escapeMarkdownText(model.notebook.discipline)}_`, ''];
  model.entries.forEach((entry, index) => {
    lines.push(`## ${escapeMarkdownText(entry.code)} — ${escapeMarkdownText(entry.title)}`, '', `- **Date:** ${escapeMarkdownText(entry.date)}`, `- **Author:** ${escapeMarkdownText(entry.author)}`, `- **Experiment:** ${escapeMarkdownText(entry.experiment.label)}`, '');
    for (const section of entry.sections) {
      lines.push(`### ${escapeMarkdownText(section.title)}`, '', ...renderMarkdownBlocks(section.document), '');
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
        text = color ? `<mark style="background-color:${escapeHtml(color)}">${text}</mark>` : `<mark>${text}</mark>`;
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

function renderHtmlBlocks(node) {
  if (!node) return '';
  const children = nodeChildren(node);
  if (node.type === 'doc') return children.map(renderHtmlBlocks).join('');
  if (node.type === 'paragraph' || node.type === 'unsupported') return `<p${htmlBlockStyle(node)}>${renderHtmlInline(node)}</p>`;
  if (node.type === 'heading') {
    const level = clampInteger(node.attrs?.level, 1, 6, 2);
    return `<h${level}${htmlBlockStyle(node)}>${renderHtmlInline(node)}</h${level}>`;
  }
  if (node.type === 'blockquote') return `<blockquote>${children.map(renderHtmlBlocks).join('')}</blockquote>`;
  if (node.type === 'code_block') return `<pre><code>${escapeHtml(inlineText(node))}</code></pre>`;
  if (node.type === 'horizontal_rule') return '<hr>';
  if (node.type === 'bullet_list' || node.type === 'ordered_list') {
    const tag = node.type === 'bullet_list' ? 'ul' : 'ol';
    return `<${tag}>${children.filter(item => item.type === 'list_item').map(item => `<li>${nodeChildren(item).map(renderHtmlBlocks).join('')}</li>`).join('')}</${tag}>`;
  }
  if (node.type === 'list_item') return children.map(renderHtmlBlocks).join('');
  if (node.type === 'table') {
    const { placements, columnWidths } = tableLayout(node);
    if (!placements.length) return '';
    const columns = `<colgroup>${columnWidths.map(width => width ? `<col style="width:${width}px">` : '<col>').join('')}</colgroup>`;
    return `<table>${columns}<tbody>${placements.map(row => `<tr>${row.map(({ cell, colspan, rowspan }) => {
      const tag = cell.type === 'table_header' ? 'th' : 'td';
      const content = nodeChildren(cell).map(child => ['text', 'hard_break'].includes(child.type) ? renderHtmlInline(child) : renderHtmlBlocks(child)).join('');
      return `<${tag} colspan="${colspan}" rowspan="${rowspan}"${htmlBlockStyle(cell)}>${content}</${tag}>`;
    }).join('')}</tr>`).join('')}</tbody></table>`;
  }
  return children.map(renderHtmlBlocks).join('');
}

function htmlAttachmentMarkup(entry) {
  if (!entry.attachments.length) return '';
  const body = entry.attachments.map(attachment => {
    const preview = attachment.preview;
    const mime = imageMime(preview, attachment);
    if (preview?.kind === 'image' && preview.bytes && mime) {
      const uri = `data:${mime};base64,${Buffer.from(preview.bytes).toString('base64')}`;
      return `<figure><img src="${uri}" alt="${escapeHtml(attachment.caption || attachment.name)}"><figcaption>${escapeHtml(attachment.name)}${attachment.caption ? ` — ${escapeHtml(attachment.caption)}` : ''}</figcaption></figure>`;
    }
    if (preview?.kind === 'spreadsheet' && preview.sheets?.length) {
      return `<section class="spreadsheet"><h4>${escapeHtml(attachment.name)}</h4>${preview.sheets.map(sheet => {
        const rows = sheet.rows || [];
        const width = Math.max(...rows.map(row => row.length), 1);
        return `<h5>${escapeHtml(sheet.name)}</h5><table><tbody>${rows.map((row, rowIndex) => `<tr>${Array.from({ length: width }, (_, index) => `<${rowIndex === 0 ? 'th' : 'td'}>${escapeHtml(row[index] || '')}</${rowIndex === 0 ? 'th' : 'td'}>`).join('')}</tr>`).join('')}</tbody></table>`;
      }).join('')}${attachment.caption ? `<p class="caption">${escapeHtml(attachment.caption)}</p>` : ''}</section>`;
    }
    return `<p class="attachment"><strong>${escapeHtml(attachment.name)}</strong>${attachment.caption ? ` — ${escapeHtml(attachment.caption)}` : ''}</p>`;
  }).join('');
  return `<section class="attachments"><h3>Attachments</h3>${body}</section>`;
}

function renderHtml(model) {
  const entries = model.entries.map(entry => `<article><h2>${escapeHtml(entry.code)} — ${escapeHtml(entry.title)}</h2><dl><dt>Date</dt><dd>${escapeHtml(entry.date)}</dd><dt>Author</dt><dd>${escapeHtml(entry.author)}</dd><dt>Experiment</dt><dd>${escapeHtml(entry.experiment.label)}</dd></dl>${entry.sections.map(section => `<section><h3>${escapeHtml(section.title)}</h3>${renderHtmlBlocks(section.document)}${section.id === 'data' ? htmlAttachmentMarkup(entry) : ''}</section>`).join('')}</article>`).join('<hr>');
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(model.notebook.name)}</title><style>body{font:16px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#20252a;max-width:900px;margin:3rem auto;padding:0 2rem}h1,h2,h3{line-height:1.2}article{margin:2.5rem 0}table{border-collapse:collapse;margin:1rem 0;max-width:100%;overflow:auto}th,td{border:1px solid #aeb5bb;padding:.35rem .55rem;text-align:left;vertical-align:top}figure{margin:1rem 0}img{max-width:100%;height:auto}figcaption,.caption{color:#59636c;font-size:.9rem}.attachments{margin-top:1rem}dt{font-weight:600;float:left;clear:left;width:6rem}dd{margin-left:6.5rem}</style></head><body><header><h1>${escapeHtml(model.notebook.name)}</h1><p>${escapeHtml(model.notebook.discipline)}</p></header>${entries}</body></html>`;
  return Buffer.from(html, 'utf8');
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

function renderRtfBlocks(node, state = {}) {
  if (!node) return '';
  const children = nodeChildren(node);
  if (node.type === 'doc') return children.map(child => renderRtfBlocks(child, state)).join('');
  if (node.type === 'paragraph' || node.type === 'heading' || node.type === 'blockquote' || node.type === 'unsupported') return `${rtfAlignment(node)}${renderRtfInline(node, state)}\\par\n`;
  if (node.type === 'code_block') return `{\\f1 ${rtfEscape(inlineText(node))}}\\par\n`;
  if (node.type === 'horizontal_rule') return `\\pard\\brdrb\\brdrs\\brdrw10\\brsp20 \\par\n`;
  if (node.type === 'bullet_list' || node.type === 'ordered_list') {
    return children.filter(item => item.type === 'list_item').map((item, index) => {
      const text = nodeChildren(item).map(child => renderRtfBlocks(child, state)).join('').replace(/\\par\n$/, '');
      return `${node.type === 'ordered_list' ? `${index + 1}.` : '\\bullet'} ${text}\\par\n`;
    }).join('');
  }
  if (node.type === 'list_item') return children.map(child => renderRtfBlocks(child, state)).join('');
  if (node.type === 'table') {
    const { grid, width, columnWidths } = tableLayout(node);
    return grid.map((row, rowIndex) => {
      let boundary = 0;
      const properties = Array.from({ length: width }, (_, column) => {
        const slot = row[column];
        boundary += Math.round((columnWidths[column] || 120) * 15);
        const horizontal = slot?.colspan > 1 ? (slot.column === column ? '\\clmgf' : '\\clmrg') : '';
        const vertical = slot?.rowspan > 1 ? (slot.row === rowIndex ? '\\clvmgf' : '\\clvmrg') : '';
        return `${horizontal}${vertical}\\cellx${boundary}`;
      }).join('');
      const content = Array.from({ length: width }, (_, column) => {
        const slot = row[column];
        let text = '';
        if (slot && slot.row === rowIndex && slot.column === column) {
          text = nodeChildren(slot.cell).map(child => ['text', 'hard_break'].includes(child.type) ? renderRtfInline(child, state) : renderRtfBlocks(child, state)).join('').replace(/\\par\n$/, '');
          if (slot.cell.type === 'table_header') text = `{\\b ${text}}`;
        }
        return `\\pard\\intbl ${text}\\cell `;
      }).join('');
      const header = row.every(slot => slot?.cell.type === 'table_header') ? '\\trhdr ' : '';
      return `{\\trowd ${header}${properties}${content}\\row}\n`;
    }).join('');
  }
  return children.map(child => renderRtfBlocks(child, state)).join('');
}

function rtfImage(attachment) {
  const preview = attachment.preview;
  const mime = imageMime(preview, attachment);
  if (!preview?.bytes || !mime) return '';
  const control = mime === 'image/jpeg' || mime === 'image/jpg' ? 'jpegblip' : 'pngblip';
  const hex = Buffer.from(preview.bytes).toString('hex').replace(/(.{128})/g, '$1\n');
  return `{\\pict\\${control}\\picwgoal5760\\pichgoal4320\n${hex}}\\par\n`;
}

function renderRtfAttachments(entry) {
  if (!entry.attachments.length) return '';
  let output = '{\\b Attachments}\\par\n';
  for (const attachment of entry.attachments) {
    const preview = attachment.preview;
    const mime = imageMime(preview, attachment);
    if (preview?.kind === 'image' && preview.bytes && mime) output += rtfImage(attachment);
    if (preview?.kind === 'spreadsheet' && preview.sheets?.length) {
      output += `{\\b ${rtfEscape(attachment.name)}}\\par\n`;
      for (const sheet of preview.sheets) {
        output += `{\\i ${rtfEscape(sheet.name)}}\\par\n`;
        const rows = sheet.rows || [];
        const width = Math.max(...rows.map(row => row.length), 1);
        output += rows.map((row, rowIndex) => `{\\trowd ${Array.from({ length: width }, (_, index) => `\\cellx${Math.round((index + 1) * (9000 / width))}`).join(' ')}${Array.from({ length: width }, (_, index) => `${row[index] ? (rowIndex === 0 ? `{\\b ${rtfEscape(row[index])}}` : rtfEscape(row[index])) : ''}\\cell`).join('')}\\row}\n`).join('');
      }
    } else {
      output += `${rtfEscape(attachment.name)}${attachment.caption ? ` — ${rtfEscape(attachment.caption)}` : ''}\\par\n`;
    }
  }
  return output;
}

function renderRtf(model) {
  const colors = collectRtfHighlightColors(model);
  const colorIndexes = new Map(colors.map((color, index) => [color, index + 1]));
  const colorTable = colors.length ? `{\\colortbl ;${colors.map(color => { const [red, green, blue] = rtfColorValue(color); return `\\red${red}\\green${green}\\blue${blue};`; }).join('')}}` : '';
  const state = { colors, colorIndexes };
  let output = `{\\rtf1\\ansi\\deff0{\\fonttbl{\\f0 Helvetica;}{\\f1 Menlo;}}${colorTable}\\viewkind4\n`;
  output += `{\\b ${rtfEscape(model.notebook.name)}}\\par\n${rtfEscape(model.notebook.discipline)}\\par\\par\n`;
  model.entries.forEach((entry, index) => {
    output += `{\\b ${rtfEscape(entry.code)} — ${rtfEscape(entry.title)}}\\par\n`;
    output += `Date: ${rtfEscape(entry.date)}\\par\nAuthor: ${rtfEscape(entry.author)}\\par\nExperiment: ${rtfEscape(entry.experiment.label)}\\par\\par\n`;
    for (const section of entry.sections) {
      output += `{\\b ${rtfEscape(section.title)}}\\par\n${renderRtfBlocks(section.document, state)}`;
      if (section.id === 'data') output += renderRtfAttachments(entry);
      output += '\\par\n';
    }
    if (index !== model.entries.length - 1) output += '\\page\n';
  });
  output += '}';
  return Buffer.from(output, 'utf8');
}

function docxMarkOptions(marks) {
  const options = {};
  for (const mark of marks || []) {
    if (mark.type === 'bold') options.bold = true;
    else if (mark.type === 'italic') options.italics = true;
    else if (mark.type === 'underline') options.underline = { type: docx.UnderlineType?.SINGLE || 'single' };
    else if (mark.type === 'strike') options.strike = true;
    else if (mark.type === 'code') options.font = 'Menlo';
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
  const { placements, columnWidths } = tableLayout(node);
  if (!placements.length) return null;
  const widths = columnWidths.map(width => Math.round((width || 120) * 15));
  const headerMarks = node => ({ ...node, ...(node.type === 'text' ? { marks: [...(node.marks || []), { type: 'bold' }] } : {}), ...(node.content ? { content: node.content.map(headerMarks) } : {}) });
  return new docx.Table({
    rows: placements.map(row => new docx.TableRow({
      tableHeader: row.length > 0 && row.every(({ cell }) => cell.type === 'table_header'),
      children: row.map(({ cell, column, colspan, rowspan }) => {
        const content = cell.type === 'table_header' ? headerMarks(cell) : cell;
        const blocks = nodeChildren(content).flatMap(child => ['text', 'hard_break'].includes(child.type) ? [docxParagraphNode({ content: [child] }, model)] : docxBlockNodes(child, model));
        return new docx.TableCell({
          columnSpan: colspan,
          rowSpan: rowspan,
          width: { size: widths.slice(column, column + colspan).reduce((sum, value) => sum + value, 0), type: docx.WidthType.DXA },
          children: blocks.length ? blocks : [new docx.Paragraph('')],
        });
      }),
    })),
    columnWidths: widths,
    layout: docx.TableLayoutType.FIXED,
    width: { size: widths.reduce((sum, value) => sum + value, 0), type: docx.WidthType.DXA },
  });
}

function docxBlockNodes(node, model, listReference = null) {
  if (!node) return [];
  const children = nodeChildren(node);
  if (node.type === 'doc') return children.flatMap(child => docxBlockNodes(child, model));
  if (node.type === 'paragraph' || node.type === 'blockquote' || node.type === 'unsupported') {
    return [docxParagraphNode(node, model, { ...(docxAlignment(node) ? { alignment: docxAlignment(node) } : {}) })];
  }
  if (node.type === 'heading') {
    const level = clampInteger(node.attrs?.level, 1, 6, 2);
    const heading = docx.HeadingLevel?.[`HEADING_${level}`] || `Heading${level}`;
    return [docxParagraphNode(node, model, { heading, ...(docxAlignment(node) ? { alignment: docxAlignment(node) } : {}) })];
  }
  if (node.type === 'code_block') return [new docx.Paragraph({ children: [new docx.TextRun({ text: inlineText(node), font: 'Menlo' })] })];
  if (node.type === 'horizontal_rule') return [new docx.Paragraph({ thematicBreak: true })];
  if (node.type === 'bullet_list' || node.type === 'ordered_list') {
    const reference = node.type === 'bullet_list' ? 'labmate-bullets' : 'labmate-numbered';
    return children.filter(item => item.type === 'list_item').flatMap(item => docxBlockNodes(item, model, reference));
  }
  if (node.type === 'list_item') {
    const blocks = children.filter(child => !['bullet_list', 'ordered_list'].includes(child.type));
    const nested = children.filter(child => ['bullet_list', 'ordered_list'].includes(child.type));
    const first = blocks.shift();
    const output = first
      ? [docxParagraphNode(first, model, { numbering: { reference: listReference || 'labmate-bullets', level: 0 } })]
      : [new docx.Paragraph({ text: '', numbering: { reference: listReference || 'labmate-bullets', level: 0 } })];
    return output.concat(blocks.flatMap(block => docxBlockNodes(block, model)), nested.flatMap(child => docxBlockNodes(child, model)));
  }
  if (node.type === 'table') {
    const table = docxTableNode(node, model);
    return table ? [table] : [];
  }
  return children.flatMap(child => docxBlockNodes(child, model, listReference));
}

function docxImageNode(attachment, model) {
  const preview = attachment.preview;
  const mime = imageMime(preview, attachment);
  const typeMap = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/gif': 'gif', 'image/bmp': 'bmp' };
  const type = typeMap[mime];
  if (!preview?.bytes || !type) {
    if (preview?.bytes && mime) makeWarning(`Attachment “${attachment.name}” uses an image format DOCX cannot embed; its filename and caption were retained.`, model.warnings);
    return null;
  }
  return new docx.ImageRun({ type, data: Buffer.from(preview.bytes), transformation: { width: 520, height: 340 } });
}

function docxAttachmentNodes(entry, model) {
  if (!entry.attachments.length) return [];
  const output = [new docx.Paragraph({ children: [new docx.TextRun({ text: 'Attachments', bold: true })] })];
  for (const attachment of entry.attachments) {
    const image = attachment.preview?.kind === 'image' ? docxImageNode(attachment, model) : null;
    if (image) output.push(new docx.Paragraph({ children: [image] }));
    else if (attachment.preview?.kind === 'spreadsheet' && attachment.preview.sheets?.length) {
      output.push(new docx.Paragraph({ children: [new docx.TextRun({ text: attachment.name, bold: true })] }));
      for (const sheet of attachment.preview.sheets) {
        output.push(new docx.Paragraph({ children: [new docx.TextRun({ text: sheet.name, italics: true })] }));
        const rows = sheet.rows || [];
        const width = Math.max(...rows.map(row => row.length), 1);
        if (rows.length) output.push(new docx.Table({ rows: rows.map((row, rowIndex) => new docx.TableRow({ children: Array.from({ length: width }, (_, index) => new docx.TableCell({ children: [new docx.Paragraph({ children: [new docx.TextRun({ text: row[index] || '', bold: rowIndex === 0 })] })] })) })) }));
      }
    } else {
      output.push(new docx.Paragraph({ children: [new docx.TextRun({ text: attachment.name, bold: true }), ...(attachment.caption ? [new docx.TextRun(` — ${attachment.caption}`)] : [])] }));
    }
    if (image && attachment.caption) output.push(new docx.Paragraph({ children: [new docx.TextRun({ text: attachment.caption, italics: true })] }));
  }
  return output;
}

async function renderDocx(model) {
  if (!docx) throw new ExportError('UNAVAILABLE', 'The DOCX writer dependency is unavailable');
  const children = [
    new docx.Paragraph({ heading: docx.HeadingLevel?.TITLE || 'Title', children: [new docx.TextRun({ text: model.notebook.name, bold: true })] }),
    new docx.Paragraph({ children: [new docx.TextRun(model.notebook.discipline)] }),
  ];
  for (const entry of model.entries) {
    children.push(new docx.Paragraph({ heading: docx.HeadingLevel?.HEADING_1 || 'Heading1', children: [new docx.TextRun({ text: `${entry.code} — ${entry.title}`, bold: true })] }));
    children.push(new docx.Paragraph({ children: [new docx.TextRun(`Date: ${entry.date}    Author: ${entry.author}    Experiment: ${entry.experiment.label}`)] }));
    for (const section of entry.sections) {
      children.push(new docx.Paragraph({ heading: docx.HeadingLevel?.HEADING_2 || 'Heading2', children: [new docx.TextRun({ text: section.title, bold: true })] }));
      children.push(...docxBlockNodes(section.document, model));
      if (section.id === 'data') children.push(...docxAttachmentNodes(entry, model));
    }
  }
  const document = new docx.Document({
    creator: 'LabMate',
    title: model.notebook.name,
    numbering: {
      config: [
        { reference: 'labmate-bullets', levels: [{ level: 0, format: docx.LevelFormat?.BULLET || 'bullet', text: '•', alignment: 'left' }] },
        { reference: 'labmate-numbered', levels: [{ level: 0, format: docx.LevelFormat?.DECIMAL || 'decimal', text: '%1.', alignment: 'left' }] },
      ],
    },
    sections: [{ children }],
  });
  return { bytes: await docx.Packer.toBuffer(document), assets: [], assetsDirectory: null };
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
    targets.push({ staged: path.join(stagingDir, assetsDirectory), destination: path.join(destinationDir, assetsDirectory), directory: true });
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
  try {
    for (let index = 0; index < targets.length; index += 1) {
      checkCancelled(context);
      let stat;
      try { stat = await fsp.lstat(targets[index].destination); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (stat) {
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
      await fsp.rename(backup.backup, backup.original).catch(() => undefined);
    }
    throw error;
  } finally {
    await fsp.rm(backupDir, { recursive: true, force: true }).catch(() => undefined);
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
