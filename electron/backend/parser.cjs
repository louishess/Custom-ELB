'use strict';

/*
 * The renderer never receives a path to an attachment.  This process is
 * started by files.cjs with a path that has already been resolved to a
 * managed object.  Keeping workbook parsing here makes the potentially
 * expensive XML/ZIP work disposable and gives cancellation a process
 * boundary.
 */

const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const yauzl = require('yauzl');
const ExcelJS = require('exceljs');
const Papa = require('papaparse');

const MAX_SPREADSHEET_BYTES = 25 * 1024 * 1024;
const MAX_DISPLAYED_CELLS = 100_000;
const MAX_CELL_CHARS = 1_000_000;
const MAX_ZIP_ENTRIES = 20_000;
const MAX_ZIP_ENTRY_BYTES = 50 * 1024 * 1024;
const MAX_ZIP_TOTAL_BYTES = 100 * 1024 * 1024;
const READ_FLAGS = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0);

class ParserError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ParserError';
    this.code = code;
  }
}

function checkCancelled(signal) {
  if (signal?.aborted) throw new ParserError('CANCELLED', 'Preview cancelled.');
}

function asAbsoluteFile(filePath) {
  if (typeof filePath !== 'string' || !path.isAbsolute(filePath) || filePath.includes('\0')) {
    throw new ParserError('VALIDATION', 'The parser requires an absolute managed file path.');
  }
  return filePath;
}

function asSpreadsheetFormat(format) {
  if (format !== 'csv' && format !== 'tsv' && format !== 'xlsx') {
    throw new ParserError('UNSUPPORTED', 'This spreadsheet format is not supported.');
  }
  return format;
}

function valueToString(value) {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value);
  if (typeof value === 'object') {
    // ExcelJS represents formulas as { formula, result }.  Never evaluate the
    // formula; displaying a cached result is safe because it came from the
    // file and no workbook calculation is requested.
    if (Object.prototype.hasOwnProperty.call(value, 'formula')) return valueToString(value.result);
    if (Object.prototype.hasOwnProperty.call(value, 'sharedFormula')) return valueToString(value.result);
    if (Array.isArray(value.richText)) return value.richText.map(part => valueToString(part?.text)).join('');
    if (Object.prototype.hasOwnProperty.call(value, 'text')) return valueToString(value.text);
    if (Object.prototype.hasOwnProperty.call(value, 'error')) return String(value.error);
    try { return JSON.stringify(value); } catch { return ''; }
  }
  return String(value);
}

function checkCellLength(value) {
  if (value.length > MAX_CELL_CHARS) {
    throw new ParserError('LIMIT', 'A spreadsheet cell is too large to preview safely.');
  }
}

async function parseDelimited(text, delimiter, signal) {
  checkCancelled(signal);
  let source = text;
  if (source.charCodeAt(0) === 0xfeff) source = source.slice(1);
  const rows = [];
  let cellCount = 0;
  let truncated = false;
  let parseError;

  try {
    Papa.parse(source, {
      delimiter,
      newline: '',
      skipEmptyLines: false,
      dynamicTyping: false,
      step: (result, parser) => {
        if (parseError || truncated) {
          parser.abort();
          return;
        }
        checkCancelled(signal);
        if (result.errors?.length) {
          parseError = result.errors[0];
          parser.abort();
          return;
        }
        const values = result.data.map(value => String(value ?? ''));
        for (const value of values) checkCellLength(value);
        const remaining = MAX_DISPLAYED_CELLS - cellCount;
        if (values.length > remaining) {
          if (remaining > 0) {
            rows.push(values.slice(0, remaining));
            cellCount += remaining;
          }
          truncated = true;
          parser.abort();
          return;
        }
        rows.push(values);
        cellCount += values.length;
      },
      error: error => { parseError = error; },
      complete: result => {
        if (!parseError && result?.errors?.length) parseError = result.errors[0];
      },
    });
  } catch (error) {
    if (error instanceof ParserError) throw error;
    throw new ParserError('CORRUPT', `The delimited file could not be parsed: ${error.message}`);
  }
  checkCancelled(signal);
  if (parseError && !truncated) throw new ParserError('CORRUPT', `The delimited file could not be parsed: ${parseError.message || 'invalid quoting'}.`);
  return {
    sheets: [{ name: delimiter === '\t' ? 'TSV' : 'CSV', rows }],
    message: truncated ? `Preview limited to the first ${MAX_DISPLAYED_CELLS.toLocaleString('en-US')} cells.` : undefined,
  };
}

function isUnsafeZipName(name) {
  if (!name || name.includes('\0') || name.includes('\\') || name.startsWith('/') || /^[A-Za-z]:/.test(name)) return true;
  return name.split('/').some(part => part === '..');
}

async function inspectXlsxContainer(buffer, signal) {
  checkCancelled(signal);
  return new Promise((resolve, reject) => {
    let settled = false;
    let zipfile;
    const names = [];
    let declaredTotalBytes = 0;
    const abort = () => {
      if (zipfile) zipfile.close();
      finish(new ParserError('CANCELLED', 'Preview cancelled.'));
    };
    const onAbort = () => abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    const finish = error => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      if (error) reject(error);
      else resolve(names);
    };

    try {
      yauzl.fromBuffer(buffer, { lazyEntries: true, validateEntrySizes: true, decodeStrings: true }, (error, opened) => {
        if (error) {
          finish(new ParserError('CORRUPT', 'The workbook is not a readable XLSX archive.'));
          return;
        }
        zipfile = opened;
        zipfile.on('error', zipError => finish(new ParserError('CORRUPT', `The workbook archive could not be read: ${zipError.message}`)));
        zipfile.on('end', () => finish());
        zipfile.on('entry', entry => {
          if (settled) return;
          try {
            checkCancelled(signal);
            const name = entry.fileName;
            if (isUnsafeZipName(name)) throw new ParserError('CORRUPT', 'The workbook contains an unsafe archive path.');
            if (names.length >= MAX_ZIP_ENTRIES) throw new ParserError('LIMIT', 'The workbook contains too many archive entries.');
            if (entry.uncompressedSize > MAX_ZIP_ENTRY_BYTES) throw new ParserError('LIMIT', 'A workbook component is too large to preview safely.');
            declaredTotalBytes += entry.uncompressedSize;
            if (declaredTotalBytes > MAX_ZIP_TOTAL_BYTES) throw new ParserError('LIMIT', 'The workbook expands beyond the safe preview bound.');
            names.push(name);
            const lower = name.toLowerCase();
            if (lower.endsWith('vbaproject.bin') || lower.includes('/vbaproject.bin') || lower.endsWith('.xlsm') || lower.includes('/activex/') || lower.includes('/embeddings/') || lower.includes('/oleobject')) {
              throw new ParserError('UNSUPPORTED', 'Macro-enabled workbooks are not previewed.');
            }
            // External links and connection definitions are intentionally not
            // interpreted.  Refusing them keeps this viewer deterministic and
            // guarantees that no external content is followed.
            if (lower.includes('externallink') || lower.endsWith('/connections.xml') || lower === 'connections.xml') {
              throw new ParserError('UNSUPPORTED', 'Workbooks with external links or connections are not previewed.');
            }
            zipfile.readEntry();
          } catch (entryError) {
            if (zipfile) zipfile.close();
            finish(entryError);
          }
        });
        zipfile.readEntry();
      });
    } catch (error) {
      finish(new ParserError('CORRUPT', `The workbook archive could not be opened: ${error.message}`));
    }
  });
}

function getFormulaSafeValue(value) {
  // Do not call workbook.calcProperties or any formula evaluator.  ExcelJS
  // keeps formula results as a plain value in this object.
  if (value && typeof value === 'object' && Object.prototype.hasOwnProperty.call(value, 'formula')) return valueToString(value.result);
  if (value && typeof value === 'object' && Object.prototype.hasOwnProperty.call(value, 'sharedFormula')) return valueToString(value.result);
  return valueToString(value);
}

async function parseXlsx(buffer, signal) {
  await inspectXlsxContainer(buffer, signal);
  checkCancelled(signal);
  const workbook = new ExcelJS.Workbook();
  try {
    // ExcelJS only parses workbook data.  It does not run formulas, macros,
    // scripts, or network content; formula cells below use cached results.
    await workbook.xlsx.load(buffer);
    if (workbook.calcProperties) {
      workbook.calcProperties.fullCalcOnLoad = false;
      workbook.calcProperties.forceFullCalc = false;
      workbook.calcProperties.calcMode = 'manual';
    }
  } catch (error) {
    throw new ParserError('CORRUPT', `The workbook could not be decoded: ${error.message}`);
  }
  checkCancelled(signal);

  const sheets = [];
  let cellCount = 0;
  let truncated = false;
  for (const worksheet of workbook.worksheets) {
    checkCancelled(signal);
    const rows = [];
    worksheet.eachRow({ includeEmpty: false }, row => {
      if (truncated) return;
      const columnCount = Math.min(row.cellCount, MAX_DISPLAYED_CELLS - cellCount);
      if (columnCount <= 0) {
        truncated = true;
        return;
      }
      const values = [];
      for (let column = 1; column <= columnCount; column += 1) {
        const value = getFormulaSafeValue(row.getCell(column).value);
        checkCellLength(value);
        values.push(value);
        cellCount += 1;
      }
      if (values.length) rows.push(values);
      if (cellCount >= MAX_DISPLAYED_CELLS) truncated = true;
    });
    sheets.push({ name: worksheet.name || `Sheet ${sheets.length + 1}`, rows });
    if (truncated) break;
  }

  return {
    sheets,
    message: truncated ? `Preview limited to the first ${MAX_DISPLAYED_CELLS.toLocaleString('en-US')} cells.` : undefined,
  };
}

async function parseSpreadsheetFile(filePath, format, signal) {
  const absolutePath = asAbsoluteFile(filePath);
  const spreadsheetFormat = asSpreadsheetFormat(format);
  checkCancelled(signal);
  let handle;
  let buffer;
  try {
    // Open the managed object without following a final symlink, then read
    // through the same descriptor so a path replacement cannot redirect the
    // parser after the parent has validated the object.
    handle = await fsp.open(absolutePath, READ_FLAGS);
    const stat = await handle.stat();
    if (!stat.isFile()) throw new ParserError('CORRUPT', 'The managed spreadsheet is not a regular file.');
    if (stat.size > MAX_SPREADSHEET_BYTES) throw new ParserError('LIMIT', 'Spreadsheet previews are limited to 25 MiB.');
    buffer = await handle.readFile();
  } catch (error) {
    if (error instanceof ParserError) throw error;
    const code = error?.code === 'ENOENT' ? 'NOT_FOUND' : error?.code === 'ELOOP' ? 'CORRUPT' : 'IO';
    throw new ParserError(code, `The managed spreadsheet could not be read: ${error.message}`);
  } finally {
    await handle?.close().catch(() => {});
  }
  checkCancelled(signal);
  if (spreadsheetFormat === 'xlsx') return parseXlsx(buffer, signal);
  if (buffer.includes(0)) throw new ParserError('CORRUPT', 'The delimited file contains binary data and cannot be previewed as text.');
  const delimiter = spreadsheetFormat === 'tsv' ? '\t' : ',';
  return parseDelimited(buffer.toString('utf8'), delimiter, signal);
}

const activeJobs = new Map();

async function handleMessage(message) {
  if (!message || typeof message !== 'object') return;
  if (message.method === 'cancel') {
    activeJobs.get(message.id)?.abort();
    return;
  }
  if (message.method !== 'parse' || typeof message.id !== 'string') return;
  const controller = new AbortController();
  activeJobs.set(message.id, controller);
  try {
    const payload = message.payload || {};
    const value = await parseSpreadsheetFile(payload.path, payload.format, controller.signal);
    process.send?.({ id: message.id, result: { ok: true, value } });
  } catch (error) {
    const code = error?.code || 'CORRUPT';
    const text = error?.message || 'The spreadsheet preview failed.';
    process.send?.({ id: message.id, result: { ok: false, error: { code, message: text } } });
  } finally {
    activeJobs.delete(message.id);
  }
}

if (require.main === module) {
  process.on('message', message => { void handleMessage(message); });
}

module.exports = {
  MAX_SPREADSHEET_BYTES,
  MAX_DISPLAYED_CELLS,
  MAX_ZIP_ENTRIES,
  MAX_ZIP_ENTRY_BYTES,
  MAX_ZIP_TOTAL_BYTES,
  ParserError,
  parseDelimited,
  parseSpreadsheetFile,
  parseXlsx,
};
