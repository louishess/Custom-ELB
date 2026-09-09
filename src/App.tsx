import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ArrowDownUp, ArrowLeft, ArrowRight, BookOpen, CalendarDays, ChevronDown, ChevronRight, Columns3, FileText, FlaskConical, FolderOpen, GitBranch, Grid2X2, LayoutList, Library, List, Plus, Quote, Repeat2, Search, Settings, SlidersHorizontal, Trash2, Upload, UserRound, WifiOff, X } from 'lucide-react';
import { CitationChips, EntrySections, SectionNavigation } from './components';
import { cloneDemoSnapshot, entryCode, formatDate, sortOptions } from './fixtures';
import { Panels } from './panels';
import Tracker from './Tracker';
import { applyAppearance } from './appearance';
import { createAutosaveScheduler, type SaveState } from './autosave';
import { cloneDocuments, isActiveRun, newJobId, normalizeSort, runsForNotebook } from './workflows';
import type { Entry, EntryLayout, LibrarySnapshot, Panel, SectionId, SnapshotState } from './types';

export default function App() {
  const queryDemo = new URLSearchParams(window.location.search).get('demo') === '1';
  const [mode, setMode] = useState<'real' | 'demo'>(queryDemo ? 'demo' : 'real');
  const [state, setState] = useState<SnapshotState>(() => queryDemo ? { status: 'ready', snapshot: cloneDemoSnapshot() } : { status: 'loading' });
  const [page, setPage] = useState<'notebooks' | 'tracker'>('notebooks');
  const [notebookId, setNotebookId] = useState<string | null>(null);
  const [entryId, setEntryId] = useState<string | null>(null);
  const [schemeId, setSchemeId] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState('newest');
  const [layout, setLayout] = useState<EntryLayout>('continuous');
  const [appearance, setAppearance] = useState(0);
  const [directoryView, setDirectoryView] = useState<'grid' | 'list'>('grid');
  const [activeSection, setActiveSection] = useState<SectionId>('information');
  const [panel, setPanel] = useState<Panel | null>(null);
  const [draftDocuments, setDraftDocuments] = useState<LibrarySnapshot['runs'][number]['documents'] | null>(null);
  const [saveState, setSaveState] = useState<SaveState>('saved');
  const [resetToken, setResetToken] = useState(0);
  const [error, setError] = useState('');
  const [retryCount, setRetryCount] = useState(0);
  const [progress, setProgress] = useState<{ jobId: string; operation: string; phase: string; completed?: number; total?: number; message?: string } | null>(null);
  const contentPane = useRef<HTMLDivElement>(null);
  const currentRunRef = useRef<Entry | null>(null);
  const expectedRevisionRef = useRef<number>(0);
  const schedulerRef = useRef<ReturnType<typeof createAutosaveScheduler<LibrarySnapshot['runs'][number]['documents']>> | null>(null);
  const initializedPrefs = useRef(false);

  const snapshot = state.status === 'ready' ? state.snapshot : null;
  const notebook = snapshot?.notebooks.find(item => item.id === notebookId && !item.trashedAt);
  const baseEntry = snapshot?.runs.find(item => item.id === entryId && isActiveRun(snapshot, item)) ?? null;
  const entry = baseEntry ? { ...baseEntry, attachments: snapshot?.attachments.filter(attachment => attachment.runId === baseEntry.id) ?? [] } : null;
  const notebookSchemes = snapshot?.schemes.filter(item => item.notebookId === notebookId) ?? [];
  const scheme = notebookSchemes.find(item => item.id === schemeId);
  const visibleEntries = notebook && snapshot ? runsForNotebook(snapshot, notebook.id, scheme?.id ?? null, search, sort) : [];

  useLayoutEffect(() => { applyAppearance(appearance, snapshot?.preferences.palette ?? 'sage'); }, [appearance, snapshot?.preferences.palette]);

  useEffect(() => {
    if (mode === 'demo') return;
    let cancelled = false;
    const load = async () => {
      setState({ status: 'loading' });
      const result = await window.labmate?.records.snapshot(undefined);
      if (cancelled) return;
      if (!result) { setState({ status: 'error', message: 'LabMate could not connect to its local library.' }); return; }
      if (result.ok) {
        setState({ status: 'ready', snapshot: result.value });
        if (!initializedPrefs.current) {
          initializedPrefs.current = true;
          setAppearance(result.value.preferences.appearance);
          setLayout(result.value.preferences.layout);
          setDirectoryView(result.value.preferences.directoryView);
          setSort(normalizeSort(result.value.preferences.sort));
        }
      } else setState({ status: 'error', message: result.error.message });
    };
    void load();
    return () => { cancelled = true; };
  }, [mode, retryCount]);

  useEffect(() => {
    const unsubscribe = window.labmate?.onProgress(event => setProgress(event.phase === 'complete' ? null : event));
    return unsubscribe;
  }, []);

  const saveDocuments = async (documents: LibrarySnapshot['runs'][number]['documents']) => {
    if (mode === 'demo') return;
    const run = currentRunRef.current;
    if (!run) return;
    const result = await window.labmate?.documents.save({ runId: run.id, expectedRevision: expectedRevisionRef.current, documents });
    if (!result) throw Object.assign(new Error('LabMate bridge unavailable.'), { code: 'UNAVAILABLE' });
    if (!result.ok) throw Object.assign(new Error(result.error.message), { code: result.error.code });
    const updated = result.value.runs.find(item => item.id === run.id);
    if (updated) { expectedRevisionRef.current = updated.revision; currentRunRef.current = updated; }
    setState({ status: 'ready', snapshot: result.value });
  };

  useLayoutEffect(() => {
    const run = entry;
    schedulerRef.current?.dispose(); schedulerRef.current = null;
    if (!run) { currentRunRef.current = null; setDraftDocuments(null); setSaveState('saved'); return; }
    currentRunRef.current = run;
    expectedRevisionRef.current = run.revision;
    setDraftDocuments(cloneDocuments(run.documents));
    setResetToken(value => value + 1);
    setSaveState('saved');
    schedulerRef.current = createAutosaveScheduler({ save: saveDocuments, onState: setSaveState });
    return () => { schedulerRef.current?.dispose(); schedulerRef.current = null; };
  }, [entry?.id, mode]);

  useEffect(() => {
    const unsubscribe = window.labmate?.onBeforeClose(async () => {
      const scheduler = schedulerRef.current;
      return scheduler ? scheduler.flush() : true;
    });
    return unsubscribe;
  }, []);

  function applySnapshot(next: LibrarySnapshot) {
    setState({ status: 'ready', snapshot: next });
    const currentId = currentRunRef.current?.id;
    if (currentId) {
      const updated = next.runs.find(run => run.id === currentId);
      if (updated) {
        currentRunRef.current = { ...updated, attachments: next.attachments.filter(attachment => attachment.runId === updated.id) };
        expectedRevisionRef.current = updated.revision;
      }
    }
    setError('');
  }

  async function flushDraft(): Promise<boolean> {
    const scheduler = schedulerRef.current;
    if (!scheduler) return true;
    const ok = await scheduler.flush();
    return ok;
  }

  function replaceRestoredLibrary(next: LibrarySnapshot) {
    // A restore can retain record IDs while replacing their documents. Drop
    // all old drafts/editor instances rather than treating it as a mutation.
    schedulerRef.current?.dispose();
    schedulerRef.current = null;
    currentRunRef.current = null;
    expectedRevisionRef.current = 0;
    setDraftDocuments(null);
    setSaveState('saved');
    setPanel(null);
    setPage('notebooks');
    setNotebookId(null); setEntryId(null); setSchemeId(null); setSearch('');
    setState({ status: 'ready', snapshot: next });
    setAppearance(next.preferences.appearance);
    setLayout(next.preferences.layout);
    setDirectoryView(next.preferences.directoryView);
    setSort(normalizeSort(next.preferences.sort));
    setProgress(null); setError('');
  }

  async function refreshCurrentRun(): Promise<Entry | null> {
    if (mode === 'demo' || !entryId) return null;
    const result = await window.labmate?.records.snapshot(undefined);
    if (!result) { setError('The local library bridge is unavailable.'); return null; }
    if (!result.ok) { setError(result.error.message); return null; }
    const fresh = result.value.runs.find(run => run.id === entryId && isActiveRun(result.value, run));
    if (!fresh) { applySnapshot(result.value); setError('This run is no longer available in the active library.'); return null; }
    applySnapshot(result.value);
    return { ...fresh, attachments: result.value.attachments.filter(attachment => attachment.runId === fresh.id) };
  }

  async function openNotebook(id: string, selectedEntryId?: string) {
    if (!(await flushDraft())) return;
    const nextNotebook = snapshot?.notebooks.find(item => item.id === id && !item.trashedAt);
    if (!nextNotebook) return;
    const first = selectedEntryId ?? runsForNotebook(snapshot!, id, null, '', sort)[0]?.id ?? null;
    setPage('notebooks'); setNotebookId(id); setSchemeId(null); setSearch(''); setSort(normalizeSort(snapshot?.preferences.sort ?? sort)); setEntryId(first); setActiveSection('information'); contentPane.current?.scrollTo({ top: 0 });
  }

  async function openEntry(id: string) {
    if (!(await flushDraft())) return;
    setEntryId(id); setActiveSection('information'); contentPane.current?.scrollTo({ top: 0 });
  }

  async function openScheme(id: string) {
    if (!(await flushDraft())) return;
    const selected = snapshot?.schemes.find(item => item.id === id);
    if (!selected) return;
    const first = runsForNotebook(snapshot!, selected.notebookId, id, '', 'scheme')[0]?.id ?? null;
    setPage('notebooks'); setNotebookId(selected.notebookId); setSchemeId(id); setSort('scheme'); setEntryId(first); setActiveSection('information');
  }

  async function openDirectory() {
    if (!(await flushDraft())) return;
    setPage('notebooks'); setNotebookId(null); setEntryId(null); setSchemeId(null);
  }

  async function openTracker() {
    if (!(await flushDraft())) return;
    setPage('tracker');
  }

  async function updatePreference(changes: Partial<LibrarySnapshot['preferences']>) {
    if (changes.sort) setSort(normalizeSort(changes.sort));
    if (mode === 'demo') {
      if (!snapshot) return;
      applySnapshot({ ...snapshot, preferences: { ...snapshot.preferences, ...changes } });
      return;
    }
    const result = await window.labmate?.preferences.update(changes);
    if (!result) { setError('The local library bridge is unavailable.'); return; }
    if (result.ok) applySnapshot(result.value); else setError(result.error.message);
  }

  async function importAttachments() {
    if (!entry || mode === 'demo' || !(await flushDraft())) return;
    const jobId = newJobId('attachment-import');
    const result = await window.labmate?.attachments.import({ runId: entry.id, jobId });
    if (!result) { setError('The local library bridge is unavailable.'); return; }
    if (result.ok) applySnapshot(result.value); else if (result.error.code !== 'CANCELLED') setError(result.error.message);
    setProgress(null);
  }

  async function cancelProgress() {
    const active = progress;
    if (!active || mode === 'demo') return;
    const result = await window.labmate?.jobs.cancel({ jobId: active.jobId });
    if (!result || !result.ok) {
      setError(result && !result.ok ? result.error.message : 'The local library bridge is unavailable.');
      return;
    }
    setProgress(null);
  }

  async function returnToLibrary() {
    if (!(await flushDraft())) return;
    schedulerRef.current?.dispose();
    initializedPrefs.current = false;
    setMode('real');
    setState({ status: 'loading' });
    setPage('notebooks');
    setNotebookId(null);
    setEntryId(null);
    setSchemeId(null);
    setSearch('');
    setError('');
  }

  async function moveToTrash(kind: 'notebook' | 'experiment' | 'run', id: string) {
    if (mode === 'demo' || !(await flushDraft())) return;
    const latest = await window.labmate?.records.snapshot(undefined);
    if (!latest) { setError('The local library bridge is unavailable.'); return; }
    if (!latest.ok) { setError(latest.error.message); return; }
    const record = kind === 'notebook'
      ? latest.value.notebooks.find(item => item.id === id)
      : kind === 'experiment'
        ? latest.value.experiments.find(item => item.id === id)
        : latest.value.runs.find(item => item.id === id);
    if (!record) { setError('That record is no longer available. Reload the library and try again.'); return; }
    const label = kind === 'notebook'
      ? `Move notebook “${'name' in record ? record.name : id}” to Trash? Its experiments and runs will be hidden until the notebook is restored.`
      : kind === 'experiment'
        ? `Move experiment “${'label' in record ? record.label : id}” to Trash? Its runs will be hidden until the experiment is restored.`
        : `Move run “${'title' in record ? record.title : id}” to Trash? You can restore it from Settings › Trash.`;
    if (!window.confirm(label)) return;
    const result = await window.labmate?.trash.move({ kind, id, expectedRevision: record.revision });
    if (!result) { setError('The local library bridge is unavailable.'); return; }
    if (!result.ok) { setError(result.error.message); return; }
    applySnapshot(result.value);
    setPanel(null);
    if (kind === 'notebook') {
      setPage('notebooks'); setNotebookId(null); setEntryId(null); setSchemeId(null);
    } else if (kind === 'experiment') {
      setEntryId(null); setSchemeId(null);
    } else {
      setEntryId(null);
    }
  }

  async function enterDemo() {
    if (!(await flushDraft())) return;
    schedulerRef.current?.dispose();
    setMode('demo'); setState({ status: 'ready', snapshot: cloneDemoSnapshot() }); setPage('notebooks'); setNotebookId(null); setEntryId(null); setSchemeId(null); setSearch(''); setError(''); setAppearance(0); setLayout('continuous'); setDirectoryView('grid'); setSort('newest');
  }

  async function retrySave() {
    if (mode === 'demo') return;
    // Refresh only metadata/revision, then deliberately retry the retained
    // local draft against that revision. The fresh server documents are not
    // allowed to replace the editor while it is dirty.
    if (!(await refreshCurrentRun())) return;
    if (!(await flushDraft())) setError('The latest draft could not be saved.');
  }

  async function reloadDraft() {
    const fresh = await refreshCurrentRun();
    if (!fresh) return;
    schedulerRef.current?.dispose();
    currentRunRef.current = fresh;
    expectedRevisionRef.current = fresh.revision;
    setDraftDocuments(cloneDocuments(fresh.documents));
    setResetToken(value => value + 1);
    setSaveState('saved');
    schedulerRef.current = createAutosaveScheduler({ save: saveDocuments, onState: setSaveState });
  }

  const readOnly = mode === 'demo';
  return <div className="app-shell">
    <header className="window-bar"><div className="window-left" /><span className="window-title">LabMate</span><span className="preview-indicator"><i />{mode === 'demo' ? 'Demonstration mode' : state.status === 'error' ? 'Library unavailable' : 'Local library'}</span></header>
    <div className="app-body">
      <aside className="sidebar" aria-label="Main navigation">
        <button className="brand" onClick={() => void openDirectory()} aria-label="LabMate home"><span className="brand-icon"><BookOpen size={23} strokeWidth={1.65} /></span><span>LabMate<small>Electronic lab notebook</small></span></button>
        <div className="sidebar-section"><span className="sidebar-label">Workspace</span><button className={`nav-item ${page === 'notebooks' && !notebook ? 'selected' : ''}`} onClick={() => void openDirectory()}><Library size={18} /><span>All notebooks</span><span className="nav-count">{snapshot?.notebooks.filter(item => !item.trashedAt).length ?? 0}</span></button><button className="nav-item" onClick={() => setPanel({ kind: 'citations' })} title="Zotero integration unavailable"><Quote size={18} /><span>Citation library</span><span className="nav-count">—</span></button></div>
        <div className="sidebar-section organization-nav"><span className="sidebar-label">Organization</span><button className={`nav-item ${page === 'tracker' ? 'selected' : ''}`} onClick={() => void openTracker()} aria-current={page === 'tracker' ? 'page' : undefined}><Columns3 size={18} /><span>Experiment tracker</span></button></div>
        <div className="sidebar-section notebook-nav"><div className="sidebar-section-heading"><span className="sidebar-label">Notebooks</span><button className="icon-button" aria-label="New notebook" onClick={() => setPanel({ kind: 'new-notebook' })}><Plus size={16} /></button></div>{snapshot?.notebooks.filter(item => !item.trashedAt).map(item => <button key={item.id} className={`nav-item ${page === 'notebooks' && item.id === notebookId ? 'selected' : ''}`} onClick={() => void openNotebook(item.id)}><span className={`notebook-dot ${item.color}`} /><span>{item.name}</span></button>)}{snapshot?.notebooks.filter(item => !item.trashedAt).length === 0 && <span className="sidebar-empty">No notebooks yet</span>}</div>
        {page === 'notebooks' && notebook && <div className="sidebar-section scheme-nav"><div className="sidebar-section-heading"><span className="sidebar-label">Schemes</span><button className="icon-button" aria-label="New scheme" onClick={() => setPanel({ kind: 'scheme' })}><Plus size={16} /></button></div>{notebookSchemes.map(item => <div className="scheme-nav-item" key={item.id}><button className={`nav-item ${item.id === schemeId ? 'selected' : ''}`} onClick={() => void openScheme(item.id)}><GitBranch size={16} /><span>{item.name}</span></button><button className="icon-button scheme-edit" aria-label={`Edit scheme ${item.name}`} onClick={() => setPanel({ kind: 'scheme', schemeId: item.id })}><Settings size={13} /></button></div>)}<p className="sidebar-hint">Overlapping ordered views of the same runs.</p></div>}
        <div className="sidebar-bottom"><div className="settings-row"><button className="nav-item" onClick={() => setPanel({ kind: 'settings' })}><Settings size={18} /><span>Settings</span></button><button className="appearance-shortcut icon-button" onClick={() => setPanel({ kind: 'settings' })} aria-label="Adjust appearance" title="Adjust appearance"><SlidersHorizontal size={17} /></button></div><button className="text-button mode-switch" onClick={() => void (mode === 'demo' ? returnToLibrary() : enterDemo())}>{mode === 'demo' ? 'Return to my library' : 'View demonstration content'}</button><div className="preview-note"><span className="preview-dot" /><div><strong>{mode === 'demo' ? 'Demonstration content' : 'Your local library'}</strong><span>{mode === 'demo' ? 'Read-only fictional records.' : 'Stored on this Mac.'}</span></div></div></div>
      </aside>

      {page === 'tracker' && snapshot ? <Tracker snapshot={snapshot} mode={mode} onSnapshot={applySnapshot} onError={setError} onBeforeOperation={flushDraft} onOpenEntry={(notebook, run) => void openNotebook(notebook, run)} /> : state.status === 'loading' ? <LoadingState /> : state.status === 'error' ? <BackendError message={state.message} onRetry={() => setRetryCount(value => value + 1)} onDemo={() => void enterDemo()} /> : !notebook ? <Directory snapshot={snapshot!} view={directoryView} onView={view => { setDirectoryView(view); void updatePreference({ directoryView: view }); }} onOpen={id => void openNotebook(id)} onNew={() => setPanel({ kind: 'new-notebook' })} onDemo={() => void enterDemo()} onReturn={() => void returnToLibrary()} mode={mode} /> : <NotebookWorkspace snapshot={snapshot!} notebook={notebook} entry={entry} entries={visibleEntries.map(run => ({ ...run, attachments: snapshot!.attachments.filter(attachment => attachment.runId === run.id) }))} scheme={scheme} search={search} sort={sort} layout={layout} activeSection={activeSection} setActiveSection={setActiveSection} onOpenDirectory={() => void openDirectory()} onOpenEntry={id => void openEntry(id)} onSort={value => { setSort(value); setSchemeId(value === 'scheme' ? notebookSchemes[0]?.id ?? null : null); void updatePreference({ sort: value }); }} onSearch={setSearch} onNew={() => setPanel({ kind: 'new-experiment' })} onRepeat={() => setPanel({ kind: 'repeat' })} onExport={scope => setPanel({ kind: 'export', scope })} onEdit={() => setPanel({ kind: 'metadata', target: 'run' })} onEditExperiment={() => entry && setPanel({ kind: 'metadata', target: 'experiment' })} onEditNotebook={() => setPanel({ kind: 'metadata', target: 'notebook' })} onManageSchemes={() => setPanel({ kind: 'scheme' })} onTrashNotebook={() => void moveToTrash('notebook', notebook.id)} onTrashExperiment={() => entry && void moveToTrash('experiment', entry.experimentId)} onTrashRun={() => entry && void moveToTrash('run', entry.id)} documents={draftDocuments ?? entry?.documents ?? { information: { type: 'doc', content: [] }, method: { type: 'doc', content: [] }, notes: { type: 'doc', content: [] }, data: { type: 'doc', content: [] } }} onDocumentsChange={documents => { setDraftDocuments(documents); schedulerRef.current?.markDirty(documents); }} readOnly={readOnly} saveState={saveState} resetToken={resetToken} onRetrySave={() => void retrySave()} onReloadSave={reloadDraft} onAttachment={attachment => setPanel({ kind: 'attachment', attachment })} onAddAttachments={() => void importAttachments()} />}
    </div>
    {progress && progress.operation !== 'idle' && <div className="global-progress" role="status"><span>{progress.message ?? progress.phase}</span>{progress.total ? <progress value={progress.completed ?? 0} max={progress.total} /> : <span className="progress-pulse" />}<button className="icon-button" aria-label="Cancel operation" title="Cancel operation" onClick={() => void cancelProgress()}><X size={14} /></button></div>}
    {error && <div className="app-error" role="alert"><X size={16} /><span>{error}</span><button className="icon-button" aria-label="Dismiss error" onClick={() => setError('')}>×</button></div>}
    {panel && snapshot && <Panels panel={panel} onClose={() => setPanel(null)} layout={layout} setLayout={value => { setLayout(value); void updatePreference({ layout: value }); }} appearance={appearance} setAppearance={value => { setAppearance(value); void updatePreference({ appearance: value }); }} snapshot={snapshot} notebook={notebook} entry={entry ?? undefined} selectedRunIds={visibleEntries.map(item => item.id)} mode={mode} onSnapshot={applySnapshot} onRestored={replaceRestoredLibrary} onError={setError} onBeforeOperation={flushDraft} />}
  </div>;
}

function LoadingState() { return <main className="directory-main"><div className="state-screen" role="status"><span className="loading-mark" /><h1>Opening your library…</h1><p>Reading notebooks stored on this Mac.</p></div></main>; }

function BackendError({ message, onRetry, onDemo }: { message: string; onRetry: () => void; onDemo: () => void }) { return <main className="directory-main"><div className="state-screen"><WifiOff size={30} /><h1>We couldn’t open the local library</h1><p>{message}</p><div className="state-actions"><button className="button button-primary" onClick={onRetry}>Retry</button><button className="button" onClick={onDemo}>View demonstration</button></div><small>Demonstration mode uses fictional records in memory and never calls the desktop bridge.</small></div></main>; }

function Directory({ snapshot, view, onView, onOpen, onNew, onDemo, onReturn, mode }: { snapshot: LibrarySnapshot; view: 'grid' | 'list'; onView: (view: 'grid' | 'list') => void; onOpen: (id: string) => void; onNew: () => void; onDemo: () => void; onReturn: () => void; mode: 'real' | 'demo' }) {
  const notebooks = snapshot.notebooks.filter(item => !item.trashedAt);
  const recent = [...snapshot.runs].filter(item => isActiveRun(snapshot, item)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 5);
  return <main className="directory-main"><div className="breadcrumb-bar"><span><FolderOpen size={15} />Workspace<span className="breadcrumb-slash">/</span><strong>All notebooks</strong></span><span className="quiet-label">{mode === 'demo' ? 'Demonstration workspace' : 'Personal workspace'}</span></div><div className="directory-content"><div className="page-heading"><div><span className="eyebrow">A place for your curiosity</span><h1>Lab notebooks<span className="heading-spark" aria-hidden="true">✦</span></h1><p>A home for your experiments, observations, and discoveries.</p></div><div className="page-heading-actions"><button className="button button-primary" onClick={onNew}><Plus size={17} />New notebook</button>{mode === 'real' ? <button className="text-button" onClick={onDemo}>View demonstration content</button> : <button className="text-button" onClick={onReturn}>Return to my library</button>}</div></div>{notebooks.length ? <><div className="directory-controls"><div className="underlined-label">All notebooks <span>{notebooks.length}</span></div><div className="view-toggle" aria-label="Notebook view"><button aria-label="Grid view" aria-pressed={view === 'grid'} className={view === 'grid' ? 'selected' : ''} onClick={() => onView('grid')}><Grid2X2 size={16} /></button><button aria-label="List view" aria-pressed={view === 'list'} className={view === 'list' ? 'selected' : ''} onClick={() => onView('list')}><List size={17} /></button></div></div><div className={`notebook-cards ${view}`}>{notebooks.map((item, index) => <NotebookCard notebook={item} index={index} key={item.id} runCount={snapshot.runs.filter(run => run.notebookId === item.id && isActiveRun(snapshot, run)).length} onOpen={() => onOpen(item.id)} />)}</div></> : <div className="empty-state directory-empty"><Library size={30} /><h2>Your library is ready for its first notebook</h2><p>Create a notebook to start a durable record on this Mac.</p><button className="button button-primary" onClick={onNew}><Plus size={16} />Create notebook</button>{mode === 'real' && <button className="text-button" onClick={onDemo}>View demonstration content</button>}</div>}{recent.length > 0 && <><div className="recent-heading"><h2>Recent entries</h2><span>The latest pages across your notebooks</span></div><div className="recent-entries"><div className="recent-table-heading"><span>Entry</span><span>Notebook</span><span>Experiment date</span><span /></div>{recent.map(item => <button key={item.id} className="recent-row" onClick={() => onOpen(item.notebookId)}><span className="recent-entry-name"><span className="recent-file-icon"><FileText size={18} /></span><span><strong>{item.title}</strong><small>{entryCode(item)}</small></span></span><span className="recent-notebook"><i className={`notebook-dot ${snapshot.notebooks.find(book => book.id === item.notebookId)?.color ?? 'sage'}`} />{snapshot.notebooks.find(book => book.id === item.notebookId)?.name}</span><span className="recent-date">{formatDate(item.date)}</span><ChevronRight size={15} /></button>)}</div></>}{notebooks.length > 0 && <div className="workspace-footnote"><FlaskConical size={19} /><p><strong>Built around the experiment.</strong> Keep methods, notes, data, and references together.</p><span className="soft-badge">Durable local records</span></div>}</div></main>;
}

function NotebookCard({ notebook, index, runCount, onOpen }: { notebook: LibrarySnapshot['notebooks'][number]; index: number; runCount: number; onOpen: () => void }) {
  return <button className={`notebook-card ${notebook.color}`} onClick={onOpen}><div className="notebook-cover"><div className="cover-spine" /><span className="cover-index">NOTEBOOK / 0{index + 1}</span><div className="cover-symbol"><FlaskConical size={32} strokeWidth={1.1} /></div><span className="cover-discipline">{notebook.discipline}</span><span className="cover-rule" /></div><div className="notebook-card-content"><h2>{notebook.name}<ArrowRight size={17} /></h2><p>{notebook.description}</p><div className="notebook-card-footer"><span><FileText size={13} />{runCount} {runCount === 1 ? 'entry' : 'entries'}</span><span>Updated {formatDate(notebook.updatedAt.slice(0, 10))}</span></div></div></button>;
}

function NotebookWorkspace({ snapshot, notebook, entry, entries, scheme, search, sort, layout, activeSection, setActiveSection, onOpenDirectory, onOpenEntry, onSort, onSearch, onNew, onRepeat, onExport, onEdit, onEditExperiment, onEditNotebook, onManageSchemes, onTrashNotebook, onTrashExperiment, onTrashRun, documents, onDocumentsChange, readOnly, saveState, resetToken, onRetrySave, onReloadSave, onAttachment, onAddAttachments }: { snapshot: LibrarySnapshot; notebook: LibrarySnapshot['notebooks'][number]; entry: Entry | null; entries: Entry[]; scheme?: LibrarySnapshot['schemes'][number]; search: string; sort: string; layout: EntryLayout; activeSection: SectionId; setActiveSection: (section: SectionId) => void; onOpenDirectory: () => void; onOpenEntry: (id: string) => void; onSort: (sort: string) => void; onSearch: (search: string) => void; onNew: () => void; onRepeat: () => void; onExport: (scope: 'entry' | 'selected' | 'notebook') => void; onEdit: () => void; onEditExperiment: () => void; onEditNotebook: () => void; onManageSchemes: () => void; onTrashNotebook: () => void; onTrashExperiment: () => void; onTrashRun: () => void; documents: LibrarySnapshot['runs'][number]['documents']; onDocumentsChange: (documents: LibrarySnapshot['runs'][number]['documents']) => void; readOnly: boolean; saveState: SaveState; resetToken: number; onRetrySave: () => void; onReloadSave: () => void; onAttachment: (attachment: LibrarySnapshot['attachments'][number]) => void; onAddAttachments: () => void }) {
  return <main className="notebook-main"><div className="breadcrumb-bar"><span><button className="breadcrumb-back" onClick={onOpenDirectory} aria-label="Back to all notebooks"><ArrowLeft size={15} /></button><span>Notebooks</span><span className="breadcrumb-slash">/</span><strong>{notebook.name}</strong></span><div className="workspace-header-actions"><button className="button button-small" onClick={() => onEditNotebook()}>Edit notebook</button><button className="button button-small danger-outline" onClick={onTrashNotebook} disabled={readOnly} title="Move this notebook and hide its experiments and runs until restored"><Trash2 size={14} />Move notebook to Trash</button><button className="button button-small" onClick={() => onExport('notebook')}><Upload size={14} />Export notebook</button></div></div><div className="workspace-columns"><aside className="entry-list-panel" aria-label="Notebook entries"><div className="entry-list-heading"><span className="eyebrow">{notebook.discipline}</span><h2>{notebook.name}</h2><span className="entry-count">{entries.length} {entries.length === 1 ? 'entry' : 'entries'} <span>·</span> {snapshot.schemes.filter(item => item.notebookId === notebook.id).length} schemes</span></div><div className="entry-actions"><button className="button button-primary" onClick={onNew}><Plus size={16} />New experiment</button></div><div className="entry-list-controls"><div className="search-field"><Search size={15} /><input aria-label="Search entries" placeholder="Search title, label, author, or sections" value={search} onChange={event => onSearch(event.target.value)} /></div><label className="sort-control"><ArrowDownUp size={14} /><select aria-label="Sort entries" value={sort} onChange={event => onSort(event.target.value)}>{sortOptions.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select><ChevronDown size={13} /></label><span className="sorting-note">{scheme ? `${scheme.name} · ordered view` : `${entries.length} matching`}</span></div>{scheme && <div className="scheme-summary"><GitBranch size={16} /><strong>{scheme.name}</strong><p>{scheme.description}</p><div><button className="button button-small" onClick={() => onExport('selected')}><Upload size={12} />Export view</button><button className="button button-small" onClick={onManageSchemes} title="Create, edit, or remove ordered schemes"><List size={12} />Manage schemes</button></div></div>}<div className="entry-items">{entries.map((item, index) => <EntryListItem entry={item} key={item.id} selected={item.id === entry?.id} sequence={scheme ? index + 1 : undefined} onSelect={() => onOpenEntry(item.id)} />)}{!entries.length && <div className="empty-state entry-empty"><Search size={24} /><strong>No matching entries</strong><span>Try a different search or create a new experiment.</span></div>}</div><div className="entry-list-footer"><button className="text-button" onClick={() => onExport('selected')} disabled={!entries.length}><Upload size={14} />Export selected entries</button><span>{entries.length} shown</span></div></aside><div className="entry-workspace">{entry ? <><div className="entry-topbar"><span><FileText size={14} />Entry <span className="topbar-separator">/</span><span className="topbar-entry-code">{entryCode(entry)}</span></span><div className="workspace-header-actions"><button className="button button-small" onClick={onEdit}>Edit metadata</button><button className="button button-small" onClick={onEditExperiment}>Edit experiment label</button><button className="button button-small danger-outline" onClick={onTrashExperiment} disabled={readOnly} title="Move this experiment and hide its runs until restored"><Trash2 size={14} />Move experiment to Trash</button><button className="button button-small danger-outline" onClick={onTrashRun} disabled={readOnly} title="Move this run to Trash; restore it from Settings"><Trash2 size={14} />Move run to Trash</button><button className="button button-small" onClick={onRepeat}><Repeat2 size={14} />Repeat experiment</button><button className="button button-small" onClick={() => onExport('entry')}><Upload size={14} />Export entry</button></div></div><SectionNavigation layout={layout} activeSection={activeSection} onSelect={section => { setActiveSection(section); if (layout === 'continuous') document.getElementById(`section-${section}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' }); }} /><div className="entry-scroll"><article className="entry-document"><header className="entry-document-header"><span className="entry-code-badge">{entryCode(entry)}</span><h1>{entry.title}</h1><div className="entry-metadata"><span><CalendarDays size={14} />{formatDate(entry.date)}</span><span><UserRound size={14} />{entry.author}</span><span className="run-badge">Run {entry.runNumber} of experiment {entry.experimentNumber}</span></div><CitationChips disabled /></header><EntrySections entry={entry} documents={documents} layout={layout} activeSection={activeSection} onDocumentsChange={onDocumentsChange} onEditor={() => undefined} onFocusSection={setActiveSection} onAttachment={onAttachment} onAddAttachments={onAddAttachments} readOnly={readOnly} resetToken={resetToken} attachments={entry.attachments} /></article></div><div className="entry-status"><span><span className={`status-dot ${saveState}`} />{readableSaveState(saveState, readOnly)}</span>{(saveState === 'failed' || saveState === 'stale') && <span className="save-actions"><button className="text-button" onClick={onRetrySave} title="Retry save using this local draft">Retry with this draft</button><button className="text-button" onClick={onReloadSave} title="Discard the local draft and reload the latest library copy">Reload from library</button></span>}<button onClick={() => setActiveSection(activeSection)}><LayoutList size={13} />{layout === 'continuous' ? 'Continuous page' : 'Section tabs'}</button></div></> : <div className="empty-state no-entry"><FileText size={30} /><h2>{entries.length ? 'Choose an entry' : 'No entries in this notebook'}</h2><p>{entries.length ? 'Select a run from the list to open its four sections.' : 'Create an experiment to begin a durable record.'}</p>{!entries.length && <button className="button button-primary" onClick={onNew}><Plus size={16} />New experiment</button>}</div>}</div></div></main>;
}

function readableSaveState(state: SaveState, readOnly: boolean): string {
  if (readOnly) return 'Demonstration mode · read-only';
  if (state === 'saving') return 'Saving…';
  if (state === 'failed') return 'Save failed · retrying on edit';
  if (state === 'stale') return 'Changed elsewhere · reload or retry';
  return 'Saved';
}

function EntryListItem({ entry, selected, sequence, onSelect }: { entry: Entry; selected: boolean; sequence?: number; onSelect: () => void }) {
  const attachmentCount = entry.attachments?.length ?? 0;
  return <button className={`entry-list-item ${selected ? 'selected' : ''}`} onClick={onSelect} aria-current={selected ? 'page' : undefined}><div className="entry-item-kicker"><span>{sequence !== undefined ? <span className="sequence-number">{String(sequence).padStart(2, '0')}</span> : <FileText size={13} />}{entryCode(entry)}</span>{entry.runNumber > 1 && <Repeat2 size={13} />}</div><strong>{entry.title}</strong><p>{entry.author}</p><span className="entry-item-footer">{formatDate(entry.date).replace(', 2026', '')}<span>{attachmentCount} {attachmentCount === 1 ? 'file' : 'files'}</span></span></button>;
}
