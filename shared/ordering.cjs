'use strict';
const EXPORT_ORDERS = Object.freeze(['newest', 'oldest', 'title-az', 'title-za', 'label-az', 'author-az', 'number-asc', 'number-desc', 'scheme']);
function normalizeOrder(order) { return order === 'az' ? 'title-az' : order === 'za' ? 'title-za' : order; }
function compareRuns(a, b, order, locale = 'en-US') {
  const text = (x, y) => String(x || '').localeCompare(String(y || ''), locale, { sensitivity: 'base', numeric: true });
  let result = 0;
  switch (normalizeOrder(order)) {
    case 'newest': result = text(b.date, a.date); break;
    case 'oldest': result = text(a.date, b.date); break;
    case 'title-az': result = text(a.title, b.title); break;
    case 'title-za': result = text(b.title, a.title); break;
    case 'label-az': result = text(a.label, b.label); break;
    case 'author-az': result = text(a.author, b.author); break;
    case 'number-asc': result = a.experimentNumber - b.experimentNumber || a.runNumber - b.runNumber; break;
    case 'number-desc': result = b.experimentNumber - a.experimentNumber || b.runNumber - a.runNumber; break;
  }
  return result || text(a.id, b.id);
}
module.exports = { EXPORT_ORDERS, normalizeOrder, compareRuns };
