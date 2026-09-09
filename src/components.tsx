import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import { AlignLeft, ArrowDownToLine, Bold, ChevronDown, FileImage, FileSpreadsheet, FileText, FlaskConical, Highlighter, Italic, Link, List, ListOrdered, Mic, Plus, Quote, Sigma, Subscript, Superscript, Table2, Underline, X } from 'lucide-react';
import { citations, sections } from './fixtures';
import type { Attachment, Entry, EntryLayout, SectionId } from './types';

export function Planned({ children = 'Planned' }: { children?: ReactNode }) {
  return <span className="planned-label">{children}</span>;
}

export function Modal({ title, eyebrow, children, onClose, wide = false }: { title: string; eyebrow?: string; children: ReactNode; onClose: () => void; wide?: boolean }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const element = dialog.current!;
    element.showModal();
    heading.current?.focus();
    return () => { element.close(); previous?.focus(); };
  }, []);
  return <dialog ref={dialog} className={`modal ${wide ? 'modal-wide' : ''}`} aria-labelledby="panel-title" onCancel={onClose} onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="modal-header">
      <div>{eyebrow && <span className="eyebrow">{eyebrow}</span>}<h2 id="panel-title" ref={heading} tabIndex={-1}>{title}</h2></div>
      <button className="icon-button close-button" aria-label="Close panel" onClick={onClose}><X size={19} /></button>
    </div>
    {children}
  </dialog>;
}

export function AttachmentIcon({ kind, size = 21 }: { kind: Attachment['kind']; size?: number }) {
  if (kind === 'image') return <FileImage size={size} />;
  if (kind === 'spreadsheet') return <FileSpreadsheet size={size} />;
  if (kind === 'scientific') return <Sigma size={size} />;
  return <FileText size={size} />;
}

export function AttachmentCard({ attachment, onOpen }: { attachment: Attachment; onOpen: () => void }) {
  return <button className="attachment-card" onClick={onOpen}>
    <span className={`file-icon ${attachment.kind}`}><AttachmentIcon kind={attachment.kind} /></span>
    <span className="attachment-text"><strong>{attachment.name}</strong><span>{attachment.kind === 'scientific' ? 'Raw instrument data' : attachment.kind === 'image' ? 'Image' : attachment.kind === 'pdf' ? 'PDF document' : 'Spreadsheet'} <span aria-hidden="true">·</span> {attachment.size}</span></span>
    <span className="attachment-open" aria-hidden="true">↗</span>
  </button>;
}

const tools = [
  { label: 'Bold', icon: Bold }, { label: 'Italic', icon: Italic }, { label: 'Underline', icon: Underline },
  { label: 'Highlight', icon: Highlighter }, { label: 'Alignment', icon: AlignLeft },
  { label: 'Bulleted list', icon: List }, { label: 'Numbered list', icon: ListOrdered },
  { label: 'Link', icon: Link }, { label: 'Table', icon: Table2 },
  { label: 'Subscript', icon: Subscript }, { label: 'Superscript', icon: Superscript },
];

export function EditorToolbar() {
  return <div className="editor-toolbar" aria-label="Planned text formatting controls">
    <button className="text-style-control" disabled title="Heading styles — planned">Body <ChevronDown size={12} /></button>
    <span className="toolbar-divider" />
    {tools.map(({ label, icon: Icon }) => <button key={label} className="format-button" disabled title={`${label} — planned`} aria-label={`${label} — planned`}><Icon size={16} /></button>)}
    <span className="toolbar-note">Editing planned</span>
  </div>;
}

export function SectionNavigation({ layout, activeSection, onSelect }: { layout: EntryLayout; activeSection: SectionId; onSelect: (section: SectionId) => void }) {
  return <nav className={`section-navigation ${layout}`} aria-label="Entry sections" role={layout === 'tabs' ? 'tablist' : undefined} onKeyDown={event => {
    if (layout !== 'tabs' || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const current = sections.findIndex(section => section.id === activeSection);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? sections.length - 1 : (current + (event.key === 'ArrowRight' ? 1 : -1) + sections.length) % sections.length;
    onSelect(sections[next].id);
    document.getElementById(`tab-${sections[next].id}`)?.focus();
  }}>
    {sections.map(section => <button key={section.id} id={`tab-${section.id}`} role={layout === 'tabs' ? 'tab' : undefined} tabIndex={layout === 'tabs' && activeSection !== section.id ? -1 : 0} aria-selected={layout === 'tabs' ? activeSection === section.id : undefined} aria-controls={layout === 'tabs' && activeSection === section.id ? `section-${section.id}` : undefined} aria-current={layout === 'continuous' && activeSection === section.id ? 'location' : undefined} onClick={() => onSelect(section.id)} className={activeSection === section.id ? 'active' : ''}>{section.short}</button>)}
    <span className="layout-caption">{layout === 'tabs' ? 'Section tabs' : 'Continuous page'}</span>
  </nav>;
}

export function EntrySections({ entry, layout, activeSection, onAttachment, onCitations }: { entry: Entry; layout: EntryLayout; activeSection: SectionId; onAttachment: (attachment: Attachment) => void; onCitations: () => void }) {
  return <div className="entry-sections">
    {sections.filter(section => layout === 'continuous' || section.id === activeSection).map((section) => <section key={section.id} id={`section-${section.id}`} className="entry-section" role={layout === 'tabs' ? 'tabpanel' : undefined} aria-labelledby={layout === 'tabs' ? `tab-${section.id}` : `heading-${section.id}`} tabIndex={-1}>
      <div className="section-heading"><h2 id={`heading-${section.id}`}><span className="section-number">0{sections.findIndex(s => s.id === section.id) + 1}</span>{section.name}</h2>
        {section.id === 'notes' && <button className="button button-small" disabled title="Dictation — planned"><Mic size={14} /> Dictate <Planned /></button>}
        {section.id === 'data' && <button className="button button-small" disabled title="Add files — planned"><Plus size={14} /> Add files <Planned /></button>}
      </div>
      {section.id === 'information' && <>
        <div className="objective"><span className="eyebrow">Objective</span><p>{entry.objective}</p></div>
        <p>{entry.description}</p>
        <div className="information-grid"><div><span>Experiment</span><strong>{String(entry.experimentNumber).padStart(2, '0')}</strong></div><div><span>Run</span><strong>{String(entry.runNumber).padStart(2, '0')}</strong></div><div><span>Recorded by</span><strong>{entry.author}</strong></div></div>
      </>}
      {section.id === 'method' && <div className="prose">
        <h3>Procedure</h3><ol>{entry.method.map(step => <li key={step}>{step}</li>)}</ol>
        <table className="sample-table"><caption>Example materials record</caption><thead><tr><th>Material</th><th>Amount</th><th>Record</th></tr></thead><tbody><tr><td>{entry.reagent}</td><td>{entry.amount}</td><td>Reference sample</td></tr><tr><td>Comparison set</td><td>1 series</td><td>See attached data</td></tr></tbody></table>
        <p className="formatting-example"><strong>Formatting example:</strong> <em>reference condition</em>, <u>sample label</u>, H<sub>2</sub>O, and cm<sup>−1</sup>. <button className="inline-link" onClick={onCitations}>View reference</button></p>
      </div>}
      {section.id === 'notes' && <div className="prose"><p>{entry.observation}</p><div className="observation-note"><span className="eyebrow">For the next run</span><p><mark>{entry.nextStep}</mark></p></div><ul className="note-list"><li>Keep supporting observations with the experimental record.</li><li>Use repeat-run numbers to connect related entries.</li></ul></div>}
      {section.id === 'data' && <>
        <p className="section-description">Supporting files, kept alongside the experiment.</p>
        {entry.attachments.length ? <div className="attachment-grid">{entry.attachments.map(attachment => <AttachmentCard key={attachment.id} attachment={attachment} onOpen={() => onAttachment(attachment)} />)}</div> : <div className="empty-state"><ArrowDownToLine size={25} /><strong>No sample attachments</strong><span>Future entries will hold images, documents, and instrument data here.</span></div>}
        <p className="caption">Illustrative files only. File handling and format-specific viewers are planned.</p>
      </>}
    </section>)}
    <div className="document-end"><FlaskConical size={15} /><span>Fictional sample content</span><span className="end-line" /></div>
  </div>;
}

export function CitationChips({ entry, onOpen }: { entry: Entry; onOpen: () => void }) {
  return <div className="citation-chips"><Quote size={14} /><span className="citation-label">References</span>{entry.citationIds.map(id => {
    const citation = citations.find(ref => ref.id === id)!;
    return <button key={id} onClick={onOpen}>{citation.authors.split(';')[0]} · {citation.year}</button>;
  })}<button className="citation-plus" onClick={onOpen} aria-label="Open citation library"><Plus size={14} /></button></div>;
}
