import { useEffect, useRef, useState } from 'react';
import type { Editor } from '@tiptap/core';
import { findTable, TableMap } from '@tiptap/pm/tables';
import { closeHistory } from '@tiptap/pm/history';
import { Table2 } from 'lucide-react';
import './tables.css';

const minimumColumnWidth = 60;

/** Set every physical column in one transaction, including cells spanning columns. */
export function fitTableToEditor(editor: Editor): boolean {
  const table = findTable(editor.state.selection.$from);
  if (!table) return false;
  const map = TableMap.get(table.node);
  const width = Math.max(minimumColumnWidth, Math.floor((editor.view.dom.clientWidth - 2) / map.width));
  const transaction = closeHistory(editor.state.tr);
  for (const offset of new Set(map.map)) {
    const cell = table.node.nodeAt(offset);
    if (!cell) continue;
    transaction.setNodeMarkup(table.start + offset, undefined, { ...cell.attrs, colwidth: Array(cell.attrs.colspan).fill(width) });
  }
  editor.view.dispatch(transaction);
  editor.commands.focus();
  return true;
}

export function TableControls({ editor, disabled }: { editor?: Editor | null; disabled: boolean }) {
  const [, refresh] = useState(0);
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState('3');
  const [columns, setColumns] = useState('3');
  const [header, setHeader] = useState(true);
  const dialog = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const selection = useRef<{ from: number; to: number } | null>(null);
  useEffect(() => {
    setOpen(false);
    if (!editor) return;
    const update = () => refresh(value => value + 1);
    editor.on('transaction', update);
    return () => { editor.off('transaction', update); };
  }, [editor]);
  useEffect(() => {
    if (!open) return;
    const element = dialog.current;
    element?.showModal();
    return () => { element?.close(); trigger.current?.focus(); };
  }, [open]);
  const enabled = Boolean(editor) && !disabled;
  const inTable = enabled && editor?.isActive('table');
  const validSize = /^\d+$/.test(rows) && /^\d+$/.test(columns) && Number(rows) >= 1 && Number(rows) <= 50 && Number(columns) >= 1 && Number(columns) <= 20;
  const action = (name: string, command: () => void, available = true) => <button type="button" className="button button-small" disabled={!available} onClick={() => {
    if (!editor) return;
    // Each explicit table action has its own Undo step, even after rapid edits.
    editor.view.dispatch(closeHistory(editor.state.tr));
    command();
  }}>{name}</button>;
  return <>
    <button ref={trigger} type="button" className={`format-button ${inTable ? 'active' : ''}`} disabled={!enabled} title="Insert table" aria-label="Table" aria-haspopup="dialog" onClick={() => {
      if (!editor) return;
      selection.current = { from: editor.state.selection.from, to: editor.state.selection.to };
      setOpen(true);
    }}><Table2 size={16} /></button>
    {open && <dialog ref={dialog} className="modal table-insert-dialog" aria-labelledby="table-dialog-title" onCancel={event => { event.preventDefault(); setOpen(false); }}>
      <form onSubmit={event => {
        event.preventDefault();
        if (!editor || !enabled || !validSize) return;
        editor.view.dispatch(closeHistory(editor.state.tr));
        const chain = editor.chain().focus();
        if (selection.current) chain.setTextSelection(selection.current);
        chain.insertTable({ rows: Number(rows), cols: Number(columns), withHeaderRow: header }).run();
        setOpen(false);
      }}>
        <div className="modal-header"><h2 id="table-dialog-title">Insert table</h2></div>
        <div className="modal-body table-dialog-body">
          <div className="table-size-fields">
            <label className="field-label">Rows<input autoFocus type="number" min="1" max="50" step="1" required value={rows} onChange={event => setRows(event.target.value)} /></label>
            <label className="field-label">Columns<input type="number" min="1" max="20" step="1" required value={columns} onChange={event => setColumns(event.target.value)} /></label>
          </div>
          <label className="table-header-choice"><input type="checkbox" checked={header} onChange={event => setHeader(event.target.checked)} /> Include header row</label>
          <p className="field-help">Choose 1–50 rows and 1–20 columns. Resize columns by dragging a cell’s right edge; rows grow with their content.</p>
        </div>
        <div className="modal-footer table-dialog-actions"><button className="button" type="button" onClick={() => setOpen(false)}>Cancel</button><button className="button button-primary" type="submit" disabled={!validSize}>Insert table</button></div>
      </form>
    </dialog>}
    {inTable && editor && <div className="table-context-controls" role="group" aria-label="Table controls">
      <span className="table-controls-label">Table</span>
      {action('Row above', () => editor.chain().focus().addRowBefore().run())}
      {action('Row below', () => editor.chain().focus().addRowAfter().run())}
      {action('Remove row', () => editor.chain().focus().deleteRow().run(), editor.can().deleteRow())}
      {action('Column before', () => editor.chain().focus().addColumnBefore().run())}
      {action('Column after', () => editor.chain().focus().addColumnAfter().run())}
      {action('Remove column', () => editor.chain().focus().deleteColumn().run(), editor.can().deleteColumn())}
      {action('Toggle header row', () => editor.chain().focus().toggleHeaderRow().run())}
      {action('Toggle header column', () => editor.chain().focus().toggleHeaderColumn().run())}
      {action('Merge cells', () => editor.chain().focus().mergeCells().run(), editor.can().mergeCells())}
      {action('Split cell', () => editor.chain().focus().splitCell().run(), editor.can().splitCell())}
      {action('Fit columns to editor', () => { fitTableToEditor(editor); })}
      {action('Delete table', () => editor.chain().focus().deleteTable().run())}
      <span className="table-controls-help">Drag across cells to select them for merging. Undo restores table edits.</span>
    </div>}
  </>;
}
