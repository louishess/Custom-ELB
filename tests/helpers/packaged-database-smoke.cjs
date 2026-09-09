'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const { createRequire } = require('node:module');
const path = require('node:path');

async function main() {
  const [asarPath, workRoot] = process.argv.slice(2);
  assert.ok(asarPath, 'app.asar path is required');
  assert.ok(workRoot, 'temporary work root is required');

  const packedRequire = createRequire(path.join(asarPath, 'package.json'));
  for (const dependency of ['archiver', 'docx', 'exceljs', 'papaparse', 'yauzl', 'zod']) {
    assert.doesNotThrow(() => packedRequire(dependency), `packaged runtime cannot load ${dependency}`);
  }
  const Database = packedRequire('better-sqlite3');
  const databasePath = path.join(workRoot, 'library.sqlite');
  const backupPath = path.join(workRoot, 'library-backup.sqlite');
  fs.mkdirSync(workRoot, { recursive: true });

  let database = new Database(databasePath);
  database.pragma('journal_mode = WAL');
  database.exec('CREATE TABLE proof (id INTEGER PRIMARY KEY, value TEXT NOT NULL)');
  const insertBoth = database.transaction(() => {
    database.prepare('INSERT INTO proof (value) VALUES (?)').run('first');
    database.prepare('INSERT INTO proof (value) VALUES (?)').run('second');
  });
  insertBoth();
  await database.backup(backupPath);
  database.close();

  database = new Database(databasePath);
  assert.deepEqual(database.prepare('SELECT value FROM proof ORDER BY id').all(), [
    { value: 'first' },
    { value: 'second' },
  ]);
  database.close();

  const backup = new Database(backupPath, { readonly: true });
  assert.equal(backup.pragma('integrity_check', { simple: true }), 'ok');
  assert.equal(backup.prepare('SELECT count(*) AS count FROM proof').get().count, 2);
  backup.close();

  const { LibraryStore } = packedRequire('./electron/backend/store.cjs');
  const { createBackupService } = packedRequire('./electron/backend/backup.cjs');
  const { createFileService } = packedRequire('./electron/backend/files.cjs');
  const libraryRoot = path.join(workRoot, 'actual-library');
  const store = new LibraryStore(libraryRoot);
  const value = result => { assert.equal(result.ok, true, JSON.stringify(result.error)); return result.value; };
  try {
    const notebook = value(store.dispatch('records.createNotebook', { name: 'Packaged recovery', description: '', discipline: 'Chemistry', color: 'sage' })).notebooks[0];
    const run = value(store.dispatch('records.createExperiment', { notebookId: notebook.id, label: 'PKG', title: 'Before restore α', date: '2026-09-08', author: 'Test' })).runs[0];
    const source = path.join(workRoot, 'attachment.csv');
    fs.writeFileSync(source, 'label,value\nα,42\n');
    const files = createFileService(store);
    await files.importFiles({ runId: run.id, paths: [source], jobId: 'packaged-import' });
    const expected = store.snapshot();
    const destination = path.join(workRoot, 'backup-destination');
    fs.mkdirSync(destination);
    const recovery = createBackupService(store);
    const created = await recovery.create({ password: 'Disposable packaged password', destination, jobId: 'packaged-backup' });
    const archive = path.join(destination, created.name);
    assert.ok(fs.statSync(archive).size > 0);
    const current = store.snapshot().runs[0];
    value(store.dispatch('records.updateRun', { id: current.id, expectedRevision: current.revision, changes: { title: 'Changed after snapshot' } }));
    await assert.rejects(() => recovery.restore({ password: 'Wrong password', source: archive }));
    assert.equal(store.snapshot().runs[0].title, 'Changed after snapshot');
    const restored = await recovery.restore({ password: 'Disposable packaged password', source: archive, jobId: 'packaged-restore' });
    assert.deepEqual(restored.runs, expected.runs);
    assert.deepEqual(restored.attachments, expected.attachments);
    assert.equal(fs.readFileSync(files.getPath(restored.attachments[0].id), 'utf8'), 'label,value\nα,42\n');
    store.close(); store.reopen();
    assert.deepEqual(store.snapshot().runs, expected.runs);
  } finally { store.close(); }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
