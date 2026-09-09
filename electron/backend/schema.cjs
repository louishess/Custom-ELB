'use strict';

const V1_COLUMNS = {
  notebooks: ['id', 'name', 'description', 'discipline', 'color', 'revision', 'created_at', 'updated_at', 'trashed_at'],
  experiments: ['id', 'notebook_id', 'label', 'experiment_number', 'revision', 'created_at', 'updated_at', 'trashed_at'],
  runs: ['id', 'notebook_id', 'experiment_id', 'label', 'experiment_number', 'run_number', 'title', 'date', 'author', 'status', 'revision', 'created_at', 'updated_at', 'trashed_at'],
  documents: ['run_id', 'section_id', 'document_schema_version', 'json'],
  attachments: ['id', 'run_id', 'name', 'mime', 'size', 'hash', 'caption', 'kind', 'created_at'],
  citation_associations: ['id', 'run_id', 'source_instance', 'library_id', 'item_key', 'snapshot_json', 'created_at'],
  schemes: ['id', 'notebook_id', 'name', 'description', 'revision', 'created_at'],
  scheme_members: ['scheme_id', 'run_id', 'position'],
  counters: ['key', 'next_number'],
  preferences: ['id', 'appearance', 'layout', 'directory_view', 'sort'],
};

const SCHEMA_VERSION = 2;
const PALETTES = Object.freeze(['sage', 'ocean', 'lavender', 'terracotta', 'rose', 'graphite']);
function columnsForVersion(version) {
  if (version !== 1 && version !== 2) throw new Error('Unsupported library schema');
  return { ...V1_COLUMNS, preferences: version === 1 ? V1_COLUMNS.preferences : [...V1_COLUMNS.preferences, 'palette'] };
}
module.exports = { SCHEMA_VERSION, PALETTES, columnsForVersion };
