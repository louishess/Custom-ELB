'use strict';

// Document presentation is deliberately independent of renderer appearance.
// Points are the canonical page units; CSS uses pixels at 96 dpi.
// Portable document faces avoid serif substitution for unavailable Mac fonts.
const DESIGN = Object.freeze({
  font: 'Arial', mono: 'Courier New',
  ink: '252525', secondary: '595959', line: 'DADADA', soft: 'F5F5F5',
  starting: '#ededed', product: '#dedede',
  pageWidth: 612, pageHeight: 792, margin: 54,
  body: 11, title: 22, notebook: 18, section: 12, small: 9, table: 10,
});
const twips = points => Math.round(points * 20);
const pixels = points => points * 4 / 3;
const contentWidth = pixels(DESIGN.pageWidth - 2 * DESIGN.margin);
const sectionLabel = (section, index) => `${String(index + 1).padStart(2, '0')}  ${section.title}`;
function displayDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value || '');
  if (!match) return value || '';
  const month = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][Number(match[2]) - 1];
  return month ? `${month} ${Number(match[3])}, ${match[1]}` : value;
}
function metadata(entry) {
  return [
    ['Date', displayDate(entry.date)], ['Author', entry.author],
    ['Experiment', entry.experiment.label],
    ['Run', `${entry.runNumber} of experiment ${entry.experimentNumber}`],
  ].filter(([, value]) => value);
}
function notebookContext(model) {
  return [model.notebook.discipline,
    ...(model.scope !== 'entry' ? [`${model.entries.length} ${model.entries.length === 1 ? 'entry' : 'entries'}`] : []),
    model.scheme?.name,
  ].filter(Boolean).join(' · ');
}
function fitColumns(columnWidths) {
  const source = columnWidths.map(width => width || 120);
  const total = source.reduce((sum, width) => sum + width, 0);
  const scale = Math.min(1, contentWidth / total);
  const widths = source.map(width => width * scale);
  return { widths, readable: widths.every(width => width >= 40) };
}

// Read bounded raster headers, without decoding untrusted image pixels.
function imageDimensions(data) {
  const b = Buffer.from(data || []);
  let width, height;
  if (b.length >= 24 && b.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) && b.toString('ascii', 12, 16) === 'IHDR') {
    width = b.readUInt32BE(16); height = b.readUInt32BE(20);
  } else if (b.length >= 10 && /^GIF8[79]a$/.test(b.toString('ascii', 0, 6))) {
    width = b.readUInt16LE(6); height = b.readUInt16LE(8);
  } else if (b.length >= 26 && b.toString('ascii', 0, 2) === 'BM') {
    const dib = b.readUInt32LE(14);
    if (dib === 12) { width = b.readUInt16LE(18); height = b.readUInt16LE(20); }
    else if (dib >= 40) { width = Math.abs(b.readInt32LE(18)); height = Math.abs(b.readInt32LE(22)); }
  } else if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    let offset = 2;
    while (offset + 4 <= b.length) {
      if (b[offset++] !== 0xff) break;
      while (offset < b.length && b[offset] === 0xff) offset++;
      const marker = b[offset++];
      if (marker === 0xda || marker === 0xd9) break;
      if (marker === 0x01 || marker >= 0xd0 && marker <= 0xd8) continue;
      if (offset + 2 > b.length) break;
      const length = b.readUInt16BE(offset);
      if (length < 2 || offset + length > b.length) break;
      if ([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker) && length >= 7) {
        height = b.readUInt16BE(offset + 3); width = b.readUInt16BE(offset + 5); break;
      }
      offset += length;
    }
  }
  return width > 0 && height > 0 && width * height <= 50_000_000 ? { width, height } : null;
}
function fitImage(data) {
  const size = imageDimensions(data);
  if (!size) return null;
  // Reserve room for a caption, and never enlarge small source images.
  const scale = Math.min(1, contentWidth / size.width, 600 / size.height);
  return { width: size.width * scale, height: size.height * scale };
}

const htmlStyles = `
:root{color-scheme:light}
*{box-sizing:border-box}
body{margin:0;background:#fff;color:#${DESIGN.ink};font:15px/1.75 -apple-system,BlinkMacSystemFont,"Helvetica Neue",Helvetica,Arial,sans-serif}
.labmate-export{max-width:850px;margin:0 auto;padding:48px 44px 64px;overflow-wrap:anywhere}
.labmate-export h1,.labmate-export h2,.labmate-export h3,.labmate-export h4,.labmate-export p{margin:0}
.export-context{padding-bottom:24px;color:#${DESIGN.secondary};font-size:12px}
.wordmark{font-weight:650;letter-spacing:-.3px;color:#${DESIGN.ink};margin-right:12px}
.notebook-title{font-size:24px;line-height:1.3;font-weight:600;margin-top:12px!important}
.notebook-context{margin-top:6px!important}
.entry+.entry{margin-top:48px;padding-top:32px;border-top:1px solid #${DESIGN.line}}
.entry-header{padding-bottom:24px;border-bottom:1px solid #${DESIGN.line};margin-bottom:28px}
.entry-code{display:inline-block;border:1px solid #${DESIGN.line};background:#${DESIGN.soft};border-radius:4px;padding:3px 7px;font-size:12px;line-height:1.5;font-variant-numeric:tabular-nums;color:#${DESIGN.secondary}}
.entry-title{font-size:30px;line-height:1.3;font-weight:550;letter-spacing:-.65px;margin:12px 0 14px!important}
.entry-metadata{display:flex;gap:6px 20px;flex-wrap:wrap;font-size:12px;color:#${DESIGN.secondary}}
.entry-metadata span{display:inline-block}.metadata-label{font-weight:500}
.export-section{margin:0 0 28px;padding-bottom:28px;border-bottom:1px solid #${DESIGN.line}}
.section-title{display:flex;align-items:baseline;gap:12px;font-size:16px;line-height:1.5;font-weight:600;margin-bottom:18px!important}
.section-number{font-size:12px;font-weight:400;color:#${DESIGN.secondary};font-variant-numeric:tabular-nums}
.prose p{margin:0 0 12px}.prose p:last-child{margin-bottom:0}
.prose .content-heading{line-height:1.45;font-weight:600;margin:18px 0 10px;font-size:14px}
.prose .content-heading.level-1{font-size:20px}.prose .content-heading.level-2{font-size:18px}.prose .content-heading.level-3{font-size:16px}
.prose ul,.prose ol{padding-left:24px;margin:10px 0 16px}.prose li{padding-left:4px;margin:4px 0}
.prose li p{margin-bottom:6px}
.prose blockquote,.yield-summary{margin:16px 0;padding:12px 16px;border-left:2px solid #a0a0a0;background:#${DESIGN.soft}}
.yield-summary p:first-child{font-weight:600}.yield-summary p{margin-bottom:5px}
.prose pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#${DESIGN.soft};padding:12px 16px;border-radius:4px}
.prose code{font-family:Menlo,Consolas,monospace;font-size:.9em}
.labmate-export a{color:inherit;text-decoration:underline;text-underline-offset:2px}
.labmate-export mark{color:#${DESIGN.ink};padding:1px 0}
.labmate-export hr{border:0;border-top:1px solid #${DESIGN.line};margin:20px 0}
.table-wrap{margin:16px 0;max-width:100%;overflow-x:auto}
.labmate-export table{border-collapse:collapse;table-layout:fixed;max-width:100%;font-size:13px;line-height:1.5}
.labmate-export td,.labmate-export th{border:1px solid #${DESIGN.line};padding:8px 10px;vertical-align:top;text-align:left;overflow-wrap:anywhere}
.labmate-export th{background:#${DESIGN.soft};font-weight:600}.labmate-export td p,.labmate-export th p{margin:0 0 5px}
.table-fallback{margin:16px 0}.table-fallback-label{color:#${DESIGN.secondary};font-size:12px;margin-bottom:10px!important}
.attachments{margin-top:24px}.attachment-heading{font-size:14px;font-weight:600;margin:16px 0 10px!important}
.attachment{padding:12px 14px;border:1px solid #${DESIGN.line};border-radius:5px;margin:12px 0!important}
.labmate-export figure{margin:20px 0}.labmate-export img{display:block;max-width:100%;max-height:600px;width:auto;height:auto;object-fit:contain}
.labmate-export figcaption,.caption{font-size:12px;line-height:1.6;color:#${DESIGN.secondary};margin-top:8px!important}
@media(max-width:600px){.labmate-export{padding:24px 20px}.entry-title{font-size:26px}.entry-metadata{gap:6px 14px}}
@page{size:auto;margin:0.75in}
@media print{
 body{font-size:11pt;line-height:1.55;background:#fff!important;color:#${DESIGN.ink}}
 .labmate-export{max-width:none;padding:0;margin:0}.export-context{padding-bottom:16pt}
 .entry-title{font-size:22pt}.notebook-title{font-size:18pt}.section-title{font-size:12pt;margin-bottom:12pt!important}
 .entry-metadata,.entry-code,.export-context,.section-number,figcaption,.caption{font-size:9pt!important}
 .entry-header{margin-bottom:20pt;padding-bottom:16pt}.export-section{margin-bottom:20pt;padding-bottom:20pt}
 .entry+.entry{break-before:page;margin-top:0;padding-top:0;border:0}
 .entry-header,.section-title,.content-heading,.attachment-heading{break-after:avoid}
 p{orphans:3;widows:3}.labmate-export figure{break-inside:avoid}.labmate-export img{max-height:450pt}
 .labmate-export table{font-size:10pt;width:100%!important}.table-wrap{overflow:visible}
 thead{display:table-header-group}.labmate-export th{print-color-adjust:exact;-webkit-print-color-adjust:exact}
 .prose .content-heading.level-1{font-size:15pt}.prose .content-heading.level-2{font-size:13.5pt}.prose .content-heading.level-3{font-size:12pt}
}`;

module.exports = { DESIGN, twips, pixels, contentWidth, sectionLabel, metadata, notebookContext, displayDate, fitColumns, imageDimensions, fitImage, htmlStyles };
