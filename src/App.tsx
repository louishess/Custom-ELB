import { useLayoutEffect, useRef, useState } from 'react';
import { ArrowDownUp, ArrowLeft, ArrowRight, BookOpen, CalendarDays, ChevronDown, ChevronRight, Columns3, FileText, FlaskConical, FolderOpen, GitBranch, GripVertical, Grid2X2, LayoutList, Library, List, Plus, Quote, Repeat2, Search, Settings, SlidersHorizontal, Upload, UserRound } from 'lucide-react';
import { CitationChips, EditorToolbar, EntrySections, Planned, SectionNavigation } from './components';
import { entries, entryCode, formatDate, initialStatuses, notebooks, schemes, sortOptions } from './fixtures';
import { Panels } from './panels';
import Tracker from './Tracker';
import { applyAppearance } from './appearance';
import type { Entry, EntryLayout, EntryStatus, Notebook, Panel, SectionId } from './types';

export default function App() {
  const [page, setPage] = useState<'notebooks' | 'tracker'>('notebooks');
  const [appearance, setAppearance] = useState(0);
  const [statuses, setStatuses] = useState<Record<string, EntryStatus>>({ ...initialStatuses });
  useLayoutEffect(() => { applyAppearance(appearance); }, [appearance]);
  const [notebookId, setNotebookId] = useState<string | null>(null);
  const [entryId, setEntryId] = useState(entries[0].id);
  const [schemeId, setSchemeId] = useState<string | null>(null);
  const [sort, setSort] = useState('newest');
  const [layout, setLayout] = useState<EntryLayout>('continuous');
  const [activeSection, setActiveSection] = useState<SectionId>('information');
  const [panel, setPanel] = useState<Panel | null>(null);
  const [directoryView, setDirectoryView] = useState<'grid' | 'list'>('grid');
  const contentPane = useRef<HTMLDivElement>(null);
  const notebook = notebooks.find(item => item.id === notebookId);
  const entry = entries.find(item => item.id === entryId)!;
  const notebookSchemes = schemes.filter(item => item.notebookId === notebookId);
  const scheme = notebookSchemes.find(item => item.id === schemeId);
  const visibleEntries = scheme ? scheme.entryIds.map(id => entries.find(item => item.id === id)!) : entries.filter(item => item.notebookId === notebookId);

  function openNotebook(id: string, selectedEntryId?: string) {
    setPage('notebooks');
    setNotebookId(id);
    setEntryId(selectedEntryId ?? entries.find(item => item.notebookId === id)!.id);
    setSchemeId(null);
    setSort('newest');
    setActiveSection('information');
    contentPane.current?.scrollTo({ top: 0 });
  }
  function openEntry(id: string) {
    setEntryId(id);
    setActiveSection('information');
    contentPane.current?.scrollTo({ top: 0 });
  }
  function openScheme(id: string) {
    setPage('notebooks');
    const selected = schemes.find(item => item.id === id)!;
    setSchemeId(id);
    setSort('scheme');
    openEntry(selected.entryIds[0]);
  }
  function selectSection(section: SectionId) {
    setActiveSection(section);
    if (layout === 'continuous') {
      const target = document.getElementById(`section-${section}`);
      target?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      target?.focus({ preventScroll: true });
    }
  }
  function openDirectory() { setPage('notebooks'); setNotebookId(null); }

  return <div className="app-shell">
    <header className="window-bar"><div className="window-left" /><span className="window-title">LabMate</span><span className="preview-indicator"><i />Frontend preview</span></header>
    <div className="app-body">
      <aside className="sidebar" aria-label="Main navigation">
        <button className="brand" onClick={openDirectory} aria-label="LabMate home"><span className="brand-icon"><BookOpen size={23} strokeWidth={1.65} /></span><span>LabMate<small>Electronic lab notebook</small></span></button>
        <div className="sidebar-section">
          <span className="sidebar-label">Workspace</span>
          <button className={`nav-item ${page === 'notebooks' && !notebook ? 'selected' : ''}`} onClick={openDirectory}><Library size={18} /><span>All notebooks</span><span className="nav-count">{notebooks.length}</span></button>
          <button className="nav-item" onClick={() => setPanel({ kind: 'citations' })}><Quote size={18} /><span>Citation library</span></button>
        </div>
        <div className="sidebar-section organization-nav"><span className="sidebar-label">Organization</span><button className={`nav-item ${page === 'tracker' ? 'selected' : ''}`} onClick={() => setPage('tracker')} aria-current={page === 'tracker' ? 'page' : undefined}><Columns3 size={18} /><span>Experiment tracker</span></button></div>
        <div className="sidebar-section notebook-nav"><div className="sidebar-section-heading"><span className="sidebar-label">Notebooks</span><button className="icon-button" aria-label="New notebook" onClick={() => setPanel({ kind: 'new-notebook' })}><Plus size={16} /></button></div>
          {notebooks.map(item => <button key={item.id} className={`nav-item ${page === 'notebooks' && item.id === notebookId ? 'selected' : ''}`} onClick={() => openNotebook(item.id)}><span className={`notebook-dot ${item.color}`} /><span>{item.name}</span></button>)}
        </div>
        {page === 'notebooks' && notebook && <div className="sidebar-section scheme-nav"><div className="sidebar-section-heading"><span className="sidebar-label">Schemes</span><button className="icon-button" disabled title="Create scheme — planned" aria-label="Create scheme — planned"><Plus size={16} /></button></div>
          {notebookSchemes.map(item => <button className={`nav-item ${item.id === schemeId ? 'selected' : ''}`} key={item.id} onClick={() => openScheme(item.id)}><GitBranch size={16} /><span>{item.name}</span></button>)}
          <p className="sidebar-hint">Your experiments, in your order.</p>
        </div>}
        <div className="sidebar-bottom"><div className="settings-row"><button className="nav-item" onClick={() => setPanel({ kind: 'settings' })}><Settings size={18} /><span>Settings</span></button><button className="appearance-shortcut icon-button" onClick={() => setPanel({ kind: 'settings' })} aria-label="Adjust appearance" title="Adjust appearance"><SlidersHorizontal size={17} /></button></div><div className="preview-note"><span className="preview-dot" /><div><strong>A first look</strong><span>Fictional content. Nothing is saved.</span></div></div></div>
      </aside>

      {page === 'tracker' ? <Tracker statuses={statuses} onStatusChange={(id, status) => setStatuses(current => ({ ...current, [id]: status }))} onOpenEntry={openNotebook} /> : !notebook ? <main className="directory-main">
        <div className="breadcrumb-bar"><span><FolderOpen size={15} />Workspace<span className="breadcrumb-slash">/</span><strong>All notebooks</strong></span><span className="quiet-label">Personal workspace</span></div>
        <div className="directory-content">
          <div className="page-heading"><div><span className="eyebrow">A place for your curiosity</span><h1>Lab notebooks<span className="heading-spark" aria-hidden="true">✦</span></h1><p>A home for your experiments, observations, and discoveries.</p></div><button className="button button-primary" onClick={() => setPanel({ kind: 'new-notebook' })}><Plus size={17} />New notebook</button></div>
          <div className="directory-controls"><div className="underlined-label">All notebooks <span>{notebooks.length}</span></div><div className="view-toggle" aria-label="Notebook view"><button aria-label="Grid view" aria-pressed={directoryView === 'grid'} className={directoryView === 'grid' ? 'selected' : ''} onClick={() => setDirectoryView('grid')}><Grid2X2 size={16} /></button><button aria-label="List view" aria-pressed={directoryView === 'list'} className={directoryView === 'list' ? 'selected' : ''} onClick={() => setDirectoryView('list')}><List size={17} /></button></div></div>
          <div className={`notebook-cards ${directoryView}`}>{notebooks.map((item, index) => <NotebookCard notebook={item} index={index} key={item.id} onOpen={() => openNotebook(item.id)} />)}</div>
          <div className="recent-heading"><h2>Recent entries</h2><span>The latest pages across your notebooks</span></div>
          <div className="recent-entries"><div className="recent-table-heading"><span>Entry</span><span>Notebook</span><span>Experiment date</span><span /></div>{[entries[0], entries[4], entries[6], entries[1]].map(item => <button key={item.id} className="recent-row" onClick={() => openNotebook(item.notebookId, item.id)}><span className="recent-entry-name"><span className="recent-file-icon"><FileText size={18} /></span><span><strong>{item.title}</strong><small>{entryCode(item)}</small></span></span><span className="recent-notebook"><i className={`notebook-dot ${notebooks.find(book => book.id === item.notebookId)!.color}`} />{notebooks.find(book => book.id === item.notebookId)!.name}</span><span className="recent-date">{formatDate(item.date)}</span><ChevronRight size={15} /></button>)}</div>
          <div className="workspace-footnote"><FlaskConical size={19} /><p><strong>Built around the experiment.</strong> Keep methods, notes, data, and references together.</p><span className="soft-badge">Interface skeleton</span></div>
        </div>
      </main> : <main className="notebook-main">
        <div className="breadcrumb-bar"><span><button className="breadcrumb-back" onClick={() => setNotebookId(null)} aria-label="Back to all notebooks"><ArrowLeft size={15} /></button><span>Notebooks</span><span className="breadcrumb-slash">/</span><strong>{notebook.name}</strong></span><button className="button button-small" onClick={() => setPanel({ kind: 'export', scope: 'notebook' })}><Upload size={14} />Export notebook</button></div>
        <div className="workspace-columns">
          <aside className="entry-list-panel" aria-label="Notebook entries">
            <div className="entry-list-heading"><span className="eyebrow">{notebook.discipline}</span><h2>{notebook.name}</h2><span className="entry-count">{entries.filter(item => item.notebookId === notebook.id).length} {entries.filter(item => item.notebookId === notebook.id).length === 1 ? 'entry' : 'entries'} <span>·</span> {notebookSchemes.length} {notebookSchemes.length === 1 ? 'scheme' : 'schemes'}</span></div>
            <div className="entry-actions"><button className="button button-primary" onClick={() => setPanel({ kind: 'new-experiment' })}><Plus size={16} />New experiment</button></div>
            <div className="entry-list-controls"><div className="search-field"><Search size={15} /><input disabled aria-label="Search entries — planned" placeholder="Search entries · planned" /></div><label className="sort-control"><ArrowDownUp size={14} /><select aria-label="Sort entries" value={sort} onChange={event => {
              setSort(event.target.value);
              if (event.target.value === 'scheme' && notebookSchemes.length) openScheme(notebookSchemes[0].id);
              else setSchemeId(null);
            }}>{sortOptions.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select><ChevronDown size={13} /></label><span className="sorting-note">{scheme ? 'Sample scheme sequence' : 'Sort controls shown; ordering is planned'}</span></div>
            {scheme && <div className="scheme-summary"><GitBranch size={16} /><strong>{scheme.name}</strong><p>{scheme.description}</p><div><button className="button button-small" disabled><Plus size={12} />Add entry <Planned /></button><span title="Reordering — planned"><GripVertical size={15} /><Planned>Reorder planned</Planned></span></div></div>}
            <div className="entry-items">{visibleEntries.map((item, index) => <EntryListItem entry={item} key={item.id} selected={item.id === entryId} sequence={scheme ? index + 1 : undefined} onSelect={() => openEntry(item.id)} />)}</div>
            <div className="entry-list-footer"><button className="text-button" onClick={() => setPanel({ kind: 'export', scope: 'selected' })}><Upload size={14} />Export selected entries</button><span>{visibleEntries.length} {visibleEntries.length === 1 ? 'entry' : 'entries'} shown</span></div>
          </aside>
          <div className="entry-workspace">
            <div className="entry-topbar"><span><FileText size={14} />Entry <span className="topbar-separator">/</span><span className="topbar-entry-code">{entryCode(entry)}</span></span><div><button className="button button-small" onClick={() => setPanel({ kind: 'repeat' })}><Repeat2 size={14} />Repeat experiment</button><button className="button button-small" onClick={() => setPanel({ kind: 'export', scope: 'entry' })}><Upload size={14} />Export entry</button></div></div>
            <EditorToolbar />
            <SectionNavigation layout={layout} activeSection={activeSection} onSelect={selectSection} />
            <div className="entry-scroll" ref={contentPane} key={entry.id}>
              <article className="entry-document">
                <header className="entry-document-header"><span className="entry-code-badge">{entryCode(entry)}</span><h1>{entry.title}</h1><div className="entry-metadata"><span><CalendarDays size={14} />{formatDate(entry.date)}</span><span><UserRound size={14} />{entry.author}</span><span className="run-badge">Run {entry.runNumber} of experiment {entry.experimentNumber}</span></div><CitationChips entry={entry} onOpen={() => setPanel({ kind: 'citations' })} /></header>
                <EntrySections entry={entry} layout={layout} activeSection={activeSection} onAttachment={attachment => setPanel({ kind: 'attachment', attachment })} onCitations={() => setPanel({ kind: 'citations' })} />
              </article>
            </div>
            <div className="entry-status"><span><span className="status-dot" />Sample content · editing planned</span><button onClick={() => setPanel({ kind: 'settings' })}><LayoutList size={13} />{layout === 'continuous' ? 'Continuous page' : 'Section tabs'}</button></div>
          </div>
        </div>
      </main>}
    </div>
    {panel && <Panels panel={panel} key={panel.kind} onClose={() => setPanel(null)} layout={layout} setLayout={setLayout} appearance={appearance} setAppearance={setAppearance} notebook={notebook} entry={entry} />}
  </div>;
}

function NotebookCard({ notebook, index, onOpen }: { notebook: Notebook; index: number; onOpen: () => void }) {
  const count = entries.filter(entry => entry.notebookId === notebook.id).length;
  return <button className={`notebook-card ${notebook.color}`} onClick={onOpen}>
    <div className="notebook-cover"><div className="cover-spine" /><span className="cover-index">NOTEBOOK / 0{index + 1}</span><div className="cover-symbol">{index === 0 ? <FlaskConical size={32} strokeWidth={1.1} /> : index === 1 ? <LayersDrawing /> : <TraceDrawing />}</div><span className="cover-discipline">{notebook.discipline}</span><span className="cover-rule" /></div>
    <div className="notebook-card-content"><h2>{notebook.name}<ArrowRight size={17} /></h2><p>{notebook.description}</p><div className="notebook-card-footer"><span><FileText size={13} />{count} {count === 1 ? 'entry' : 'entries'}</span><span>Updated {formatDate(notebook.modified).replace(', 2026', '')}</span></div></div>
  </button>;
}

function EntryListItem({ entry, selected, sequence, onSelect }: { entry: Entry; selected: boolean; sequence?: number; onSelect: () => void }) {
  return <button className={`entry-list-item ${selected ? 'selected' : ''}`} onClick={onSelect} aria-current={selected ? 'page' : undefined}>
    <div className="entry-item-kicker"><span>{sequence !== undefined ? <span className="sequence-number">{String(sequence).padStart(2, '0')}</span> : <FileText size={13} />}{entryCode(entry)}</span>{entry.runNumber > 1 && <Repeat2 size={13} />}</div>
    <strong>{entry.title}</strong><p>{entry.objective}</p><span className="entry-item-footer">{formatDate(entry.date).replace(', 2026', '')}<span>{entry.attachments.length} {entry.attachments.length === 1 ? 'file' : 'files'}</span></span>
  </button>;
}

function LayersDrawing() {
  return <svg width="44" height="42" viewBox="0 0 44 42" fill="none" aria-hidden="true"><path d="m22 3 19 11-19 11L3 14 22 3Zm-18 19 18 11 18-11M4 30l18 10 18-10" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" /></svg>;
}
function TraceDrawing() {
  return <svg width="50" height="42" viewBox="0 0 50 42" fill="none" aria-hidden="true"><path d="M2 3v36h46M4 34h8l4-8 3 7h7L32 7l5 27h10" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" strokeLinecap="round" /></svg>;
}
