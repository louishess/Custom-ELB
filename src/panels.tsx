import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, BookOpen, Check, Cloud, FileText, FolderArchive, LayoutList, Link, List, Monitor, Moon, ShieldCheck, Sun, Trash2, Upload, XCircle } from 'lucide-react';
import AttachmentPreview from './AttachmentPreview';
import { AttachmentIcon, Modal, ModalErrorContext } from './components';
import { activeTrash, compareRuns, isActiveRun, newJobId, normalizeSort, todayLocalDate } from './workflows';
import { entryCode, formatBytes, formatDate, sections, sortOptions } from './fixtures';
import type { Attachment, Entry, EntryLayout, LibrarySnapshot, Notebook, Panel, SectionId, SettingsTab } from './types';
import type { BackupStatus, Result } from '../shared/contracts';

type SnapshotResult = Result<LibrarySnapshot>;
type SnapshotHandler = (snapshot: LibrarySnapshot) => void;

interface PanelsProps {
  panel: Panel;
  onClose: () => void;
  layout: EntryLayout;
  setLayout: (layout: EntryLayout) => void;
  appearance: number;
  setAppearance: (appearance: number) => void;
  snapshot: LibrarySnapshot;
  notebook?: Notebook;
  entry?: Entry;
  selectedRunIds: string[];
  mode: 'real' | 'demo';
  onSnapshot: SnapshotHandler;
  onRestored: SnapshotHandler;
  onError: (message: string) => void;
  onBeforeOperation: () => Promise<boolean>;
  onProgressCancel?: (jobId: string) => void;
  onOpenNotebook?: (id: string) => void;
}

function apiUnavailable(): Error {
  return new Error('The LabMate desktop bridge is unavailable. Restart the app and try again.');
}

function getAPI() {
  return window.labmate;
}

function mutationSnapshot(result: SnapshotResult, onSnapshot: SnapshotHandler, onError: (message: string) => void): boolean {
  if (result.ok) { onSnapshot(result.value); return true; }
  onError(result.error.message);
  return false;
}

function useProgress(operation: string) {
  const [event, setEvent] = useState<{ jobId: string; phase: string; completed?: number; total?: number; message?: string } | null>(null);
  useEffect(() => {
    const unsubscribe = window.labmate?.onProgress(eventValue => {
      if (eventValue.operation === operation || eventValue.operation.includes(operation)) setEvent(eventValue);
    });
    return unsubscribe;
  }, [operation]);
  return [event, setEvent] as const;
}

export function Panels(props: PanelsProps) {
  const { panel, onClose } = props;
  const [panelError, setPanelError] = useState('');
  const panelProps = { ...props, onError: setPanelError, onBeforeOperation: async () => {
    setPanelError('');
    const saved = await props.onBeforeOperation();
    if (!saved) setPanelError('Current edits could not be saved. Close this panel and resolve the save error before continuing.');
    return saved;
  } };
  const content = panel.kind === 'settings' ? <SettingsPanel {...panelProps} initialTab={panel.tab} />
    : panel.kind === 'export' ? <ExportPanel {...panelProps} initialScope={panel.scope} />
      : panel.kind === 'attachment' ? <AttachmentPanel {...panelProps} attachment={panel.attachment} />
        : panel.kind === 'scheme' ? <SchemePanel {...panelProps} schemeId={panel.schemeId} />
          : panel.kind === 'metadata' ? <MetadataPanel {...panelProps} target={panel.target} />
            : panel.kind === 'citations' ? <CitationPanel onClose={onClose} />
              : <RecordFormPanel {...panelProps} kind={panel.kind} />;
  return <ModalErrorContext.Provider value={panelError}>{content}</ModalErrorContext.Provider>;
}

function SettingsPanel({ initialTab = 'general', onClose, layout, setLayout, appearance, setAppearance, snapshot, mode, onSnapshot, onRestored, onError, onBeforeOperation }: PanelsProps & { initialTab?: SettingsTab }) {
  const [tab, setTab] = useState<SettingsTab>(initialTab);
  const updatePreference = async (changes: Partial<LibrarySnapshot['preferences']>) => {
    if (mode === 'demo') { onSnapshot({ ...snapshot, preferences: { ...snapshot.preferences, ...changes } }); return; }
    if (!(await onBeforeOperation())) return;
    const result = await getAPI()?.preferences.update(changes);
    if (!result) { onError(apiUnavailable().message); return; }
    if (result.ok) onSnapshot(result.value);
    else onError(result.error.message);
  };
  return <Modal title="Settings" eyebrow="Make room for your work" onClose={onClose} wide>
    <div className="settings-tabs" role="tablist" aria-label="Settings sections">
      {([['general', 'Appearance'], ['backups', 'Backups'], ['trash', 'Trash']] as [SettingsTab, string][]).map(([value, label]) => <button key={value} role="tab" aria-selected={tab === value} className={tab === value ? 'active' : ''} onClick={() => setTab(value)}>{label}</button>)}
    </div>
    {tab === 'general' && <div className="modal-body">
      <div className="settings-heading"><Sun size={19} /><div><h3>Appearance</h3><p>A brighter desk or a quieter evening.</p></div></div>
      <div className="appearance-control"><div className="appearance-control-heading"><label htmlFor="appearance-range">Find your balance</label><output htmlFor="appearance-range">{appearance}%</output></div><input id="appearance-range" type="range" min="0" max="100" step="1" value={appearance} aria-label="Appearance" aria-valuetext={appearance === 0 ? 'Light, 0 percent' : appearance === 100 ? 'Dark, 100 percent' : `${appearance} percent toward dark`} onChange={event => { const value = Number(event.target.value); setAppearance(value); void updatePreference({ appearance: value }); }} /><div className="appearance-endpoints"><span><Sun size={16} />Light <small>Warm & open</small></span><span><Moon size={16} />Dark <small>Quiet & soft</small></span></div><p>Slide to any point between light and dark. Your workspace updates as you go.</p></div>
      <div className="settings-heading layout-settings-heading"><Monitor size={19} /><div><h3>Entry layout</h3><p>Choose how you move through an experiment.</p></div></div>
      <fieldset className="layout-options"><legend className="sr-only">Entry layout</legend>{(['continuous', 'tabs'] as const).map(option => <label className={`layout-option ${layout === option ? 'selected' : ''}`} key={option}><input type="radio" name="layout" value={option} checked={layout === option} onChange={() => { setLayout(option); void updatePreference({ layout: option }); }} /><div className={`layout-miniature ${option}`} aria-hidden="true"><div className="mini-tabs"><i /><i /><i /></div><div className="mini-content"><span /><span /><span /></div>{option === 'continuous' && <div className="mini-content short"><span /><span /></div>}</div><span className="layout-option-title">{option === 'continuous' ? <LayoutList size={16} /> : <List size={16} />}{option === 'continuous' ? 'Continuous page' : 'Section tabs'}{layout === option && <Check size={16} className="selection-check" />}</span><span className="layout-option-description">{option === 'continuous' ? 'Read the full entry with section jump links.' : 'Focus on one section at a time.'}</span></label>)}</fieldset>
      <div className="settings-preferences"><label className="field-label">Directory view<select aria-label="Directory view" value={snapshot.preferences.directoryView} onChange={event => void updatePreference({ directoryView: event.target.value as 'grid' | 'list' })}><option value="grid">Grid</option><option value="list">List</option></select></label><label className="field-label">Default entry sort<select aria-label="Default entry sort" value={normalizeSort(snapshot.preferences.sort)} onChange={event => void updatePreference({ sort: event.target.value })}>{sortOptions.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label></div>
      <p className="muted-note">Preferences are saved to this library and apply when LabMate opens again.</p>
      <div className="settings-about"><BookOpen size={19} /><div><strong>LabMate</strong><p>Local electronic lab notebook</p></div><span className={`soft-badge ${mode === 'demo' ? '' : 'working-badge'}`}>{mode === 'demo' ? 'Demonstration' : 'Local library'}</span></div>
    </div>}
    {tab === 'backups' && <BackupSettings mode={mode} onRestored={onRestored} onError={onError} onBeforeOperation={onBeforeOperation} />}
    {tab === 'trash' && <TrashSettings snapshot={snapshot} mode={mode} onSnapshot={onSnapshot} onError={onError} onBeforeOperation={onBeforeOperation} />}
    <div className="modal-footer"><span>{mode === 'demo' ? 'Demonstration mode changes stay in memory.' : 'Settings are saved as you change them.'}</span><button className="button button-primary" onClick={onClose}>Done</button></div>
  </Modal>;
}

function BackupSettings({ mode, onRestored, onError, onBeforeOperation }: { mode: 'real' | 'demo'; onRestored: SnapshotHandler; onError: (message: string) => void; onBeforeOperation: () => Promise<boolean> }) {
  const [status, setStatus] = useState<BackupStatus | null>(null);
  const [password, setPassword] = useState('');
  const [restorePassword, setRestorePassword] = useState('');
  const [state, setState] = useState<'idle' | 'configuring' | 'running' | 'restoring' | 'cancelling'>('idle');
  const [message, setMessage] = useState('');
  const [progress] = useProgress('backup');
  const [jobId, setJobId] = useState<string | null>(null);
  useEffect(() => {
    if (mode === 'demo') return;
    void getAPI()?.backups.status(undefined).then(result => { if (result?.ok) setStatus(result.value); else if (result) onError(result.error.message); });
  }, [mode, onError]);
  const configure = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!password.trim() || mode === 'demo') return;
    if (!(await onBeforeOperation())) return;
    setState('configuring'); setMessage('Opening the native destination picker…');
    const result = await getAPI()?.backups.configure({ password });
    if (!result) { setJobId(null); setState('idle'); onError(apiUnavailable().message); return; }
    if (result.ok) { setStatus(result.value); setPassword(''); setMessage(result.value.message ?? 'Backup destination configured.'); }
    else { setState('idle'); onError(result.error.message); }
    setState('idle');
  };
  const runBackup = async () => {
    if (mode === 'demo') return;
    if (!(await onBeforeOperation())) return;
    const activeJobId = newJobId('backup'); setJobId(activeJobId); setState('running'); setMessage('Creating an encrypted backup…');
    const result = await getAPI()?.backups.run({ jobId: activeJobId });
    if (!result) { setJobId(null); setState('idle'); onError(apiUnavailable().message); return; }
    if (result.ok) { setStatus(result.value); setMessage(result.value.message ?? 'Backup complete.'); }
    else if (result.error.code === 'CANCELLED') setMessage('Backup cancelled.');
    else { setMessage(result.error.message); onError(result.error.message); }
    setJobId(null); setState('idle');
  };
  const restore = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!restorePassword.trim() || mode === 'demo') return;
    if (!(await onBeforeOperation())) return;
    const activeJobId = newJobId('restore'); setJobId(activeJobId); setState('restoring'); setMessage('Restoring and validating the backup…');
    const result = await getAPI()?.backups.restore({ password: restorePassword, jobId: activeJobId });
    if (!result) { setJobId(null); setState('idle'); onError(apiUnavailable().message); return; }
    if (result.ok) {
      setRestorePassword('');
      onRestored(result.value);
      return;
    }
    else if (result.error.code === 'CANCELLED') setMessage('Restore cancelled.');
    else { setMessage(result.error.message); onError(result.error.message); }
    setJobId(null); setState('idle');
  };
  const cancel = async () => {
    const activeJobId = jobId ?? progress?.jobId;
    if (!activeJobId) return;
    const result = await getAPI()?.jobs.cancel({ jobId: activeJobId });
    if (!result) { onError(apiUnavailable().message); return; }
    if (!result.ok) { onError(result.error.message); return; }
    if (result.value.cancelled) { setState('cancelling'); setMessage('Cancellation requested…'); }
  };
  const running = state === 'running' || state === 'restoring' || state === 'configuring' || state === 'cancelling';
  return <div className="modal-body settings-backups">
    <div className="settings-heading"><ShieldCheck size={19} /><div><h3>Encrypted backups</h3><p>Keep a restorable copy of this local library.</p></div></div>
    <p className="panel-intro">Automatic backups run once daily after setup and catch up when LabMate opens. Credentials and backup settings stay on this Mac.</p>
    <p className="muted-note">Each backup supports up to 2 GiB total, 1 GiB per file, and 10,000 archive entries. If the library exceeds a limit, the backup fails without publishing a partial copy. Larger files remain attached locally.</p>
    <div className="backup-destination"><FolderArchive size={20} /><div><strong>{status?.configured ? `Destination: ${status.destinationLabel ?? 'your selected folder'}` : 'No destination configured'}</strong><span>Box Drive manages upload after a successful local backup.</span>{status?.lastBackupAt && <small>Last verified copy {formatDate(status.lastBackupAt.slice(0, 10))}</small>}</div></div>
    <form className="form-stack" onSubmit={configure}><label className="field-label">Backup password<input type="password" autoComplete="new-password" value={password} onChange={event => setPassword(event.target.value)} placeholder={status?.configured ? 'Enter a new password to reconfigure' : 'Choose a password'} disabled={running} /></label><button className="button" disabled={!password.trim() || running || mode === 'demo'}>{state === 'configuring' ? 'Configuring…' : status?.configured ? 'Change destination' : 'Set up backups'}</button></form>
    <div className="backup-actions"><button className="button button-primary" onClick={() => void runBackup()} disabled={!status?.configured || running || mode === 'demo'}><Upload size={15} />{state === 'running' ? 'Backing up…' : 'Back up now'}</button>{running && <button className="button" onClick={() => void cancel()} disabled={state === 'configuring' || state === 'cancelling'}><XCircle size={15} />{state === 'cancelling' ? 'Cancelling…' : 'Cancel'}</button>}</div>
    <form className="form-stack restore-form" onSubmit={restore}><label className="field-label">Restore password<input type="password" autoComplete="current-password" value={restorePassword} onChange={event => setRestorePassword(event.target.value)} placeholder="Password for a LabMate backup" disabled={running} /></label><button className="button" disabled={!restorePassword.trim() || running || mode === 'demo'}>{state === 'restoring' ? 'Restoring…' : 'Restore backup…'}</button></form>
    {progress && <ProgressStatus event={progress} />}{message && <p className="panel-status" role="status">{message}</p>}
  </div>;
}

function ProgressStatus({ event }: { event: { phase: string; completed?: number; total?: number; message?: string } }) {
  const amount = event.total ? Math.round((event.completed ?? 0) / event.total * 100) : undefined;
  return <div className="job-progress" role="status"><div><strong>{event.message ?? event.phase}</strong>{amount !== undefined && <span>{amount}%</span>}</div>{amount !== undefined && <progress value={amount} max="100" />}</div>;
}

function TrashSettings({ snapshot, mode, onSnapshot, onError, onBeforeOperation }: { snapshot: LibrarySnapshot; mode: 'real' | 'demo'; onSnapshot: SnapshotHandler; onError: (message: string) => void; onBeforeOperation: () => Promise<boolean> }) {
  const trash = activeTrash(snapshot);
  const currentRecord = (library: LibrarySnapshot, item: (typeof trash)[number]) => item.kind === 'notebook'
    ? library.notebooks.find(candidate => candidate.id === item.id)
    : item.kind === 'experiment'
      ? library.experiments.find(candidate => candidate.id === item.id)
      : library.runs.find(candidate => candidate.id === item.id);
  const restore = async (item: (typeof trash)[number]) => {
    if (mode === 'demo') return;
    if (!(await onBeforeOperation())) return;
    const api = getAPI();
    if (!api) { onError(apiUnavailable().message); return; }
    const latest = await api.records.snapshot(undefined);
    if (!latest.ok) { onError(latest.error.message); return; }
    const record = currentRecord(latest.value, item);
    if (!record) return;
    const result = await api.trash.restore({ kind: item.kind, id: item.id, expectedRevision: record.revision });
    if (!result) { onError(apiUnavailable().message); return; }
    mutationSnapshot(result, onSnapshot, onError);
  };
  const purge = async (item: (typeof trash)[number]) => {
    if (mode === 'demo' || !window.confirm(`Permanently delete “${item.name}”? This cannot be undone from Trash.`)) return;
    if (!(await onBeforeOperation())) return;
    const api = getAPI();
    if (!api) { onError(apiUnavailable().message); return; }
    const latest = await api.records.snapshot(undefined);
    if (!latest.ok) { onError(latest.error.message); return; }
    const record = currentRecord(latest.value, item);
    if (!record) return;
    const result = await api.trash.purge({ kind: item.kind, id: item.id, expectedRevision: record.revision });
    if (!result) { onError(apiUnavailable().message); return; }
    mutationSnapshot(result, onSnapshot, onError);
  };
  return <div className="modal-body trash-panel"><div className="settings-heading"><Trash2 size={19} /><div><h3>Trash</h3><p>Removed records can be restored while their parents remain available.</p></div></div>{trash.length ? <div className="trash-list">{trash.map(item => <div className="trash-row" key={`${item.kind}-${item.id}`}><div><strong>{item.name}</strong><span>{item.kind}{item.ancestorName ? ` · inside trashed ${item.ancestorName}` : ''}</span>{item.ancestorId && <small>Restore {item.ancestorName} first to restore this record.</small>}</div><div><button className="button button-small" onClick={() => void restore(item)} disabled={Boolean(item.ancestorId) || mode === 'demo'}>Restore</button><button className="icon-button danger-button" onClick={() => void purge(item)} disabled={mode === 'demo'} aria-label={`Permanently delete ${item.name}`}><Trash2 size={15} /></button></div></div>)}</div> : <div className="empty-state"><Trash2 size={28} /><strong>Trash is empty</strong><span>Deleted records will appear here until permanently removed.</span></div>}<p className="muted-note">Permanent deletion removes the record and its metadata. Existing backups are unchanged.</p></div>;
}

function RecordFormPanel({ kind, onClose, notebook, entry, mode, onSnapshot, onError, onBeforeOperation }: PanelsProps & { kind: 'new-notebook' | 'new-experiment' | 'repeat' }) {
  const isNotebook = kind === 'new-notebook';
  const repeat = kind === 'repeat';
  const [name, setName] = useState(repeat ? entry?.title ?? '' : '');
  const [description, setDescription] = useState('');
  const [discipline, setDiscipline] = useState('Chemistry');
  const [color, setColor] = useState<'sage' | 'blue' | 'clay'>('sage');
  const [label, setLabel] = useState(repeat ? entry?.label ?? '' : '');
  const [title, setTitle] = useState(repeat ? entry?.title ?? '' : '');
  const [date, setDate] = useState(repeat ? todayLocalDate() : todayLocalDate());
  const [author, setAuthor] = useState(repeat ? entry?.author ?? '' : '');
  const [busy, setBusy] = useState(false);
  const valid = isNotebook ? Boolean(name.trim()) : Boolean(label.trim() && title.trim() && date && author.trim() && notebook);
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!valid || busy) return;
    if (mode === 'demo') { onClose(); return; }
    if (!(await onBeforeOperation())) return;
    const api = getAPI(); if (!api) { onError(apiUnavailable().message); return; }
    setBusy(true);
    if (isNotebook) {
      const result = await api.records.createNotebook({ name: name.trim(), description: description.trim(), discipline: discipline.trim(), color });
      if (result.ok) { onSnapshot(result.value); onClose(); } else onError(result.error.message);
    } else if (repeat && entry) {
      const result = await api.records.repeatRun({ runId: entry.id, date });
      if (result.ok) { onSnapshot(result.value); onClose(); } else onError(result.error.message);
    } else if (notebook) {
      const result = await api.records.createExperiment({ notebookId: notebook.id, label: label.trim(), title: title.trim(), date, author: author.trim() });
      if (result.ok) { onSnapshot(result.value); onClose(); } else onError(result.error.message);
    }
    setBusy(false);
  };
  return <Modal title={isNotebook ? 'New notebook' : repeat ? 'Repeat experiment' : 'New experiment'} eyebrow={isNotebook ? 'Notebook directory' : notebook?.name} onClose={onClose}>
    <form onSubmit={submit}><div className="modal-body form-stack"><p className="panel-intro">{isNotebook ? 'A dedicated space for a project, research question, or experimental series.' : repeat ? 'Keep another run connected to the same experiment. Information and Method are copied; Notes and Data start empty.' : 'Start an experimental record in this notebook.'}</p>
      {isNotebook ? <><label className="field-label">Notebook name<input aria-label="Notebook name" value={name} onChange={event => setName(event.target.value)} placeholder="e.g. Photochemistry" autoFocus /></label><label className="field-label">Description<textarea rows={3} value={description} onChange={event => setDescription(event.target.value)} placeholder="What will you explore in this notebook?" /></label><div className="form-columns"><label className="field-label">Discipline<input value={discipline} onChange={event => setDiscipline(event.target.value)} /></label><label className="field-label">Accent<select value={color} onChange={event => setColor(event.target.value as typeof color)}><option value="sage">Sage</option><option value="blue">Blue</option><option value="clay">Clay</option></select></label></div></> : <><label className="field-label">Entry title{repeat && <small className="field-help">Copied from the original run</small>}<input aria-label="Entry title" value={title} onChange={event => setTitle(event.target.value)} placeholder="e.g. Catalyst loading comparison" autoFocus readOnly={repeat} /></label><div className="form-columns"><label className="field-label">Experiment label<input aria-label="Experiment label" value={label} onChange={event => setLabel(event.target.value)} placeholder="e.g. Catalyst-screen" readOnly={repeat} /></label><label className="field-label">Experiment date<input aria-label="Experiment date" type="date" value={date} onChange={event => setDate(event.target.value)} /></label></div><label className="field-label">Author{repeat && <small className="field-help">Copied from the original run</small>}<input aria-label="Author" value={author} onChange={event => setAuthor(event.target.value)} placeholder="Your name" readOnly={repeat} /></label><div className="numbering-note"><span className="code-label">{repeat ? `${label}-${entry?.experimentNumber ?? 'N'}-Y` : '[label]-N-Y'}</span><p>{repeat ? 'N stays with the experiment. Y identifies the new run. Title, Information, Method, and author are copied.' : 'N identifies the experiment in this notebook. Y identifies its run.'}</p></div></>}
      {mode === 'demo' && <div className="planned-callout"><ShieldCheck size={16} /><span>Demonstration mode is read-only. Switch to the real library to create durable records.</span></div>}
    </div><div className="modal-footer"><button type="button" className="button" onClick={onClose}>Cancel</button><button type="submit" className="button button-primary" disabled={!valid || busy || mode === 'demo'}>{busy ? 'Saving…' : isNotebook ? 'Create notebook' : repeat ? 'Create repeat run' : 'Create experiment'}</button></div></form>
  </Modal>;
}

function MetadataPanel({ target, onClose, notebook, entry, snapshot, mode, onSnapshot, onError, onBeforeOperation }: PanelsProps & { target: 'notebook' | 'experiment' | 'run' }) {
  const experiment = entry ? snapshot.experiments.find(item => item.id === entry.experimentId) : undefined;
  const [name, setName] = useState(target === 'notebook' ? notebook?.name ?? '' : target === 'experiment' ? experiment?.label ?? '' : entry?.title ?? '');
  const [description, setDescription] = useState(notebook?.description ?? '');
  const [discipline, setDiscipline] = useState(notebook?.discipline ?? '');
  const [date, setDate] = useState(entry?.date ?? todayLocalDate());
  const [author, setAuthor] = useState(entry?.author ?? '');
  const [busy, setBusy] = useState(false);
  const submit = async (event: React.FormEvent) => {
    event.preventDefault(); if (busy || mode === 'demo') return;
    if (!(await onBeforeOperation())) return;
    const api = getAPI(); if (!api) { onError(apiUnavailable().message); return; }
    const latest = await api.records.snapshot(undefined);
    if (!latest.ok) { onError(latest.error.message); return; }
    const currentNotebook = notebook ? latest.value.notebooks.find(item => item.id === notebook.id) : undefined;
    const currentExperiment = entry ? latest.value.experiments.find(item => item.id === entry.experimentId) : undefined;
    const currentRun = entry ? latest.value.runs.find(item => item.id === entry.id) : undefined;
    setBusy(true);
    if (target === 'notebook' && currentNotebook) {
      const result = await api.records.updateNotebook({ id: currentNotebook.id, expectedRevision: currentNotebook.revision, changes: { name: name.trim(), description: description.trim(), discipline: discipline.trim() } });
      if (result.ok) { onSnapshot(result.value); onClose(); } else onError(result.error.message);
    } else if (target === 'experiment' && currentExperiment) {
      const result = await api.records.updateExperiment({ id: currentExperiment.id, expectedRevision: currentExperiment.revision, label: name.trim() });
      if (result.ok) { onSnapshot(result.value); onClose(); } else onError(result.error.message);
    } else if (target === 'run' && currentRun) {
      const result = await api.records.updateRun({ id: currentRun.id, expectedRevision: currentRun.revision, changes: { title: name.trim(), date, author: author.trim() } });
      if (result.ok) { onSnapshot(result.value); onClose(); } else onError(result.error.message);
    } else onError('That record is no longer available. Reload the library and try again.');
    setBusy(false);
  };
  return <Modal title={`Edit ${target}`} eyebrow={target === 'notebook' ? notebook?.name : entry ? entryCode(entry) : undefined} onClose={onClose}><form onSubmit={submit}><div className="modal-body form-stack">{target === 'notebook' && <><label className="field-label">Notebook name<input value={name} onChange={event => setName(event.target.value)} autoFocus /></label><label className="field-label">Description<textarea rows={3} value={description} onChange={event => setDescription(event.target.value)} /></label><label className="field-label">Discipline<input value={discipline} onChange={event => setDiscipline(event.target.value)} /></label></>}{target === 'experiment' && <label className="field-label">Experiment label<input value={name} onChange={event => setName(event.target.value)} autoFocus /></label>}{target === 'run' && <><label className="field-label">Entry title<input value={name} onChange={event => setName(event.target.value)} autoFocus /></label><div className="form-columns"><label className="field-label">Date<input type="date" value={date} onChange={event => setDate(event.target.value)} /></label><label className="field-label">Author<input value={author} onChange={event => setAuthor(event.target.value)} /></label></div></>}{mode === 'demo' && <div className="planned-callout"><ShieldCheck size={16} /><span>Demonstration mode is read-only.</span></div>}</div><div className="modal-footer"><button type="button" className="button" onClick={onClose}>Cancel</button><button type="submit" className="button button-primary" disabled={busy || mode === 'demo' || !name.trim()}>Save changes</button></div></form></Modal>;
}

function SchemePanel({ schemeId, onClose, notebook, snapshot, mode, onSnapshot, onError, onBeforeOperation }: PanelsProps & { schemeId?: string }) {
  const scheme = schemeId ? snapshot.schemes.find(item => item.id === schemeId) : undefined;
  const [name, setName] = useState(scheme?.name ?? '');
  const [description, setDescription] = useState(scheme?.description ?? '');
  const [runIds, setRunIds] = useState<string[]>(scheme?.runIds ?? []);
  const runs = notebook ? snapshot.runs.filter(run => run.notebookId === notebook.id && isActiveRun(snapshot, run)) : [];
  const selected = useMemo(() => new Set(runIds), [runIds]);
  const [busy, setBusy] = useState(false);
  const focusRunRef = useRef<string | null>(null);
  const move = (runId: string, offset: number) => setRunIds(current => {
    const index = current.indexOf(runId);
    const target = index + offset;
    if (index < 0 || target < 0 || target >= current.length) return current;
    const next = [...current];
    [next[index], next[target]] = [next[target], next[index]];
    focusRunRef.current = runId;
    return next;
  });
  useEffect(() => {
    const id = focusRunRef.current;
    if (!id) return;
    Array.from(document.querySelectorAll<HTMLElement>('[data-scheme-run]')).find(element => element.dataset.schemeRun === id)?.focus();
    focusRunRef.current = null;
  }, [runIds]);
  const orderedRuns = useMemo(() => {
    const byId = new Map(runs.map(run => [run.id, run]));
    const members = runIds.map(id => byId.get(id)).filter((run): run is (typeof runs)[number] => Boolean(run));
    const available = runs.filter(run => !selected.has(run.id));
    return [...members, ...available];
  }, [runIds, runs, selected]);
  const save = async (event: React.FormEvent) => {
    event.preventDefault(); if (!name.trim() || !notebook || mode === 'demo' || busy) return;
    if (!(await onBeforeOperation())) return;
    const api = getAPI(); if (!api) { onError(apiUnavailable().message); return; }
    const latest = await api.records.snapshot(undefined);
    if (!latest.ok) { onError(latest.error.message); return; }
    const currentScheme = scheme ? latest.value.schemes.find(item => item.id === scheme.id) : undefined;
    const currentNotebook = latest.value.notebooks.find(item => item.id === notebook.id && !item.trashedAt);
    if (!currentNotebook || (scheme && !currentScheme)) { onError('That scheme is no longer available. Reload the notebook and try again.'); return; }
    const currentRuns = latest.value.runs.filter(run => run.notebookId === currentNotebook.id && isActiveRun(latest.value, run));
    const orderedRunIds = runIds.filter(id => currentRuns.some(run => run.id === id));
    setBusy(true);
    const result = currentScheme ? await api.schemes.update({ id: currentScheme.id, expectedRevision: currentScheme.revision, name: name.trim(), description: description.trim(), runIds: orderedRunIds }) : await api.schemes.create({ notebookId: currentNotebook.id, name: name.trim(), description: description.trim(), runIds: orderedRunIds });
    if (result.ok) { onSnapshot(result.value); onClose(); } else onError(result.error.message); setBusy(false);
  };
  const remove = async () => {
    if (!scheme || mode === 'demo' || !window.confirm(`Remove scheme “${scheme.name}”? Runs will remain in the notebook.`)) return;
    if (!(await onBeforeOperation())) return;
    const result = await getAPI()?.schemes.remove({ id: scheme.id, expectedRevision: scheme.revision });
    if (!result) { onError(apiUnavailable().message); return; }
    if (result.ok) { onSnapshot(result.value); onClose(); } else onError(result.error.message);
  };
  return <Modal title={scheme ? 'Edit scheme' : 'New scheme'} eyebrow={notebook?.name} onClose={onClose} wide><form onSubmit={save}><div className="modal-body form-stack"><p className="panel-intro">Schemes are ordered views. Adding or removing a run never deletes the underlying record.</p><div className="form-columns"><label className="field-label">Scheme name<input value={name} onChange={event => setName(event.target.value)} autoFocus placeholder="e.g. Route A" /></label><label className="field-label">Description<input value={description} onChange={event => setDescription(event.target.value)} placeholder="What belongs in this sequence?" /></label></div><fieldset className="scheme-members"><legend>Ordered members</legend><p className="field-help">Use the arrows, or focus a row and press Option + Arrow Up/Down.</p>{orderedRuns.map(run => { const index = runIds.indexOf(run.id); const included = selected.has(run.id); return <div className={`scheme-member ${included ? 'included' : ''}`} key={run.id} data-scheme-run={run.id} tabIndex={0} onKeyDown={event => { if (!included) return; if (event.altKey && event.key === 'ArrowUp') { event.preventDefault(); move(run.id, -1); } if (event.altKey && event.key === 'ArrowDown') { event.preventDefault(); move(run.id, 1); } }}><label><input type="checkbox" checked={included} onChange={event => { if (!event.target.checked) focusRunRef.current = null; setRunIds(current => event.target.checked ? [...current, run.id] : current.filter(id => id !== run.id)); }} /><span>{included && <small className="scheme-order-number">{index + 1}</small>}<strong>{run.title}</strong><small>{entryCode(run)}</small></span></label>{included && <span className="scheme-member-actions"><button type="button" className="icon-button" aria-label={`Move ${run.title} up`} disabled={index <= 0} onClick={() => move(run.id, -1)}><ArrowUp size={14} /></button><button type="button" className="icon-button" aria-label={`Move ${run.title} down`} disabled={index < 0 || index >= runIds.length - 1} onClick={() => move(run.id, 1)}><ArrowDown size={14} /></button></span>}</div>; })}{!runs.length && <div className="empty-state"><List size={24} /><strong>No active runs</strong><span>Create a run before adding scheme members.</span></div>}</fieldset>{mode === 'demo' && <div className="planned-callout"><ShieldCheck size={16} /><span>Demonstration mode is read-only.</span></div>}</div><div className="modal-footer">{scheme && <button type="button" className="button danger-outline" onClick={() => void remove()} disabled={mode === 'demo' || busy}>Remove scheme</button>}<span className="footer-spacer" /><button type="button" className="button" onClick={onClose}>Cancel</button><button className="button button-primary" disabled={!name.trim() || mode === 'demo' || busy}>{busy ? 'Saving…' : 'Save scheme'}</button></div></form></Modal>;
}

function AttachmentPanel({ attachment, onClose, mode, onSnapshot, onError, onBeforeOperation }: PanelsProps & { attachment: Attachment }) {
  const [caption, setCaption] = useState(attachment.caption);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const saveCaption = async () => {
    if (mode === 'demo' || caption === attachment.caption) return;
    if (!(await onBeforeOperation())) return;
    const result = await getAPI()?.attachments.update({ id: attachment.id, caption });
    if (!result) { onError(apiUnavailable().message); return; }
    if (result.ok) { onSnapshot(result.value); setMessage('Caption saved.'); } else onError(result.error.message);
  };
  const openFile = async () => {
    if (mode === 'demo') { setMessage('Associated-app opening is unavailable in demonstration mode.'); return; }
    const result = await getAPI()?.attachments.open({ id: attachment.id });
    if (!result) { onError(apiUnavailable().message); return; }
    if (result.ok) setMessage(result.value.opened ? 'Opened in the associated app.' : 'The associated app could not open this file.'); else onError(result.error.message);
  };
  const remove = async () => {
    if (mode === 'demo' || !window.confirm(`Remove “${attachment.name}” from this run?`)) return;
    if (!(await onBeforeOperation())) return;
    setBusy(true); const result = await getAPI()?.attachments.remove({ id: attachment.id });
    if (!result) { setBusy(false); onError(apiUnavailable().message); return; }
    if (result.ok) { onSnapshot(result.value); onClose(); } else onError(result.error.message); setBusy(false);
  };
  return <Modal title="Attachment details" eyebrow="Run data" onClose={onClose} wide><div className="modal-body attachment-panel"><div className="attachment-detail-heading"><span className={`file-icon ${attachment.kind}`}><AttachmentIcon kind={attachment.kind} size={24} /></span><div><h3>{attachment.name}</h3><p>{formatBytes(attachment.size)} · {attachment.mime || 'File'}</p></div></div><div className={`attachment-preview preview-${attachment.kind}`}>{mode === 'demo' ? <div className="demo-attachment-placeholder"><AttachmentIcon kind={attachment.kind} size={34} /><strong>Demonstration preview</strong><span>Real file previews are available in the local library.</span></div> : <AttachmentPreview attachmentId={attachment.id} />}</div><label className="field-label">Caption<textarea rows={3} value={caption} onChange={event => setCaption(event.target.value)} onBlur={() => void saveCaption()} disabled={mode === 'demo'} /></label><div className="attachment-actions"><button className="button" onClick={() => void openFile()}><Link size={14} />Open copy in associated app</button><button className="button danger-outline" onClick={() => void remove()} disabled={busy || mode === 'demo'}><Trash2 size={14} />Remove</button></div>{mode === 'demo' && <div className="planned-callout"><ShieldCheck size={16} /><span>Preview is illustrative in demonstration mode. Real files are available in the real library.</span></div>}{message && <p className="panel-status" role="status">{message}</p>}</div><div className="modal-footer"><span>Attachment metadata is stored with the run.</span><button className="button" onClick={onClose}>Done</button></div></Modal>;
}

function ExportPanel({ initialScope, onClose, notebook, entry, snapshot, selectedRunIds, mode, onError, onBeforeOperation }: PanelsProps & { initialScope: 'entry' | 'selected' | 'notebook' }) {
  const [scope, setScope] = useState(initialScope);
  const [format, setFormat] = useState<'txt' | 'md' | 'html' | 'rtf' | 'docx'>('docx');
  const [order, setOrder] = useState('newest');
  const [schemeId, setSchemeId] = useState('');
  const [selected, setSelected] = useState<string[]>(selectedRunIds.length ? selectedRunIds : entry ? [entry.id] : []);
  const [sectionOrder, setSectionOrder] = useState<SectionId[]>(sections.map(section => section.id));
  const [enabledSections, setEnabledSections] = useState<SectionId[]>(sections.map(section => section.id));
  const [data, setData] = useState<'none' | 'captions' | 'previews'>('captions');
  const [status, setStatus] = useState<'idle' | 'running' | 'cancelling' | 'saved' | 'cancelled' | 'error'>('idle');
  const [message, setMessage] = useState('');
  const [warnings, setWarnings] = useState<string[]>([]);
  const [progress] = useProgress('export');
  const [jobId, setJobId] = useState<string | null>(null);
  const runs = notebook ? snapshot.runs.filter(run => run.notebookId === notebook.id && isActiveRun(snapshot, run)) : [];
  const schemes = notebook ? snapshot.schemes.filter(scheme => scheme.notebookId === notebook.id) : [];
  const visibleOrder = useMemo(() => {
    const candidates = scope === 'entry' ? (entry ? [entry] : []) : scope === 'selected' ? runs.filter(run => selected.includes(run.id)) : runs;
    if (order === 'scheme' && schemeId) { const scheme = schemes.find(item => item.id === schemeId); const rank = new Map(scheme?.runIds.map((id, index) => [id, index])); return [...candidates].sort((a, b) => (rank?.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (rank?.get(b.id) ?? Number.MAX_SAFE_INTEGER) || a.id.localeCompare(b.id)); }
    return [...candidates].sort((a, b) => compareRuns(a, b, order));
  }, [entry, order, runs, schemeId, schemes, scope, selected]);
  const moveSection = (index: number, offset: number) => setSectionOrder(current => { const nextIndex = index + offset; if (nextIndex < 0 || nextIndex >= current.length) return current; const next = [...current]; [next[index], next[nextIndex]] = [next[nextIndex], next[index]]; return next; });
  const write = async () => {
    if (!notebook || status === 'running' || status === 'cancelling' || mode === 'demo') return;
    if (!(await onBeforeOperation())) return;
    const activeJobId = newJobId('export'); setJobId(activeJobId); setStatus('running'); setMessage('Preparing export…'); setWarnings([]);
    const api = getAPI(); if (!api) { setJobId(null); setStatus('error'); setMessage(apiUnavailable().message); onError(apiUnavailable().message); return; }
    const runIds = visibleOrder.map(run => run.id);
    const result = await api.exports.write({ scope, notebookId: notebook.id, runIds, format, order, schemeId: order === 'scheme' ? schemeId || undefined : undefined, sections: sectionOrder.filter(id => enabledSections.includes(id)), data, jobId: activeJobId });
    if (result.ok) { if (result.value.cancelled) { setStatus('cancelled'); setMessage('Export cancelled.'); } else { setStatus('saved'); setMessage(result.value.name ? `Saved ${result.value.name}.` : 'Export saved.'); setWarnings(result.value.warnings ?? []); } } else { setStatus('error'); setMessage(result.error.message); onError(result.error.message); }
    setJobId(null);
  };
  const cancel = async () => {
    const activeJobId = jobId ?? progress?.jobId;
    if (!activeJobId) return;
    const result = await getAPI()?.jobs.cancel({ jobId: activeJobId });
    if (!result) { onError(apiUnavailable().message); return; }
    if (!result.ok) { onError(result.error.message); return; }
    if (result.value.cancelled) { setStatus('cancelling'); setMessage('Cancellation requested…'); }
  };
  const formats = [['txt', 'Plain text (.txt)'], ['md', 'Markdown (.md)'], ['html', 'HTML (.html)'], ['rtf', 'Rich text (.rtf)'], ['docx', 'Word document (.docx)']] as const;
  return <Modal title="Export options" eyebrow={notebook?.name} onClose={onClose} wide><div className="modal-body form-stack export-body"><p className="panel-intro">Choose the entries, order, sections, and attachment policy for this export.</p><div className="form-columns"><label className="field-label">Export scope<select aria-label="Export scope" value={scope} onChange={event => setScope(event.target.value as typeof scope)}><option value="entry">This entry</option><option value="selected">Selected entries</option><option value="notebook">Whole notebook</option></select></label><label className="field-label">Format<select aria-label="Format" value={format} onChange={event => setFormat(event.target.value as typeof format)}>{formats.map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label></div>{scope === 'entry' && entry && <div className="export-entry-summary"><FileText size={19} /><div><strong>{entry.title}</strong><span>{entryCode(entry)}</span></div></div>}{scope === 'selected' && <fieldset className="entry-checkboxes"><legend>Entries to include</legend>{runs.map(run => <label key={run.id}><input type="checkbox" checked={selected.includes(run.id)} onChange={event => setSelected(current => event.target.checked ? [...current, run.id] : current.filter(id => id !== run.id))} /><span>{run.title}<small>{entryCode(run)}</small></span></label>)}</fieldset>}{scope !== 'entry' && <div className="form-columns"><label className="field-label">Entry ordering<select aria-label="Entry ordering" value={order} onChange={event => setOrder(event.target.value)}>{sortOptions.filter(([value]) => value !== 'scheme' || schemes.length > 0).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>{order === 'scheme' && <label className="field-label">Scheme<select aria-label="Scheme" value={schemeId} onChange={event => setSchemeId(event.target.value)}>{schemes.map(scheme => <option value={scheme.id} key={scheme.id}>{scheme.name}</option>)}</select></label>}</div>}<div className="export-order-preview"><span className="eyebrow">Resolved order</span>{visibleOrder.length ? visibleOrder.map((run, index) => <span key={run.id}><b>{index + 1}</b>{run.title}</span>) : <span className="muted-note">Choose at least one entry.</span>}</div><fieldset className="export-sections"><legend>Sections & order</legend><p className="field-help">Select sections and arrange their order.</p>{sectionOrder.map((id, index) => <div className="export-section-row" key={id}><label><input type="checkbox" checked={enabledSections.includes(id)} onChange={event => setEnabledSections(current => event.target.checked ? [...current, id] : current.filter(item => item !== id))} /><span className="order-number">{index + 1}</span>{sections.find(section => section.id === id)?.name}</label><div><button className="icon-button" disabled={index === 0} aria-label={`Move ${sections.find(section => section.id === id)?.short} up`} onClick={() => moveSection(index, -1)}><ArrowUp size={14} /></button><button className="icon-button" disabled={index === sectionOrder.length - 1} aria-label={`Move ${sections.find(section => section.id === id)?.short} down`} onClick={() => moveSection(index, 1)}><ArrowDown size={14} /></button></div></div>)}</fieldset><label className="field-label">Data inclusion<select aria-label="Data inclusion" value={data} onChange={event => setData(event.target.value as typeof data)}><option value="none">Do not include data</option><option value="captions">Filenames & captions</option><option value="previews">Available previews & captions</option></select></label><div className="format-loss-note"><strong>Format behavior</strong><span>Plain text and Markdown preserve readable content; HTML, RTF, and DOCX preserve basic headings, marks, lists, and tables. Unsupported scientific previews are described by caption.</span></div>{progress && <ProgressStatus event={progress} />}{message && <p className="panel-status" role="status">{message}</p>}{warnings.map(warning => <p className="panel-warning" key={warning}>Warning: {warning}</p>)}</div><div className="modal-footer"><span>{status === 'saved' ? 'Saved' : status === 'cancelled' ? 'Cancelled' : status === 'cancelling' ? 'Cancellation requested…' : status === 'error' ? 'Export failed' : 'A native save dialog will choose the destination.'}</span>{status === 'running' || status === 'cancelling' ? <button className="button" onClick={() => void cancel()} disabled={status === 'cancelling'}><XCircle size={15} />{status === 'cancelling' ? 'Cancelling…' : 'Cancel'}</button> : <button className="button button-primary" onClick={() => void write()} disabled={mode === 'demo' || !notebook || !visibleOrder.length || !enabledSections.length}>{mode === 'demo' ? 'Demo mode' : status === 'saved' ? 'Export again' : 'Export'}</button>}</div></Modal>;
}

function CitationPanel({ onClose }: { onClose: () => void }) {
  return <Modal title="Citation library" eyebrow="References in context" onClose={onClose}><div className="modal-body empty-state citation-unavailable"><Cloud size={30} /><h3>Zotero is unavailable</h3><p>Connect a supported Zotero library before citation controls become available. LabMate has no fictional references to display.</p><span className="soft-badge">Integration deferred</span></div><div className="modal-footer"><span>No library data is loaded.</span><button className="button" onClick={onClose}>Done</button></div></Modal>;
}
