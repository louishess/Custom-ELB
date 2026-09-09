const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');

function loadTypeScriptModule(relativePath) {
  const filename = path.resolve(__dirname, '..', relativePath);
  const source = fs.readFileSync(filename, 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
    fileName: filename,
  }).outputText;
  const module = { exports: {} };
  new Function('exports', 'module', 'require', '__filename', '__dirname', output)(
    module.exports,
    module,
    require,
    filename,
    path.dirname(filename),
  );
  return module.exports;
}

const workflows = loadTypeScriptModule('src/workflows.ts');
const { createAutosaveScheduler } = loadTypeScriptModule('src/autosave.ts');

function doc(text) {
  return { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] };
}

function run(id, overrides = {}) {
  return {
    id,
    notebookId: 'notebook-1',
    experimentId: 'experiment-1',
    label: 'Series',
    experimentNumber: 1,
    runNumber: 1,
    title: 'Run',
    date: '2026-01-01',
    author: 'Researcher',
    status: 'todo',
    documents: { information: doc('information'), method: doc('method'), notes: doc('notes'), data: doc('data') },
    revision: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    trashedAt: null,
    ...overrides,
  };
}

function snapshot(overrides = {}) {
  return {
    schemaVersion: 1,
    notebooks: [{ id: 'notebook-1', name: 'Notebook', description: '', discipline: '', color: 'sage', revision: 1, createdAt: '', updatedAt: '', trashedAt: null }],
    experiments: [{ id: 'experiment-1', notebookId: 'notebook-1', label: 'Series', experimentNumber: 1, revision: 1, createdAt: '', updatedAt: '', trashedAt: null }],
    runs: [],
    attachments: [],
    schemes: [],
    preferences: { appearance: 0, layout: 'continuous', directoryView: 'grid', sort: 'newest' },
    ...overrides,
  };
}

test('autosave flush serializes an edit arriving while a save is in flight', async () => {
  const resolvers = [];
  const values = [];
  const states = [];
  const scheduler = createAutosaveScheduler({
    idleMs: 60_000,
    maxMs: 60_000,
    onState: state => states.push(state),
    save: value => new Promise(resolve => {
      values.push(value);
      resolvers.push(resolve);
    }),
  });

  scheduler.markDirty('first');
  const flush = scheduler.flush();
  await Promise.resolve();
  assert.deepEqual(values, ['first']);
  scheduler.markDirty('second');
  resolvers.shift()();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(values, ['first', 'second']);
  assert.notEqual(states.at(-1), 'saved');
  resolvers.shift()();
  assert.equal(await flush, true);
  assert.equal(states.at(-1), 'saved');
  assert.equal(scheduler.isDirty(), false);
  scheduler.dispose();
});

test('failed autosave retains the latest draft for an explicit retry', async () => {
  let fail = true;
  const values = [];
  const scheduler = createAutosaveScheduler({
    idleMs: 60_000,
    maxMs: 60_000,
    save: async value => {
      values.push(value);
      if (fail) throw Object.assign(new Error('disk full'), { code: 'IO' });
    },
  });
  scheduler.markDirty('kept draft');
  assert.equal(await scheduler.flush(), false);
  assert.equal(scheduler.isDirty(), true);
  fail = false;
  assert.equal(await scheduler.flush(), true);
  assert.deepEqual(values, ['kept draft', 'kept draft']);
  scheduler.dispose();
});

test('numeric sorting compares experiment then run and uses stable IDs', () => {
  const items = [
    run('run-c', { experimentNumber: 10, runNumber: 1 }),
    run('run-b', { experimentNumber: 2, runNumber: 10 }),
    run('run-a', { experimentNumber: 2, runNumber: 2 }),
    run('run-d', { experimentNumber: 2, runNumber: 2 }),
  ];
  assert.deepEqual(
    items.sort((a, b) => workflows.compareRuns(a, b, 'number-asc')).map(item => item.id),
    ['run-a', 'run-d', 'run-b', 'run-c'],
  );
});

test('scheme view contains only active members in persisted order', () => {
  const first = run('run-1', { title: 'First' });
  const second = run('run-2', { title: 'Second', runNumber: 2 });
  const outsider = run('run-3', { title: 'Outsider', runNumber: 3 });
  const state = snapshot({
    runs: [first, second, outsider],
    schemes: [{ id: 'scheme-1', notebookId: 'notebook-1', name: 'Scheme', description: '', runIds: ['run-2', 'run-1'], revision: 1 }],
  });
  assert.deepEqual(
    workflows.runsForNotebook(state, 'notebook-1', 'scheme-1', '', 'scheme').map(item => item.id),
    ['run-2', 'run-1'],
  );
});

test('search includes rich document text and trashed ancestors hide descendants', () => {
  const item = run('run-1', { documents: { information: doc('unique catalyst phrase'), method: doc(''), notes: doc(''), data: doc('') } });
  const state = snapshot({ runs: [item] });
  assert.deepEqual(workflows.runsForNotebook(state, 'notebook-1', null, 'CATALYST', 'newest').map(entry => entry.id), ['run-1']);
  const hiddenExperiment = snapshot({ runs: [item], experiments: [{ ...state.experiments[0], trashedAt: '2026-01-02T00:00:00.000Z' }] });
  assert.deepEqual(workflows.runsForNotebook(hiddenExperiment, 'notebook-1', null, '', 'newest'), []);
  const hiddenNotebook = snapshot({ runs: [item], notebooks: [{ ...state.notebooks[0], trashedAt: '2026-01-02T00:00:00.000Z' }] });
  assert.deepEqual(workflows.runsForNotebook(hiddenNotebook, 'notebook-1', null, '', 'newest'), []);
});

test('Trash marks a child whose parent must be restored first', () => {
  const state = snapshot({
    experiments: [{ ...snapshot().experiments[0], trashedAt: '2026-01-02T00:00:00.000Z' }],
    runs: [run('run-1', { trashedAt: '2026-01-03T00:00:00.000Z' })],
  });
  const item = workflows.activeTrash(state).find(candidate => candidate.kind === 'run');
  assert.equal(item.ancestorId, 'experiment-1');
  assert.equal(item.ancestorName, 'Series');
});
