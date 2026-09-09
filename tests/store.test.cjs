'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const BetterSqlite3 = require('better-sqlite3');
const { LibraryStore, EMPTY_DOCUMENT, recoverRestoreJournal } = require('../electron/backend/store.cjs');
const { RESTORE_JOURNAL_NAME } = require('../electron/backend/backup.cjs');

const stores = new Set();

function temporaryRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'labmate-store-test-'));
}

function openStore() {
  const root = temporaryRoot();
  const store = new LibraryStore(root);
  stores.add({ root, store });
  return { root, store };
}

test.afterEach(() => {
  for (const item of stores) {
    try { item.store.close(); } catch {}
    try { fs.rmSync(item.root, { recursive: true, force: true }); } catch {}
  }
  stores.clear();
});

function value(result) {
  assert.equal(result.ok, true, result.ok ? '' : JSON.stringify(result.error));
  return result.value;
}

function errorCode(result, code) {
  assert.equal(result.ok, false, 'expected an error result');
  assert.equal(result.error.code, code, result.error.message);
}

function createNotebook(store, name = 'Notebook') {
  const snapshot = value(store.dispatch('records.createNotebook', {
    name,
    description: 'A test notebook',
    discipline: 'Chemistry',
    color: 'sage',
  }));
  return snapshot.notebooks.find(item => item.name === name);
}

function createExperiment(store, notebookId, overrides = {}) {
  const snapshot = value(store.dispatch('records.createExperiment', {
    notebookId,
    label: overrides.label || 'Experiment',
    title: overrides.title || 'A first run',
    date: overrides.date || '2026-09-08',
    author: overrides.author || 'A. Researcher',
  }));
  const experiment = snapshot.experiments
    .filter(item => item.notebookId === notebookId)
    .sort((a, b) => b.experimentNumber - a.experimentNumber || b.createdAt.localeCompare(a.createdAt))[0];
  const run = snapshot.runs.find(item => item.experimentId === experiment.id);
  return { experiment, run };
}

function documentWithText(text) {
  return {
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
  };
}

function attachment(runId, hash, overrides = {}) {
  return {
    id: overrides.id || crypto.randomUUID(),
    runId,
    name: overrides.name || 'sample.bin',
    mime: overrides.mime || 'application/octet-stream',
    size: overrides.size ?? 4,
    hash,
    caption: overrides.caption || '',
    kind: overrides.kind || 'file',
    createdAt: overrides.createdAt || '2026-09-08T12:00:00.000Z',
  };
}

test('starts empty, persists through reopen, and keeps numbering monotonic after purge', () => {
  const { store } = openStore();
  const initial = store.snapshot();
  assert.deepEqual(initial.notebooks, []);
  assert.deepEqual(initial.experiments, []);
  assert.deepEqual(initial.runs, []);
  assert.equal(initial.schemaVersion, 2);
  assert.deepEqual(
    store.db.prepare('SELECT DISTINCT document_schema_version AS version FROM documents').all(),
    [],
  );
  assert.deepEqual(initial.preferences, {
    appearance: 0,
    palette: 'sage',
    layout: 'continuous',
    directoryView: 'grid',
    sort: 'newest',
  });
  assert.equal(store.db.pragma('foreign_keys', { simple: true }), 1);

  const notebook = createNotebook(store);
  const first = createExperiment(store, notebook.id, { label: 'Series A' });
  assert.deepEqual(
    store.db.prepare('SELECT DISTINCT document_schema_version AS version FROM documents').all(),
    [{ version: 1 }],
  );
  const second = createExperiment(store, notebook.id, { label: 'Series B' });
  assert.equal(first.experiment.experimentNumber, 1);
  assert.equal(second.experiment.experimentNumber, 2);

  let snapshot = value(store.dispatch('trash.move', {
    kind: 'experiment', id: first.experiment.id, expectedRevision: first.experiment.revision,
  }));
  const trashedFirst = snapshot.experiments.find(item => item.id === first.experiment.id);
  value(store.dispatch('trash.purge', {
    kind: 'experiment', id: first.experiment.id, expectedRevision: trashedFirst.revision,
  }));
  const third = createExperiment(store, notebook.id, { label: 'Series C' });
  assert.equal(third.experiment.experimentNumber, 3);

  snapshot = value(store.dispatch('records.repeatRun', { runId: second.run.id, date: '2026-09-09' }));
  const repeat = snapshot.runs.find(item => item.id !== second.run.id && item.experimentId === second.experiment.id);
  assert.equal(repeat.runNumber, 2);
  const movedRepeat = value(store.dispatch('trash.move', {
    kind: 'run', id: repeat.id, expectedRevision: repeat.revision,
  })).runs.find(item => item.id === repeat.id);
  value(store.dispatch('trash.purge', { kind: 'run', id: repeat.id, expectedRevision: movedRepeat.revision }));
  const nextRepeat = value(store.dispatch('records.repeatRun', { runId: second.run.id, date: '2026-09-10' })).runs
    .find(item => item.id !== second.run.id && item.experimentId === second.experiment.id && item.date === '2026-09-10');
  assert.equal(nextRepeat.runNumber, 3);

  const beforeReopen = store.snapshot();
  store.close();
  store.reopen();
  assert.deepEqual(store.snapshot(), beforeReopen);
  assert.equal(store.db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
});

test('validates dates and documents and rejects stale revisions without changing data', () => {
  const { store } = openStore();
  const notebook = createNotebook(store);
  let result = store.dispatch('records.createExperiment', {
    notebookId: notebook.id, label: 'Bad date', title: 'x', date: '2026-02-29', author: 'A',
  });
  errorCode(result, 'VALIDATION');
  result = store.dispatch('records.createExperiment', {
    notebookId: notebook.id, label: 'Good', title: 'x', date: '2026-02-28', author: 'A',
  });
  const run = value(result).runs[0];

  const loadedRevision = run.revision;
  result = store.dispatch('records.updateRun', {
    id: run.id, expectedRevision: loadedRevision, changes: { title: 'saved once' },
  });
  const updatedRun = value(result).runs[0];
  assert.equal(updatedRun.revision, loadedRevision + 1);
  result = store.dispatch('records.updateRun', {
    id: run.id, expectedRevision: loadedRevision, changes: { title: 'stale' },
  });
  errorCode(result, 'STALE_REVISION');
  result = store.dispatch('documents.save', {
    runId: run.id, expectedRevision: updatedRun.revision, documents: {
      information: { type: 'paragraph' },
      method: EMPTY_DOCUMENT,
      notes: EMPTY_DOCUMENT,
      data: EMPTY_DOCUMENT,
    },
  });
  errorCode(result, 'VALIDATION');
  assert.equal(store.snapshot().runs[0].revision, updatedRun.revision);
  result = store.dispatch('documents.save', {
    runId: run.id, expectedRevision: updatedRun.revision, documents: {
      information: documentWithText('saved'),
      method: EMPTY_DOCUMENT,
      notes: EMPTY_DOCUMENT,
      data: EMPTY_DOCUMENT,
    },
  });
  const savedRun = value(result).runs[0];
  assert.equal(savedRun.revision, updatedRun.revision + 1);
  result = store.dispatch('records.updateRun', {
    id: run.id, expectedRevision: updatedRun.revision, changes: { title: 'stale after save' },
  });
  errorCode(result, 'STALE_REVISION');
});

test('repeat copies information and method while resetting notes/data and memberships', () => {
  const { store } = openStore();
  const notebook = createNotebook(store);
  const { experiment, run } = createExperiment(store, notebook.id, { title: 'Source title', author: 'Source author' });
  const documents = {
    information: documentWithText('information copied'),
    method: documentWithText('method copied'),
    notes: documentWithText('notes must reset'),
    data: documentWithText('data must reset'),
  };
  value(store.dispatch('documents.save', { runId: run.id, expectedRevision: run.revision, documents }));
  const hash = 'a'.repeat(64);
  const objectPath = path.join(store.root, 'objects', hash);
  fs.writeFileSync(objectPath, 'shared bytes');
  store.addAttachment(attachment(run.id, hash));
  let snapshot = value(store.dispatch('schemes.create', { notebookId: notebook.id, name: 'Ordered', description: '' }));
  const scheme = snapshot.schemes[0];
  value(store.dispatch('schemes.update', { id: scheme.id, expectedRevision: scheme.revision, runIds: [run.id] }));

  snapshot = value(store.dispatch('records.repeatRun', { runId: run.id, date: '2026-09-10' }));
  const repeat = snapshot.runs.find(item => item.id !== run.id);
  assert.equal(repeat.title, run.title);
  assert.equal(repeat.author, run.author);
  assert.deepEqual(repeat.documents.information, documents.information);
  assert.deepEqual(repeat.documents.method, documents.method);
  assert.deepEqual(repeat.documents.notes, EMPTY_DOCUMENT);
  assert.deepEqual(repeat.documents.data, EMPTY_DOCUMENT);
  assert.equal(repeat.status, 'todo');
  assert.equal(snapshot.attachments.filter(item => item.runId === repeat.id).length, 0);
  assert.equal(snapshot.schemes[0].runIds.includes(repeat.id), false);
  assert.equal(fs.existsSync(objectPath), true);
  assert.equal(experiment.experimentNumber, repeat.experimentNumber);
});

test('enforces ancestor-aware trash restore and cascaded purge', () => {
  const { store } = openStore();
  const notebook = createNotebook(store);
  const { experiment, run } = createExperiment(store, notebook.id);
  const hash = 'b'.repeat(64);
  const objectPath = path.join(store.root, 'objects', hash);
  fs.writeFileSync(objectPath, 'purge me');
  store.addAttachment(attachment(run.id, hash));

  let snapshot = value(store.dispatch('trash.move', {
    kind: 'run', id: run.id, expectedRevision: run.revision,
  }));
  const independentlyTrashedRun = snapshot.runs.find(item => item.id === run.id);
  snapshot = value(store.dispatch('trash.move', {
    kind: 'notebook', id: notebook.id, expectedRevision: notebook.revision,
  }));
  const trashedNotebook = snapshot.notebooks.find(item => item.id === notebook.id);
  const visibleExperiment = snapshot.experiments.find(item => item.id === experiment.id);
  const trashedRun = snapshot.runs.find(item => item.id === run.id);
  assert.ok(trashedNotebook.trashedAt);
  assert.equal(visibleExperiment.trashedAt, null);
  assert.equal(trashedRun.trashedAt, independentlyTrashedRun.trashedAt);
  assert.equal(trashedRun.revision, independentlyTrashedRun.revision);
  errorCode(store.dispatch('trash.restore', { kind: 'run', id: run.id, expectedRevision: trashedRun.revision }), 'VALIDATION');

  snapshot = value(store.dispatch('trash.restore', { kind: 'notebook', id: notebook.id, expectedRevision: trashedNotebook.revision }));
  const restoredNotebook = snapshot.notebooks.find(item => item.id === notebook.id);
  assert.equal(restoredNotebook.trashedAt, null);
  const restoredRun = value(store.dispatch('trash.restore', {
    kind: 'run', id: run.id, expectedRevision: independentlyTrashedRun.revision,
  })).runs.find(item => item.id === run.id);
  assert.equal(restoredRun.trashedAt, null);

  // Parent purge cascades even when its descendants are independently active.
  const moved = value(store.dispatch('trash.move', { kind: 'notebook', id: notebook.id, expectedRevision: restoredNotebook.revision }));
  const trashedAgain = moved.notebooks.find(item => item.id === notebook.id);
  snapshot = value(store.dispatch('trash.purge', { kind: 'notebook', id: notebook.id, expectedRevision: trashedAgain.revision }));
  assert.equal(snapshot.notebooks.some(item => item.id === notebook.id), false);
  assert.equal(snapshot.experiments.some(item => item.id === experiment.id), false);
  assert.equal(snapshot.runs.some(item => item.id === run.id), false);
  assert.equal(snapshot.attachments.some(item => item.runId === run.id), false);
  assert.equal(fs.existsSync(objectPath), false);
});

test('keeps shared attachment objects until the final metadata reference is gone', () => {
  const { store } = openStore();
  const notebook = createNotebook(store);
  const first = createExperiment(store, notebook.id);
  const second = createExperiment(store, notebook.id, { label: 'Second' });
  const hash = 'c'.repeat(64);
  const objectPath = path.join(store.root, 'objects', hash);
  fs.writeFileSync(objectPath, 'shared');
  const one = attachment(first.run.id, hash);
  const two = attachment(second.run.id, hash);
  const addedOne = store.addAttachment(one);
  assert.equal(addedOne.schemaVersion, 2);
  assert.equal(addedOne.attachments.some(item => item.id === one.id), true);
  assert.throws(() => store.addAttachment(one), error => error && error.code === 'VALIDATION');
  const addedTwo = store.addAttachment(two);
  assert.equal(addedTwo.attachments.length, 2);
  assert.equal(store.getAttachment(one.id).hash, hash);
  assert.throws(() => store.getAttachment(crypto.randomUUID()), error => error && error.code === 'NOT_FOUND');
  const captioned = store.updateAttachment(one.id, 'captioned');
  assert.equal(captioned.attachments.find(item => item.id === one.id).caption, 'captioned');
  assert.equal(store.getAttachment(one.id).caption, 'captioned');
  const removedOne = store.removeAttachment(one.id);
  assert.equal(removedOne.attachments.some(item => item.id === one.id), false);
  assert.equal(fs.existsSync(objectPath), true);
  const removedTwo = store.removeAttachment(two.id);
  assert.equal(removedTwo.attachments.length, 0);
  assert.equal(fs.existsSync(objectPath), false);
  assert.throws(() => store.updateAttachment(two.id, 'missing'), error => error && error.code === 'NOT_FOUND');
  assert.throws(() => store.removeAttachment(two.id), error => error && error.code === 'NOT_FOUND');

  const three = attachment(first.run.id, hash);
  const four = attachment(second.run.id, hash);
  fs.writeFileSync(objectPath, 'shared again');
  store.addAttachment(three);
  store.addAttachment(four);
  store.backupLocks = 1;
  store.removeAttachment(three.id);
  store.removeAttachment(four.id);
  assert.equal(fs.existsSync(objectPath), true);
  store.backupLocks = 0;
});

test('stores overlapping ordered schemes and preferences with same-notebook validation', () => {
  const { store } = openStore();
  const notebook = createNotebook(store);
  const otherNotebook = createNotebook(store, 'Other');
  const first = createExperiment(store, notebook.id);
  const second = createExperiment(store, notebook.id, { label: 'Second' });
  const outside = createExperiment(store, otherNotebook.id, { label: 'Outside' });
  let snapshot = value(store.dispatch('schemes.create', {
    notebookId: notebook.id,
    name: 'Route',
    description: 'ordered',
    runIds: [second.run.id, first.run.id],
  }));
  const scheme = snapshot.schemes.find(item => item.name === 'Route');
  assert.deepEqual(scheme.runIds, [second.run.id, first.run.id]);
  snapshot = value(store.dispatch('schemes.create', {
    notebookId: notebook.id,
    name: 'Overlapping route',
    description: '',
    runIds: [first.run.id],
  }));
  assert.equal(snapshot.schemes.length, 2);
  assert.deepEqual(snapshot.schemes.find(item => item.name === 'Overlapping route').runIds, [first.run.id]);
  errorCode(store.dispatch('schemes.create', {
    notebookId: notebook.id,
    name: 'Invalid route',
    description: '',
    runIds: [outside.run.id],
  }), 'VALIDATION');
  assert.equal(store.snapshot().schemes.length, 2, 'invalid membership must roll back scheme creation');
  snapshot = value(store.dispatch('schemes.update', {
    id: scheme.id, expectedRevision: scheme.revision, runIds: [first.run.id, second.run.id],
  }));
  const updatedScheme = snapshot.schemes.find(item => item.id === scheme.id);
  assert.deepEqual(updatedScheme.runIds, [first.run.id, second.run.id]);
  errorCode(store.dispatch('schemes.update', {
    id: scheme.id, expectedRevision: updatedScheme.revision, runIds: [first.run.id, first.run.id],
  }), 'VALIDATION');
  errorCode(store.dispatch('schemes.update', {
    id: scheme.id, expectedRevision: updatedScheme.revision, runIds: [outside.run.id],
  }), 'VALIDATION');
  snapshot = value(store.dispatch('preferences.update', {
    appearance: 72, layout: 'tabs', directoryView: 'list', sort: 'number-asc',
  }));
  assert.deepEqual(snapshot.preferences, { appearance: 72, palette: 'sage', layout: 'tabs', directoryView: 'list', sort: 'number-asc' });
  store.close();
  store.reopen();
  assert.deepEqual(store.snapshot().preferences, snapshot.preferences);
  assert.deepEqual(store.snapshot().schemes.find(item => item.id === scheme.id).runIds, [first.run.id, second.run.id]);
});

test('cleans staging on startup, creates a consistent database backup, and preserves failed migration state', async () => {
  const { root, store } = openStore();
  const notebook = createNotebook(store);
  const backupPath = path.join(root, 'nested', 'library-copy.sqlite');
  const restoreCandidate = path.join(root, 'staging', 'backup-restore-candidate', 'library.sqlite');
  fs.mkdirSync(path.dirname(restoreCandidate), { recursive: true });
  fs.writeFileSync(restoreCandidate, 'candidate');
  fs.writeFileSync(path.join(root, 'staging', 'orphan.tmp'), 'temporary');
  store.close();
  store.reopen();
  assert.equal(fs.existsSync(restoreCandidate), true);
  assert.equal(fs.existsSync(path.join(root, 'staging', 'orphan.tmp')), true);
  createExperiment(store, notebook.id);
  const backupRun = store.snapshot().runs[0];
  store.db.prepare(`INSERT INTO citation_associations
    (id, run_id, source_instance, library_id, item_key, snapshot_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
    crypto.randomUUID(), backupRun.id, 'instance', 'library', 'ITEM-1', '{}', '2026-09-08T12:00:00.000Z',
  );
  const backup = await store.backupDatabase(backupPath);
  assert.equal(path.resolve(backup.destination), path.resolve(backupPath));
  assert.equal(store.backupLocks, 0);
  const copy = new BetterSqlite3(backupPath, { readonly: true });
  assert.equal(copy.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  assert.equal(copy.prepare('SELECT COUNT(*) AS count FROM notebooks').get().count, 1);
  assert.equal(copy.prepare('SELECT COUNT(*) AS count FROM citation_associations').get().count, 1);
  copy.close();

  store.close();
  const freshStore = new LibraryStore(root);
  stores.add({ root, store: freshStore });
  assert.equal(fs.existsSync(restoreCandidate), false);
  assert.equal(fs.existsSync(path.join(root, 'staging', 'orphan.tmp')), false);
  freshStore.close();

  const brokenRoot = temporaryRoot();
  const brokenDb = new BetterSqlite3(path.join(brokenRoot, 'library.sqlite'));
  brokenDb.pragma('user_version = 99');
  brokenDb.close();
  assert.throws(() => new LibraryStore(brokenRoot), error => error && error.code === 'CORRUPT_BACKUP');
  const check = new BetterSqlite3(path.join(brokenRoot, 'library.sqlite'), { readonly: true });
  assert.equal(check.pragma('user_version', { simple: true }), 99);
  check.close();
  fs.rmSync(brokenRoot, { recursive: true, force: true });
});

test('recovers every restore journal phase before opening SQLite', () => {
  const phases = ['prepared', 'db-moved', 'objects-moved', 'candidate-db-moved', 'candidate-objects-moved', 'opened', 'committed'];
  for (const phase of phases) {
    const root = temporaryRoot();
    const store = new LibraryStore(root);
    stores.add({ root, store });
    const liveDb = store.databasePath;
    const liveObjects = path.join(root, 'objects');
    store.close();
    const oldDb = path.join(root, 'rollback-journal', `${phase}-old.sqlite`);
    const oldObjects = path.join(root, 'rollback-journal', `${phase}-old-objects`);
    const candidateDb = path.join(root, 'staging', `backup-restore-${phase}`, 'library.sqlite');
    const candidateObjects = path.join(root, 'staging', `backup-restore-${phase}`, 'objects');
    const rollbackPath = path.join(root, 'rollback-journal', `${phase}-rollback`);
    fs.mkdirSync(path.dirname(oldDb), { recursive: true });
    fs.mkdirSync(path.dirname(candidateDb), { recursive: true });
    fs.mkdirSync(rollbackPath, { recursive: true });
    fs.writeFileSync(candidateDb, 'candidate');
    fs.mkdirSync(candidateObjects, { recursive: true });
    if (phase !== 'prepared' && phase !== 'opened' && phase !== 'committed') {
      fs.renameSync(liveDb, oldDb);
      fs.renameSync(liveObjects, oldObjects);
    } else if (phase === 'opened' || phase === 'committed') {
      fs.writeFileSync(oldDb, 'old');
      fs.mkdirSync(oldObjects, { recursive: true });
    }
    const relative = item => path.relative(root, item);
    const journalFile = path.join(root, RESTORE_JOURNAL_NAME);
    fs.mkdirSync(path.dirname(journalFile), { recursive: true });
    fs.writeFileSync(journalFile, JSON.stringify({
      version: 1,
      phase,
      dbPath: relative(liveDb),
      objectsPath: relative(liveObjects),
      oldDb: relative(oldDb),
      oldObjects: relative(oldObjects),
      candidateDb: relative(candidateDb),
      candidateObjects: relative(candidateObjects),
      rollbackPath: relative(rollbackPath),
    }));
    const recovered = recoverRestoreJournal(root);
    assert.equal(recovered.recovered, true);
    assert.equal(fs.existsSync(journalFile), false);
    if (phase === 'prepared' || phase === 'opened' || phase === 'committed') {
      assert.equal(fs.existsSync(liveDb), true);
    } else {
      assert.equal(fs.existsSync(liveDb), true);
      assert.equal(fs.existsSync(oldDb), false);
    }
    assert.equal(fs.existsSync(rollbackPath), phase === 'opened' || phase === 'committed');
    const reopened = new LibraryStore(root);
    stores.add({ root, store: reopened });
    assert.equal(reopened.db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    reopened.close();
  }
});

test('rejects crafted foreign-key corruption without rewriting the database', () => {
  const root = temporaryRoot();
  const initial = new LibraryStore(root);
  initial.close();
  const database = new BetterSqlite3(path.join(root, 'library.sqlite'));
  database.pragma('foreign_keys = OFF');
  database.prepare(`INSERT INTO runs
    (id, notebook_id, experiment_id, label, experiment_number, run_number, title, date, author, status, revision, created_at, updated_at, trashed_at)
    VALUES (?, ?, ?, ?, 1, 1, ?, ?, ?, 'todo', 1, ?, ?, NULL)`).run(
    crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID(), 'Corrupt', 'Corrupt', '2026-09-08', 'Tester',
    '2026-09-08T12:00:00.000Z', '2026-09-08T12:00:00.000Z',
  );
  database.close();
  assert.throws(() => new LibraryStore(root), error => error && error.code === 'CORRUPT_BACKUP');
  const check = new BetterSqlite3(path.join(root, 'library.sqlite'), { readonly: true });
  assert.equal(check.prepare('SELECT COUNT(*) AS count FROM runs').get().count, 1);
  assert.ok(check.prepare('PRAGMA foreign_key_check').all().length > 0);
  check.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test('creates storage-only citation associations and cascades them with a purged run', () => {
  const { store } = openStore();
  const notebook = createNotebook(store);
  const { run } = createExperiment(store, notebook.id);
  const columns = store.db.prepare('PRAGMA table_info(citation_associations)').all().map(row => row.name);
  assert.deepEqual(columns, ['id', 'run_id', 'source_instance', 'library_id', 'item_key', 'snapshot_json', 'created_at']);
  const associationId = crypto.randomUUID();
  store.db.prepare(`INSERT INTO citation_associations
    (id, run_id, source_instance, library_id, item_key, snapshot_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
    associationId, run.id, 'zotero-instance', 'library-1', 'ABCD1234', '{"title":"Example"}', '2026-09-08T12:00:00.000Z',
  );
  assert.throws(() => store.db.prepare(`INSERT INTO citation_associations
    (id, run_id, source_instance, library_id, item_key, snapshot_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
    crypto.randomUUID(), run.id, 'zotero-instance', 'library-1', 'ABCD1234', '{}', '2026-09-08T12:00:00.000Z',
  ));
  const trashed = value(store.dispatch('trash.move', { kind: 'run', id: run.id, expectedRevision: run.revision })).runs.find(item => item.id === run.id);
  value(store.dispatch('trash.purge', { kind: 'run', id: run.id, expectedRevision: trashed.revision }));
  assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM citation_associations WHERE id=?').get(associationId).count, 0);
});

test('cleans only safe unreferenced object orphans on a fresh startup', () => {
  const { root, store } = openStore();
  const notebook = createNotebook(store);
  const { run } = createExperiment(store, notebook.id);
  const orphanHash = 'd'.repeat(64);
  const referencedHash = 'e'.repeat(64);
  const symlinkHash = 'f'.repeat(64);
  fs.writeFileSync(path.join(root, 'objects', orphanHash), 'orphan');
  fs.writeFileSync(path.join(root, 'objects', referencedHash), 'referenced');
  fs.writeFileSync(path.join(root, 'objects', 'keep-me.txt'), 'unknown name');
  fs.symlinkSync(path.join(root, 'objects', 'keep-me.txt'), path.join(root, 'objects', symlinkHash));
  store.addAttachment(attachment(run.id, referencedHash));
  store.close();
  const fresh = new LibraryStore(root);
  stores.add({ root, store: fresh });
  assert.equal(fs.existsSync(path.join(root, 'objects', orphanHash)), false);
  assert.equal(fs.existsSync(path.join(root, 'objects', referencedHash)), true);
  assert.equal(fs.existsSync(path.join(root, 'objects', 'keep-me.txt')), true);
  assert.equal(fs.lstatSync(path.join(root, 'objects', symlinkHash)).isSymbolicLink(), true);
  fresh.close();
});

test('rolls back all document writes and the run revision after a mid-transaction failure', () => {
  const { store } = openStore();
  const notebook = createNotebook(store);
  const { run } = createExperiment(store, notebook.id);
  const before = store.snapshot().runs[0];
  store.db.exec(`CREATE TRIGGER injected_document_failure
    BEFORE UPDATE ON documents
    WHEN NEW.section_id = 'notes'
    BEGIN SELECT RAISE(ABORT, 'injected document failure'); END`);
  const result = store.dispatch('documents.save', {
    runId: run.id,
    expectedRevision: run.revision,
    documents: {
      information: documentWithText('new information'),
      method: documentWithText('new method'),
      notes: documentWithText('new notes'),
      data: documentWithText('new data'),
    },
  });
  errorCode(result, 'IO');
  const after = store.snapshot().runs[0];
  assert.equal(after.revision, before.revision);
  assert.deepEqual(after.documents, before.documents);
});

test('schema 1 libraries migrate transactionally to sage and retain records and preferences', () => {
  const {root, store} = openStore();
  const notebook = createNotebook(store, 'Legacy notebook');
  value(store.dispatch('preferences.update', {appearance: 42}));
  store.close();
  const legacy = new BetterSqlite3(path.join(root, 'library.sqlite'));
  legacy.exec('ALTER TABLE preferences DROP COLUMN palette');
  legacy.pragma('user_version = 1');
  legacy.close();
  store.reopen();
  const migrated = store.snapshot();
  assert.equal(migrated.schemaVersion, 2);
  assert.equal(migrated.notebooks[0].id, notebook.id);
  assert.equal(migrated.preferences.appearance, 42);
  assert.equal(migrated.preferences.palette, 'sage');
  value(store.dispatch('preferences.update', {palette: 'ocean'}));
  store.close(); store.reopen();
  assert.equal(store.snapshot().preferences.palette, 'ocean');
  errorCode(store.dispatch('preferences.update', {palette: 'unrecognized'}), 'VALIDATION');
});
