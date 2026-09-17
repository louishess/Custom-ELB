'use strict';

const z = require('zod');
const text = z.string().max(4000).refine(value => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value));
const opaque = z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/);
const CITATION_STYLES = Object.freeze({
  'american-chemical-society':'American Chemical Society', apa:'APA (7th edition)',
  'chicago-author-date':'Chicago (author–date)', 'modern-language-association':'MLA',
  'harvard-cite-them-right':'Harvard — Cite Them Right', nature:'Nature', vancouver:'Vancouver', ieee:'IEEE',
});
const styleSchema = z.enum(Object.keys(CITATION_STYLES));
const librarySchema = z.object({ libraryType: z.enum(['user', 'group']), libraryId: z.string().regex(/^\d{1,20}$/) }).strict();
const identitySchema = librarySchema.extend({ sourceInstance: opaque, itemKey: z.string().regex(/^[A-Z0-9]{8}$/) }).strict();
const snapshotSchema = z.object({
  version: z.literal(1), itemType: z.string().regex(/^[A-Za-z]{1,80}$/), title: text,
  creators: z.array(z.object({ name: z.string().max(600), role: z.string().max(80) }).strict()).max(100),
  date: text, publication: text, volume: text, issue: text, pages: text, doi: text, url: text,
  libraryLabel: z.string().max(300), fetchedAt: z.iso.datetime(), sourceVersion: z.number().int().nonnegative().nullable(),
  formattedCitation: z.object({text: text.min(1), style: styleSchema, fetchedAt: z.iso.datetime()}).strict().optional(),
}).strict();
const itemSchema = identitySchema.extend({ snapshot: snapshotSchema }).strict();
const targetSchema = z.object({ experimentId: z.uuid(), expectedRevision: z.number().int().positive(), libraryGeneration: z.uuid() }).strict();
const querySchema = librarySchema.extend({ generation: z.uuid(), start: z.number().int().min(0).max(10000000) }).strict();
const schemas = {
  'zotero.status': z.undefined(), 'zotero.connect': z.undefined(), 'zotero.disconnect': z.undefined(),
  'zotero.cancel': z.object({ sessionId: z.uuid() }).strict(),
  'zotero.libraries': z.object({ generation: z.uuid(), start: z.number().int().min(0).max(10000000) }).strict(),
  'zotero.collections': querySchema,
  'zotero.search': querySchema.extend({ query: z.string().max(300), collectionKey: z.string().regex(/^[A-Z0-9]{8}$/).optional(), style:styleSchema.optional() }).strict(),
  'zotero.item': z.object({ generation: z.uuid(), identity: identitySchema, style:styleSchema.optional() }).strict(),
  'citations.add': targetSchema.extend({ generation: z.uuid(), sessionId: z.uuid(), items: z.array(identitySchema).min(1).max(50) }).strict(),
  'citations.remove': targetSchema.extend({ id: z.uuid() }).strict(),
  'citations.previewRefresh': targetSchema.extend({ id: z.uuid(), generation: z.uuid(), sessionId: z.uuid() }).strict(),
  'citations.refreshLabel': targetSchema.extend({ id: z.uuid(), generation: z.uuid(), sessionId: z.uuid() }).strict(),
  'citations.applyRefresh': targetSchema.extend({ token: z.uuid(), sessionId: z.uuid() }).strict(),
};
const internalSchemas = {
  'citations.add': targetSchema.extend({ items: z.array(itemSchema).min(1).max(50), jobId: z.uuid().optional() }).strict(),
  'citations.remove': schemas['citations.remove'],
  'citations.applyRefresh': targetSchema.extend({ id: z.uuid(), item: itemSchema, jobId: z.uuid().optional() }).strict(),
};
function validate(schema, input) {
  const result = schema.safeParse(input);
  if (!result.success) throw Object.assign(new Error('Invalid citation data.'), { code: 'VALIDATION' });
  return result.data;
}
function safeURL(value) {
  try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : ''; }
  catch { return ''; }
}
// CSL output is HTML. Convert it to bounded plain text before persistence;
// the renderer must never interpret a citation label as markup.
function plainCitation(value) {
  if (typeof value !== 'string' || value.length > 32000) return '';
  const entities = {amp:'&',lt:'<',gt:'>',quot:'"',apos:"'",nbsp:' ',ndash:'–',mdash:'—',lsquo:'‘',rsquo:'’',ldquo:'“',rdquo:'”'};
  const result = value.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<!--[^]*?-->/g, '').replace(/<\/?(?:br|p|div|li|ol|ul)\b[^>]*>/gi, ' ').replace(/<[^>]*>/g, '')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, entity) => {
      if (!entity.startsWith('#')) return entities[entity.toLowerCase()] ?? whole;
      const number = entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2),16) : Number(entity.slice(1));
      return number > 0 && number <= 0x10ffff && !(number >= 0xd800 && number <= 0xdfff) ? String.fromCodePoint(number) : '�';
    }).replace(/[\u0000-\u001f\u007f]/g,' ').replace(/\s+/g,' ').trim();
  return result.length <= 4000 ? result : '';
}
function normalizeItem(raw, identity, libraryLabel, now = new Date(), style) {
  if (!raw || !raw.data || raw.key !== identity.itemKey || ['attachment', 'note', 'annotation'].includes(raw.data.itemType) || raw.data.deleted) {
    throw Object.assign(new Error('This Zotero item is missing or is not a bibliographic reference.'), {code: 'NOT_FOUND'});
  }
  const d = raw.data;
  if ((d.key && d.key !== raw.key) || (raw.library && (raw.library.type !== identity.libraryType ||
    (identity.libraryType === 'group' && String(raw.library.id) !== identity.libraryId)))) {
    throw Object.assign(new Error('Zotero returned an item from a different library.'), {code:'VALIDATION'});
  }
  const clean = value => typeof value === 'string' ? value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '') : '';
  let citation = style ? plainCitation(raw.citation) : '';
  // A numeric citation such as “1” cannot identify a standalone reference.
  // Use Zotero's formatted bibliography entry for those styles instead.
  if (style && !/[\p{L}]/u.test(citation)) citation = plainCitation(raw.bib);
  return validate(itemSchema, { ...identity, snapshot: {
    version: 1, itemType: d.itemType, title: clean(d.title),
    creators: (Array.isArray(d.creators) ? d.creators : []).map(c => ({name: clean(c.name || [c.firstName, c.lastName].filter(Boolean).join(' ')), role: clean(c.creatorType)})),
    date: clean(d.date), publication: clean(d.publicationTitle || d.bookTitle || d.publisher || d.university),
    volume: clean(d.volume), issue: clean(d.issue), pages: clean(d.pages), doi: clean(d.DOI), url: safeURL(d.url),
    libraryLabel, fetchedAt: now.toISOString(), sourceVersion: Number.isSafeInteger(raw.version) && raw.version >= 0 ? raw.version : null,
    ...(citation ? {formattedCitation:{text:citation,style,fetchedAt:now.toISOString()}} : {}),
  }});
}
function referenceText(snapshot) {
  const s = validate(snapshotSchema, snapshot);
  const names = s.creators.map(c => c.name).filter(Boolean).join('; ');
  const locator = s.doi ? `https://doi.org/${s.doi.replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '')}` : safeURL(s.url);
  return [names, s.date, s.title || 'Untitled reference', s.publication,
    [s.volume, s.issue ? `(${s.issue})` : '', s.pages].filter(Boolean).join(' '), locator].filter(Boolean).join('. ');
}
function identityKey(item) { return [item.sourceInstance, item.libraryType, item.libraryId, item.itemKey].join('/'); }
function validateStoredCitations(db) {
  for (const row of db.prepare('SELECT * FROM experiment_citations').iterate()) {
    validate(z.uuid(), row.id); validate(z.uuid(), row.experiment_id);
    validate(z.iso.datetime(), row.created_at); validate(z.iso.datetime(), row.updated_at);
    if (typeof row.snapshot_json !== 'string' || row.snapshot_json.length > 131072) throw new Error('Citation snapshot is too large.');
    validate(itemSchema, { sourceInstance: row.source_instance, libraryType: row.library_type, libraryId: row.library_id,
      itemKey: row.item_key, snapshot: JSON.parse(row.snapshot_json) });
  }
}
function citationLabel(snapshot, preferences) {
  const formatted = snapshot.formattedCitation;
  return preferences.citationLabel === 'formatted' && formatted?.style === preferences.citationStyle
    ? formatted.text : snapshot.title || 'Untitled reference';
}
module.exports = { schemas, internalSchemas, itemSchema, snapshotSchema, identitySchema, librarySchema, validate, normalizeItem, referenceText, identityKey, safeURL, validateStoredCitations, plainCitation, citationLabel, CITATION_STYLES, styleSchema };
