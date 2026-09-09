import { useLayoutEffect, useRef, useState } from 'react';
import { ArrowUpRight, CheckCircle2, Circle, CircleDashed, GitBranch, Sparkles } from 'lucide-react';
import { entries, entryCode, notebooks, statusOptions } from './fixtures';
import type { EntryStatus } from './types';

interface TrackerProps {
  statuses: Record<string, EntryStatus>;
  onStatusChange: (entryId: string, status: EntryStatus) => void;
  onOpenEntry: (notebookId: string, entryId: string) => void;
}

const statusIcons = { todo: Circle, progress: CircleDashed, complete: CheckCircle2 };

export default function Tracker({ statuses, onStatusChange, onOpenEntry }: TrackerProps) {
  const [notebookFilter, setNotebookFilter] = useState('all');
  const statusFocus = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (statusFocus.current) {
      document.getElementById(`status-${statusFocus.current}`)?.focus({ preventScroll: true });
      statusFocus.current = null;
    }
  }, [statuses]);
  const visibleEntries = entries.filter(entry => notebookFilter === 'all' || entry.notebookId === notebookFilter);
  const completeCount = visibleEntries.filter(entry => statuses[entry.id] === 'complete').length;

  return <main className="tracker-main">
    <div className="breadcrumb-bar"><span><GitBranch size={15} />Organization<span className="breadcrumb-slash">/</span><strong>Experiment tracker</strong></span><span className="quiet-label">One step at a time</span></div>
    <div className="tracker-content">
      <div className="page-heading tracker-heading">
        <div><span className="eyebrow">A little forward motion</span><h1>Experiment tracker<span className="heading-spark" aria-hidden="true">✦</span></h1><p>From a good question to a completed experiment.</p></div>
        <label className="tracker-filter">View notebook<select aria-label="Filter tracker by notebook" value={notebookFilter} onChange={event => setNotebookFilter(event.target.value)}><option value="all">All notebooks</option>{notebooks.map(notebook => <option key={notebook.id} value={notebook.id}>{notebook.name}</option>)}</select></label>
      </div>
      <div className="tracker-summary"><div className="tracker-summary-icon"><Sparkles size={20} /></div><div><strong>Every step counts.</strong><p role="status">{completeCount} of {visibleEntries.length} sample experiments complete. There’s room for what’s next.</p></div><span className="soft-badge">Session only</span></div>
      <div className="tracker-board">
        {statusOptions.map(status => {
          const items = visibleEntries.filter(entry => statuses[entry.id] === status.id);
          const Icon = statusIcons[status.id];
          return <section key={status.id} className={`tracker-column ${status.id}`} aria-labelledby={`tracker-${status.id}`}>
            <div className="tracker-column-header"><span className="tracker-status-icon"><Icon size={17} /></span><h2 id={`tracker-${status.id}`}>{status.name}</h2><span className="tracker-count" aria-label={`${items.length} experiments`}>{items.length}</span></div>
            <p className="tracker-column-description">{status.description}</p>
            <div className="tracker-cards">
              {items.map(entry => {
                const notebook = notebooks.find(item => item.id === entry.notebookId)!;
                return <article className="tracker-card" key={entry.id}>
                  <span className="tracker-notebook"><span className={`notebook-dot ${notebook.color}`} />{notebook.name}</span>
                  <button className="tracker-entry-link" onClick={() => onOpenEntry(entry.notebookId, entry.id)}><h3>{entry.title}</h3><ArrowUpRight size={15} /></button>
                  <span className="tracker-entry-code">{entryCode(entry)}</span>
                  <p>{entry.objective}</p>
                  <div className="tracker-card-footer"><span className="tracker-avatar" title={entry.author}>{entry.author.split(' ').map(name => name[0]).join('')}</span><select id={`status-${entry.id}`} aria-label={`Status for ${entry.title}`} value={statuses[entry.id]} onChange={event => { statusFocus.current = entry.id; onStatusChange(entry.id, event.target.value as EntryStatus); }}>{statusOptions.map(option => <option key={option.id} value={option.id}>{option.name}</option>)}</select></div>
                </article>;
              })}
              {!items.length && <div className="tracker-empty"><Icon size={24} /><strong>A little breathing room.</strong><span>No experiments in this column.</span></div>}
            </div>
          </section>;
        })}
      </div>
      <p className="tracker-footnote">Sample experiments · Open a card to visit its notebook. Status changes reset when LabMate closes.</p>
    </div>
  </main>;
}
