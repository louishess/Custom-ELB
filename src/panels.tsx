import { useState } from 'react';
import { ArrowDown, ArrowRight, ArrowUp, BookOpen, Check, ChevronRight, Cloud, FileText, LayoutList, Link, List, Monitor, Quote, Search, Settings2 } from 'lucide-react';
import { AttachmentIcon, Modal, Planned } from './components';
import { citations, entries, entryCode, schemes, sections, sortOptions } from './fixtures';
import type { Attachment, Entry, EntryLayout, Notebook, Panel, SectionId } from './types';

export function Panels({ panel, onClose, layout, setLayout, notebook, entry }: { panel: Panel; onClose: () => void; layout: EntryLayout; setLayout: (layout: EntryLayout) => void; notebook?: Notebook; entry?: Entry }) {
  if (panel.kind === 'settings') return <Modal title="Settings" eyebrow="Make room for your work" onClose={onClose}>
    <div className="modal-body"><div className="settings-heading"><Monitor size={19} /><div><h3>Entry layout</h3><p>Choose how you move through an experiment.</p></div></div>
      <fieldset className="layout-options"><legend className="sr-only">Entry layout</legend>
        {(['continuous', 'tabs'] as const).map(option => <label className={`layout-option ${layout === option ? 'selected' : ''}`} key={option}>
          <input type="radio" name="layout" value={option} checked={layout === option} onChange={() => setLayout(option)} />
          <div className={`layout-miniature ${option}`} aria-hidden="true"><div className="mini-tabs"><i /><i /><i /></div><div className="mini-content"><span /><span /><span /></div>{option === 'continuous' && <div className="mini-content short"><span /><span /></div>}</div>
          <span className="layout-option-title">{option === 'continuous' ? <LayoutList size={16} /> : <List size={16} />}{option === 'continuous' ? 'Continuous page' : 'Section tabs'}{layout === option && <Check size={16} className="selection-check" />}</span>
          <span className="layout-option-description">{option === 'continuous' ? 'Read the full entry with section jump links.' : 'Focus on one section at a time.'}</span>
        </label>)}
      </fieldset><p className="muted-note">Applies to every notebook during this session. Settings reset when the app closes.</p>
      <div className="settings-about"><BookOpen size={19} /><div><strong>Custom ELB</strong><p>Frontend skeleton · 0.1.0</p></div><span className="soft-badge">Mac preview</span></div>
    </div><div className="modal-footer"><span>Layout changes apply immediately.</span><button className="button button-primary" onClick={onClose}>Done</button></div>
  </Modal>;
  if (panel.kind === 'export') return <ExportPanel initialScope={panel.scope} notebook={notebook!} entry={entry!} onClose={onClose} />;
  if (panel.kind === 'attachment') return <AttachmentPanel attachment={panel.attachment} onClose={onClose} />;
  if (panel.kind === 'citations') return <CitationPanel onClose={onClose} />;
  const isNotebook = panel.kind === 'new-notebook';
  const repeat = panel.kind === 'repeat';
  return <Modal title={isNotebook ? 'New notebook' : repeat ? 'Repeat experiment' : 'New experiment'} eyebrow={isNotebook ? 'Notebook directory' : notebook?.name} onClose={onClose}>
    <form onSubmit={event => event.preventDefault()}>
      <div className="modal-body form-stack"><p className="panel-intro">{isNotebook ? 'A dedicated space for a project, research question, or experimental series.' : repeat ? 'Keep another run connected to the same experiment.' : 'Start an experimental record in this notebook.'}</p>
        <label className="field-label">{isNotebook ? 'Notebook name' : 'Entry title'}<input placeholder={isNotebook ? 'e.g. Photochemistry' : 'e.g. Catalyst loading comparison'} defaultValue={repeat ? entry?.title : ''} /></label>
        <label className="field-label">{isNotebook ? 'Description' : 'Objective'}<textarea rows={3} placeholder={isNotebook ? 'What will you explore in this notebook?' : 'What is the purpose of this experiment?'} /></label>
        {isNotebook ? <label className="field-label">Discipline<select defaultValue="chemistry"><option value="chemistry">Chemistry</option><option>Materials science</option><option>Biology</option><option>General research</option></select></label> : <>
          <div className="form-columns"><label className="field-label">Experiment label<input placeholder="e.g. Catalyst-screen" defaultValue={repeat ? entry?.label : ''} readOnly={repeat} /></label><label className="field-label">Experiment date<input type="date" defaultValue="2026-09-08" /></label></div>
          <div className="numbering-note"><span className="code-label">{repeat ? `${entry?.label}-${entry?.experimentNumber}-Y` : '[label]-N-Y'}</span><p>{repeat ? 'N stays with the experiment. Y will identify the next run.' : 'N identifies the experiment in this notebook. Y identifies its run.'}</p></div>
        </>}
        <div className="planned-callout"><Settings2 size={16} /><span>Form preview. Creating records will be available in a future build.</span></div>
      </div><div className="modal-footer"><button type="button" className="button" onClick={onClose}>Cancel</button><button className="button button-primary" disabled>{isNotebook ? 'Create notebook' : repeat ? 'Create repeat run' : 'Create experiment'} <Planned /></button></div>
    </form>
  </Modal>;
}

function ExportPanel({ initialScope, notebook, entry, onClose }: { initialScope: 'entry' | 'selected' | 'notebook'; notebook: Notebook; entry: Entry; onClose: () => void }) {
  const [scope, setScope] = useState(initialScope);
  const [format, setFormat] = useState('docx');
  const [order, setOrder] = useState('newest');
  const [sectionOrder, setSectionOrder] = useState<SectionId[]>(sections.map(section => section.id));
  const notebookEntries = entries.filter(item => item.notebookId === notebook.id);
  const notebookSchemes = schemes.filter(scheme => scheme.notebookId === notebook.id);
  function moveSection(index: number, offset: number) {
    const updated = [...sectionOrder];
    [updated[index], updated[index + offset]] = [updated[index + offset], updated[index]];
    setSectionOrder(updated);
  }
  return <Modal title="Export options" eyebrow={notebook.name} onClose={onClose} wide>
    <div className="modal-body form-stack export-body">
      <p className="panel-intro">Choose what belongs in the exported record.</p>
      <div className="form-columns"><label className="field-label">Export scope<select aria-label="Export scope" value={scope} onChange={event => setScope(event.target.value as typeof scope)}><option value="entry">This entry</option><option value="selected">Selected entries</option><option value="notebook">Whole notebook</option></select></label>
      <label className="field-label">Format<select aria-label="Format" value={format} onChange={event => setFormat(event.target.value)}><option value="txt">Plain text (.txt)</option><option value="md">Markdown (.md)</option><option value="html">HTML (.html)</option><option value="rtf">Rich text (.rtf)</option><option value="docx">Word document (.docx)</option><option value="google">Google Docs</option></select></label></div>
      {scope === 'entry' && <div className="export-entry-summary"><FileText size={19} /><div><strong>{entry.title}</strong><span>{entryCode(entry)}</span></div></div>}
      {scope === 'selected' && <fieldset className="entry-checkboxes"><legend>Entries to include</legend>{notebookEntries.map(item => <label key={item.id}><input type="checkbox" defaultChecked={item.id === entry.id} /><span>{item.title}<small>{entryCode(item)}</small></span></label>)}</fieldset>}
      {scope !== 'entry' && <div className="form-columns"><label className="field-label">Entry ordering<select aria-label="Entry ordering" value={order} onChange={event => setOrder(event.target.value)}>{sortOptions.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>{order === 'scheme' && <label className="field-label">Scheme<select aria-label="Scheme" defaultValue={notebookSchemes[0]?.id}>{notebookSchemes.map(scheme => <option value={scheme.id} key={scheme.id}>{scheme.name}</option>)}</select></label>}</div>}
      {format === 'google' && <div className="planned-callout"><Cloud size={17} /><span>Google Docs is a future connected destination. No account connection is used here.</span></div>}
      <fieldset className="export-sections"><legend>Sections & order</legend><p className="field-help">Select sections and arrange their order.</p>{sectionOrder.map((id, index) => <div className="export-section-row" key={id}><label><input type="checkbox" defaultChecked /><span className="order-number">{index + 1}</span>{sections.find(section => section.id === id)?.name}</label><div><button className="icon-button" disabled={index === 0} aria-label={`Move ${sections.find(section => section.id === id)?.short} up`} onClick={() => moveSection(index, -1)}><ArrowUp size={14} /></button><button className="icon-button" disabled={index === sectionOrder.length - 1} aria-label={`Move ${sections.find(section => section.id === id)?.short} down`} onClick={() => moveSection(index, 1)}><ArrowDown size={14} /></button></div></div>)}</fieldset>
      <label className="field-label">Data inclusion<select aria-label="Data inclusion" defaultValue="captions"><option value="none">Do not include data</option><option value="captions">Filenames & captions</option><option value="previews">Available previews & captions</option></select></label>
    </div><div className="modal-footer"><span>Options only. Export generation is planned.</span><button className="button button-primary" disabled>Export <Planned /></button></div>
  </Modal>;
}

function CitationPanel({ onClose }: { onClose: () => void }) {
  const [selectedId, setSelectedId] = useState(citations[0].id);
  const citation = citations.find(item => item.id === selectedId)!;
  return <Modal title="Citation library" eyebrow="References in context" onClose={onClose} wide>
    <div className="modal-body citation-panel"><div className="zotero-banner"><span className="zotero-logo">Z</span><div><strong>Zotero</strong><p>Your reference library, connected to your experiments.</p></div><button className="button button-small" disabled>Connect <Planned /></button></div>
      <div className="search-field disabled-search"><Search size={16} /><input aria-label="Search citations — planned" placeholder="Search references · planned" disabled /></div>
      <div className="citation-browser"><div className="citation-list" aria-label="Sample citations">{citations.map(item => <button key={item.id} onClick={() => setSelectedId(item.id)} className={item.id === selectedId ? 'selected' : ''}><FileText size={17} /><span><strong>{item.title}</strong><small>{item.authors} · {item.year}</small></span><ChevronRight size={14} /></button>)}</div>
      <div className="citation-details"><Quote size={22} /><span className="eyebrow">Reference details</span><h3>{citation.title}</h3><p>{citation.authors}</p><dl><dt>Published</dt><dd>{citation.year}</dd><dt>Source</dt><dd>{citation.journal}</dd><dt>Collection</dt><dd>{citation.collection}</dd></dl><button className="button" disabled><Link size={14} /> Associate with entry <Planned /></button></div></div>
      <p className="muted-note">All references shown are fictional. No Zotero library is being accessed.</p>
    </div><div className="modal-footer"><span>Citation association is planned.</span><button className="button" onClick={onClose}>Done</button></div>
  </Modal>;
}

function AttachmentPanel({ attachment, onClose }: { attachment: Attachment; onClose: () => void }) {
  return <Modal title="Attachment details" eyebrow="Entry data" onClose={onClose} wide>
    <div className="modal-body"><div className="attachment-detail-heading"><span className={`file-icon ${attachment.kind}`}><AttachmentIcon kind={attachment.kind} size={24} /></span><div><h3>{attachment.name}</h3><p>{attachment.size} · Illustrative attachment</p></div></div>
      <div className={`attachment-preview preview-${attachment.kind}`}>
        {attachment.kind === 'image' && <svg className="sample-vials" viewBox="0 0 600 280" role="img" aria-label="Illustration of three sample vials containing pale yellow and amber liquids"><defs><linearGradient id="glass" x1="0" x2="1"><stop stopColor="#fff" stopOpacity=".9" /><stop offset=".6" stopColor="#eff1ec" stopOpacity=".3" /><stop offset="1" stopColor="#fff" stopOpacity=".8" /></linearGradient></defs><ellipse cx="300" cy="241" rx="183" ry="12" fill="#d5d7ce" opacity=".5" />{[0, 1, 2].map((index) => <g key={index} transform={`translate(${145 + index * 110}, 43)`}><rect x="3" y="20" width="72" height="176" rx="15" fill="url(#glass)" stroke="#b4bfb5" strokeWidth="2" /><path d="M5 96 H73 V180 Q73 194 59 194 H19 Q5 194 5 180Z" fill={['#ecdb8d', '#d1ae50', '#e3cd76'][index]} opacity=".7" /><rect width="78" height="28" rx="5" fill="#4c655b" /><path d="M12 7v15m9-15v15m9-15v15m9-15v15m9-15v15m9-15v15m9-15v15" stroke="#779084" strokeWidth="2" /><rect x="13" y="127" width="53" height="38" rx="3" fill="#fafbf7" /><text x="39" y="151" textAnchor="middle" fontSize="14" fill="#4b5850" fontFamily="sans-serif">{['A', 'B', 'C'][index]}</text><path d="M14 40V110" stroke="white" strokeWidth="4" strokeLinecap="round" /></g>)}</svg>}
        {attachment.kind === 'pdf' && <div className="sample-report"><div className="report-top"><span>ELB / SAMPLE REPORT</span><FileText size={18} /></div><h3>Acquisition summary</h3><p>Fictional instrument output</p><div className="report-line" /><svg viewBox="0 0 450 105" role="img" aria-label="Illustrative analytical trace"><path d="M10 88H440M10 10V88" fill="none" stroke="#c1c9c3" /><path d="M10 82H60L66 79L71 81H100L107 73L111 22L116 78L122 82H189L196 79L203 48L210 80H272L280 75L289 13L295 76L301 82H360L366 65L373 82H440" fill="none" stroke="#557b67" strokeWidth="2" /></svg><div className="report-columns"><span>Sample: reference series</span><span>Run: illustrative</span></div><div className="report-lines"><i /><i /><i /></div></div>}
        {attachment.kind === 'spreadsheet' && <div className="sample-sheet"><span className="eyebrow">Example measurements</span><table className="sample-table"><thead><tr><th>Sample</th><th>Relative response</th><th>Observation</th></tr></thead><tbody><tr><td>A</td><td>0.82</td><td>Reference</td></tr><tr><td>B</td><td>0.91</td><td>Comparison</td></tr><tr><td>C</td><td>0.87</td><td>Repeat</td></tr></tbody></table><span className="caption">Static fictional values · no file has been parsed</span></div>}
        {attachment.kind === 'scientific' && <div className="empty-state"><AttachmentIcon kind="scientific" size={35} /><h3>Preview support planned</h3><p>Raw scientific formats will use dedicated viewers.</p><span className="soft-badge">.fid · instrument data</span></div>}
      </div><p className="attachment-caption">{attachment.caption}</p><div className="planned-callout"><ArrowRight size={16} /><span>This is a static illustration. Opening and processing real files is planned.</span></div>
    </div><div className="modal-footer"><span>Sample file details</span><button className="button" onClick={onClose}>Done</button></div>
  </Modal>;
}
