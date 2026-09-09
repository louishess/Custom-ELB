import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { AlignCenter, AlignLeft, AlignRight, ArrowDownToLine, Bold, ChevronDown, FileImage, FileSpreadsheet, FileText, FlaskConical, Highlighter, Italic, Link, List, ListOrdered, Mic, Plus, Redo2, Sigma, Subscript, Superscript, Underline, Undo2, X } from 'lucide-react';
import { EditorContent, useEditor } from '@tiptap/react';
import type { Editor } from '@tiptap/core';
import { closeHistory } from '@tiptap/pm/history';
import StarterKit from '@tiptap/starter-kit';
import Highlight from '@tiptap/extension-highlight';
import SubscriptExtension from '@tiptap/extension-subscript';
import SuperscriptExtension from '@tiptap/extension-superscript';
import { TableKit } from '@tiptap/extension-table';
import TextAlign from '@tiptap/extension-text-align';
import type { Attachment, Entry, EntryLayout, SectionDocuments, SectionId } from './types';
import { formatBytes, sections } from './fixtures';
import { cloneDocuments } from './workflows';
import { YieldCalculation, DEFAULT_YIELD_INPUTS } from './YieldCalculation';
import DictationDialog from './DictationDialog';
import { TableControls } from './TableControls';

export function Planned({ children = 'Planned' }: { children?: ReactNode }) {
  return <span className="planned-label">{children}</span>;
}

export const ModalErrorContext = createContext('');

export function Modal({ title, eyebrow, children, onClose, wide = false }: { title: string; eyebrow?: string; children: ReactNode; onClose: () => void; wide?: boolean }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const panelError = useContext(ModalErrorContext);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const element = dialog.current;
    if (!element) return;
    if (!element.open) element.showModal();
    heading.current?.focus();
    return () => { if (element.open) element.close(); previous?.focus(); };
  }, []);
  return <dialog ref={dialog} className={`modal ${wide ? 'modal-wide' : ''}`} aria-labelledby="panel-title" onCancel={event => { event.preventDefault(); onClose(); }} onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="modal-header">
      <div>{eyebrow && <span className="eyebrow">{eyebrow}</span>}<h2 id="panel-title" ref={heading} tabIndex={-1}>{title}</h2></div>
      <button className="icon-button close-button" aria-label="Close panel" onClick={onClose}><X size={19} /></button>
    </div>
    {panelError && <p className="panel-warning modal-error" role="alert">{panelError}</p>}
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
  const typeName = attachment.kind === 'scientific' ? 'Raw instrument data' : attachment.kind === 'image' ? 'Image' : attachment.kind === 'pdf' ? 'PDF document' : attachment.kind === 'spreadsheet' ? 'Spreadsheet' : 'File';
  return <button className="attachment-card" onClick={onOpen} aria-label={`Open attachment ${attachment.name}`}>
    <span className={`file-icon ${attachment.kind}`}><AttachmentIcon kind={attachment.kind} /></span>
    <span className="attachment-text"><strong>{attachment.name}</strong><span>{typeName} <span aria-hidden="true">·</span> {formatBytes(attachment.size)}</span></span>
    <span className="attachment-open" aria-hidden="true">↗</span>
  </button>;
}

type ToolbarProps = { editor?: Editor | null; disabled?: boolean; onDictate?: () => void };

export function EditorToolbar({ editor, disabled = false, onDictate }: ToolbarProps) {
  const enabled = Boolean(editor) && !disabled;
  const [headingLevel, setHeadingLevel] = useState('paragraph');
  const [linkOpen, setLinkOpen] = useState(false);
  const [linkValue, setLinkValue] = useState('');
  const [linkMessage, setLinkMessage] = useState('');
  const linkSelection = useRef<{ from: number; to: number } | null>(null);
  useEffect(() => {
    if (!editor) return;
    const update = () => {
      const level = [1, 2, 3].find(candidate => editor.isActive('heading', { level: candidate }));
      setHeadingLevel(level ? `heading-${level}` : 'paragraph');
    };
    update();
    editor.on('selectionUpdate', update);
    editor.on('transaction', update);
    return () => { editor.off('selectionUpdate', update); editor.off('transaction', update); };
  }, [editor]);
  const button = (label: string, icon: ReactNode, action: () => void, active = false) => <button type="button" className={`format-button ${active ? 'active' : ''}`} disabled={!enabled} title={label} aria-label={label} aria-pressed={active} onClick={action}>{icon}</button>;
  return <div className="editor-toolbar" aria-label="Text formatting controls">
    <label className="text-style-label"><span className="sr-only">Text style</span><select className="text-style-control" aria-label="Text style" disabled={!enabled} value={headingLevel} onChange={event => {
      const value = event.target.value;
      if (!editor) return;
      if (value === 'paragraph') editor.chain().focus().setParagraph().run();
      else editor.chain().focus().toggleHeading({ level: Number(value.split('-')[1]) as 1 | 2 | 3 }).run();
    }}><option value="paragraph">Body</option><option value="heading-1">Heading 1</option><option value="heading-2">Heading 2</option><option value="heading-3">Heading 3</option></select><ChevronDown size={12} aria-hidden="true" /></label>
    <span className="toolbar-divider" />
    {button('Bold', <Bold size={16} />, () => editor?.chain().focus().toggleBold().run(), Boolean(editor?.isActive('bold')))}
    {button('Italic', <Italic size={16} />, () => editor?.chain().focus().toggleItalic().run(), Boolean(editor?.isActive('italic')))}
    {button('Underline', <Underline size={16} />, () => editor?.chain().focus().toggleUnderline().run(), Boolean(editor?.isActive('underline')))}
    {button('Highlight', <Highlighter size={16} />, () => editor?.chain().focus().toggleHighlight().run(), Boolean(editor?.isActive('highlight')))}
    <span className="toolbar-divider" />
    {button('Align left', <AlignLeft size={16} />, () => editor?.chain().focus().setTextAlign('left').run(), Boolean(editor?.isActive({ textAlign: 'left' })))}
    {button('Align center', <AlignCenter size={16} />, () => editor?.chain().focus().setTextAlign('center').run(), Boolean(editor?.isActive({ textAlign: 'center' })))}
    {button('Align right', <AlignRight size={16} />, () => editor?.chain().focus().setTextAlign('right').run(), Boolean(editor?.isActive({ textAlign: 'right' })))}
    {button('Bulleted list', <List size={16} />, () => editor?.chain().focus().toggleBulletList().run(), Boolean(editor?.isActive('bulletList')))}
    {button('Numbered list', <ListOrdered size={16} />, () => editor?.chain().focus().toggleOrderedList().run(), Boolean(editor?.isActive('orderedList')))}
    {button('Link', <Link size={16} />, () => {
      if (!editor) return;
      linkSelection.current = { from: editor.state.selection.from, to: editor.state.selection.to };
      setLinkValue(editor.getAttributes('link').href ?? '');
      setLinkMessage('');
      setLinkOpen(true);
    }, Boolean(editor?.isActive('link')))}
    <TableControls editor={editor} disabled={disabled} />
    {button('Subscript', <Subscript size={16} />, () => editor?.chain().focus().toggleSubscript().run(), Boolean(editor?.isActive('subscript')))}
    {button('Superscript', <Superscript size={16} />, () => editor?.chain().focus().toggleSuperscript().run(), Boolean(editor?.isActive('superscript')))}
    <span className="toolbar-divider" />
    {onDictate && button('Dictate', <Mic size={16} />, onDictate)}
    {button('Undo', <Undo2 size={16} />, () => editor?.chain().focus().undo().run())}
    {button('Redo', <Redo2 size={16} />, () => editor?.chain().focus().redo().run())}
    <span className="toolbar-note">{disabled ? 'Demo mode' : enabled ? 'Editing' : 'Select a section'}</span>
    {linkOpen && editor && <div className="link-popover" role="dialog" aria-label="Link settings">
      <label className="field-label">Link URL<input autoFocus aria-label="Link URL" value={linkValue} onChange={event => { setLinkValue(event.target.value); setLinkMessage(''); }} placeholder="https://example.com or mailto:you@example.com" /></label>
      <p className="field-help">Use an http, https, or mailto link. Leave blank to remove the link.</p>
      {linkMessage && <p className="panel-warning" role="alert">{linkMessage}</p>}
      <div className="link-popover-actions"><button type="button" className="button danger-outline" onClick={() => {
        const selection = linkSelection.current;
        const chain = editor.chain().focus();
        if (selection) chain.setTextSelection(selection);
        chain.unsetLink().run();
        setLinkOpen(false);
      }}>Remove link</button><span className="footer-spacer" /><button type="button" className="button" onClick={() => setLinkOpen(false)}>Cancel</button><button type="button" className="button button-primary" onClick={() => {
        const value = linkValue.trim();
        if (!value) {
          const selection = linkSelection.current;
          const chain = editor.chain().focus();
          if (selection) chain.setTextSelection(selection);
          chain.unsetLink().run();
          setLinkOpen(false);
          return;
        }
        if (!/^(https?:\/\/|mailto:)[^\s]+$/i.test(value)) {
          setLinkMessage('Enter a valid http, https, or mailto link.');
          return;
        }
        const selection = linkSelection.current;
        const chain = editor.chain().focus();
        if (selection) chain.setTextSelection(selection);
        chain.setLink({ href: value }).run();
        setLinkOpen(false);
      }}>Apply link</button></div>
    </div>}
  </div>;
}

const extensions = [
  StarterKit.configure({ link: { openOnClick: false, autolink: false, linkOnPaste: false } }),
  Highlight,
  YieldCalculation,
  SubscriptExtension,
  SuperscriptExtension,
  TextAlign.configure({ types: ['heading', 'paragraph'] }),
  TableKit.configure({ table: { resizable: true, cellMinWidth: 60, renderWrapper: true } }),
];

function RichSection({ id, document, onChange, onEditor, onFocus, readOnly, resetToken }: { id: SectionId; document: SectionDocuments[SectionId]; onChange: (document: SectionDocuments[SectionId]) => void; onEditor: (editor: Editor | null) => void; onFocus: (section: SectionId) => void; readOnly: boolean; resetToken: number }) {
  const editor = useEditor({
    extensions,
    content: document,
    editable: !readOnly,
    editorProps: { attributes: { class: 'tiptap-content', 'aria-label': `${sections.find(section => section.id === id)?.name ?? id} editor` } },
    onUpdate: ({ editor: next }) => onChange(next.getJSON() as SectionDocuments[SectionId]),
  });
  const lastReset = useRef(resetToken);
  const onEditorRef = useRef(onEditor);
  const onFocusRef = useRef(onFocus);
  useEffect(() => { onEditorRef.current = onEditor; }, [onEditor]);
  useEffect(() => { onFocusRef.current = onFocus; }, [onFocus]);
  useEffect(() => {
    if (!editor) return;
    const focus = () => onFocusRef.current(id);
    onEditorRef.current(editor);
    editor.on('focus', focus);
    return () => { editor.off('focus', focus); onEditorRef.current(null); };
  }, [editor, id]);
  useLayoutEffect(() => {
    if (!editor || lastReset.current === resetToken) return;
    lastReset.current = resetToken;
    editor.commands.setContent(document, { emitUpdate: false });
  }, [document, editor, resetToken]);
  useEffect(() => { editor?.setEditable(!readOnly, false); }, [editor, readOnly]);
  return <EditorContent editor={editor} />;
}

export interface RichEntryEditorProps {
  run: Entry;
  attachments?: Attachment[];
  documents: SectionDocuments;
  layout: EntryLayout;
  activeSection: SectionId;
  onDocumentsChange: (documents: SectionDocuments) => void;
  onEditor: (section: SectionId, editor: Editor | null) => void;
  onFocusSection?: (section: SectionId) => void;
  onAttachment: (attachment: Attachment) => void;
  onAddAttachments: () => void;
  readOnly?: boolean;
  resetToken?: number;
}

export function RichEntryEditor({ run, attachments = run.attachments ?? [], documents, layout, activeSection, onDocumentsChange, onEditor, onFocusSection, onAttachment, onAddAttachments, readOnly = false, resetToken = 0 }: RichEntryEditorProps) {
  const [editors, setEditors] = useState<Partial<Record<SectionId, Editor>>>({});
  const [dictation, setDictation] = useState<{ sessionId: string; runId: string; section: SectionId; editor: Editor; from: number; to: number; document: unknown } | null>(null);
  const runRef = useRef(run.id);
  useLayoutEffect(() => { runRef.current = run.id; }, [run.id]);
  const beginDictation = () => {
    const editor = editors[activeSection];
    if (!editor || readOnly) return;
    setDictation({sessionId: crypto.randomUUID(), runId: run.id, section: activeSection, editor, from: editor.state.selection.from, to: editor.state.selection.to, document: editor.state.doc});
  };
  const documentsRef = useRef(documents);
  useLayoutEffect(() => { documentsRef.current = documents; }, [documents]);
  const handleEditor = (section: SectionId, editor: Editor | null) => {
    setEditors(current => {
      if (editor && current[section] === editor) return current;
      const next = { ...current };
      if (editor) next[section] = editor;
      else delete next[section];
      return next;
    });
    onEditor(section, editor);
  };
  const handleChange = (section: SectionId, document: SectionDocuments[SectionId]) => {
    // Tiptap callbacks can run before React commits new props. Merge against
    // the latest complete draft so an edit in another section is never lost.
    const next = { ...documentsRef.current, [section]: document };
    documentsRef.current = next;
    onDocumentsChange(next);
  };
  return <>
    <EditorToolbar editor={editors[activeSection]} disabled={readOnly} onDictate={beginDictation} />
    {dictation && <DictationDialog sessionId={dictation.sessionId} originLabel={`${run.title} · ${sections.find(section => section.id === dictation.section)?.name}`} onCancel={() => setDictation(null)} onInsert={text => {
      if (runRef.current !== dictation.runId || dictation.editor.isDestroyed || dictation.editor.state.doc !== dictation.document) {
        throw new Error('The destination changed. Copy your transcript before closing and reopen dictation in the current section.');
      }
      const content = text.split(/\r?\n/).flatMap((line, index) => [...(index ? [{type: 'hardBreak'}] : []), ...(line ? [{type: 'text', text: line}] : [])]);
      dictation.editor.view.dispatch(closeHistory(dictation.editor.state.tr));
      if (!dictation.editor.chain().focus().setTextSelection({from: dictation.from, to: dictation.to}).insertContent(content).run()) throw new Error('The transcript could not be inserted. Copy it before closing.');
      dictation.editor.view.dispatch(closeHistory(dictation.editor.state.tr));
      setDictation(null);
    }} />}
    <div className="entry-sections">
      {sections.map((section, index) => <section key={section.id} id={`section-${section.id}`} className="entry-section" role={layout === 'tabs' ? 'tabpanel' : undefined} aria-labelledby={layout === 'tabs' ? `tab-${section.id}` : `heading-${section.id}`} tabIndex={-1} hidden={layout === 'tabs' && activeSection !== section.id}>
        <div className="section-heading"><h2 id={`heading-${section.id}`}><span className="section-number">0{index + 1}</span>{section.name}</h2>
          {section.id === 'data' && <button className="button button-small" type="button" disabled={readOnly} onClick={() => { onFocusSection?.('data'); if (editors.data) editors.data.view.dispatch(closeHistory(editors.data.state.tr)); editors.data?.chain().focus().insertContent([{type: 'yieldCalculation', attrs: {...DEFAULT_YIELD_INPUTS}}, {type: 'paragraph'}]).run(); }}><Sigma size={14} />Add yield calculation</button>}
          {section.id === 'data' && <button className="button button-small" type="button" onClick={onAddAttachments} disabled={readOnly}><Plus size={14} /> Add files{readOnly && <Planned>Demo</Planned>}</button>}
        </div>
        <RichSection id={section.id} document={documents[section.id]} onChange={document => handleChange(section.id, document)} onEditor={editor => handleEditor(section.id, editor)} onFocus={onFocusSection ?? (() => undefined)} readOnly={readOnly} resetToken={resetToken} />
        {section.id === 'data' && <>
          {attachments.length ? <div className="attachment-grid">{attachments.map(attachment => <AttachmentCard key={attachment.id} attachment={attachment} onOpen={() => onAttachment(attachment)} />)}</div> : <div className="empty-state"><ArrowDownToLine size={25} /><strong>No attachments yet</strong><span>Use Add files to keep supporting data with this run.</span></div>}
          <p className="caption">Files are managed inside the LabMate library.</p>
        </>}
      </section>)}
      <div className="document-end"><FlaskConical size={15} /><span>Saved experiment record</span><span className="end-line" /></div>
    </div>
  </>;
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

export function EntrySections({ entry, documents, layout, activeSection, onAttachment, onAddAttachments, onDocumentsChange, onEditor, onFocusSection, readOnly, resetToken, attachments }: Omit<RichEntryEditorProps, 'run'> & { entry: Entry }) {
  return <RichEntryEditor run={entry} attachments={attachments} documents={documents} layout={layout} activeSection={activeSection} onDocumentsChange={onDocumentsChange} onEditor={onEditor} onFocusSection={onFocusSection} onAttachment={onAttachment} onAddAttachments={onAddAttachments} readOnly={readOnly} resetToken={resetToken} />;
}

export function CitationChips({ onOpen, disabled = true }: { onOpen?: () => void; disabled?: boolean }) {
  return <div className="citation-chips"><FileText size={14} /><span className="citation-label">Citations</span><button type="button" disabled={disabled} onClick={onOpen} title="Citation library is unavailable until Zotero is connected">Unavailable</button></div>;
}

export function useDraftDocuments(documents: SectionDocuments) {
  const [draft, setDraft] = useState(() => cloneDocuments(documents));
  const update = (next: SectionDocuments) => setDraft(next);
  return [draft, update, setDraft] as const;
}
