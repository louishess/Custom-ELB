import { useLayoutEffect, useRef, useState } from 'react';
import { ArrowUpRight, CheckCircle2, Circle, CircleDashed, GitBranch } from 'lucide-react';
import { entryCode, statusOptions } from './fixtures';
import type { EntryStatus, LibrarySnapshot } from './types';

interface TrackerProps {
  snapshot: LibrarySnapshot;
  mode: 'real' | 'demo';
  onSnapshot: (snapshot: LibrarySnapshot) => void;
  onError: (message: string) => void;
  onBeforeOperation: () => Promise<boolean>;
  onOpenEntry: (notebookId: string, runId: string) => void;
}

const statusIcons = { todo: Circle, progress: CircleDashed, complete: CheckCircle2 };

export default function Tracker({ snapshot, mode, onSnapshot, onError, onBeforeOperation, onOpenEntry }: TrackerProps) {
  const [notebookFilter, setNotebookFilter] = useState('all');
  const statusFocus = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (statusFocus.current) {
      document.getElementById(`status-${statusFocus.current}`)?.focus({ preventScroll: true });
      statusFocus.current = null;
    }
  }, [snapshot]);
  const notebooks = snapshot.notebooks.filter(notebook => !notebook.trashedAt);
  const experiments = new Map(snapshot.experiments.map(experiment => [experiment.id, experiment]));
  const visibleRuns = snapshot.runs.filter(run => !run.trashedAt && !snapshot.notebooks.find(notebook => notebook.id === run.notebookId)?.trashedAt && !experiments.get(run.experimentId)?.trashedAt && (notebookFilter === 'all' || run.notebookId === notebookFilter));

  const changeStatus = async (runId: string, status: EntryStatus) => {
    const run = snapshot.runs.find(item => item.id === runId);
    if (!run) return;
    if (mode === 'demo') {
      statusFocus.current = runId;
      onSnapshot({ ...snapshot, runs: snapshot.runs.map(item => item.id === runId ? { ...item, status } : item) });
      return;
    }
    if (!(await onBeforeOperation())) return;
    const latest = await window.labmate?.records.snapshot(undefined);
    if (!latest) { onError('The local library bridge is unavailable.'); return; }
    if (!latest.ok) { onError(latest.error.message); return; }
    const freshRun = latest.value.runs.find(item => item.id === runId && !item.trashedAt);
    if (!freshRun) { onError('This run is no longer available. Reload the tracker and try again.'); return; }
    statusFocus.current = runId;
    const result = await window.labmate?.records.updateRun({ id: freshRun.id, expectedRevision: freshRun.revision, changes: { status } });
    if (!result) { onError('The local library bridge is unavailable.'); return; }
    if (result.ok) onSnapshot(result.value); else onError(result.error.message);
  };

  return <main className="tracker-main"><div className="breadcrumb-bar"><span><GitBranch size={15} />Organization<span className="breadcrumb-slash">/</span><strong>Experiment tracker</strong></span></div><div className="tracker-content"><div className="page-heading tracker-heading"><div><h1>Experiment tracker<span className="heading-spark" aria-hidden="true">✦</span></h1></div><label className="tracker-filter">View notebook<select aria-label="Filter tracker by notebook" value={notebookFilter} onChange={event => setNotebookFilter(event.target.value)}><option value="all">All notebooks</option>{notebooks.map(notebook => <option key={notebook.id} value={notebook.id}>{notebook.name}</option>)}</select></label></div><div className="tracker-board">{statusOptions.map(status => { const items = visibleRuns.filter(run => run.status === status.id); const Icon = statusIcons[status.id]; return <section key={status.id} className={`tracker-column ${status.id}`} aria-labelledby={`tracker-${status.id}`}><div className="tracker-column-header"><span className="tracker-status-icon"><Icon size={17} /></span><h2 id={`tracker-${status.id}`}>{status.name}</h2><span className="tracker-count" aria-label={`${items.length} experiments`}>{items.length}</span></div><p className="tracker-column-description">{status.description}</p><div className="tracker-cards">{items.map(run => { const notebook = notebooks.find(item => item.id === run.notebookId); return <article className="tracker-card" key={run.id}><span className="tracker-notebook"><span className={`notebook-dot ${notebook?.color ?? 'sage'}`} />{notebook?.name ?? 'Unknown notebook'}</span><button className="tracker-entry-link" onClick={() => onOpenEntry(run.notebookId, run.id)}><h3>{run.title}</h3><ArrowUpRight size={15} /></button><span className="tracker-entry-code">{entryCode(run)}</span><p>{run.author}</p><div className="tracker-card-footer"><span className="tracker-avatar" title={run.author}>{run.author.split(' ').map(name => name[0]).join('')}</span><select id={`status-${run.id}`} aria-label={`Status for ${run.title}`} value={run.status} onChange={event => void changeStatus(run.id, event.target.value as EntryStatus)}>{statusOptions.map(option => <option key={option.id} value={option.id}>{option.name}</option>)}</select></div></article>; })}{!items.length && <div className="tracker-empty"><Icon size={24} /><strong>A little breathing room.</strong><span>No experiments in this column.</span></div>}</div></section>; })}</div></div></main>;
}
