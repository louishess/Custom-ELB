import { useEffect, useRef, useState } from 'react';
import { Mark, mergeAttributes } from '@tiptap/core';
import type { Editor } from '@tiptap/core';
import { closeHistory } from '@tiptap/pm/history';
import { Copy, FlaskConical, PackageCheck } from 'lucide-react';
import materialYield from '../shared/material-yield.cjs';
import yieldMath from '../shared/yield.cjs';
import type { ManualMaterial } from '../shared/material-yield.cjs';
import { Modal } from './components';
import type { SectionDocuments } from '../shared/contracts';
import './material-yield.css';

type Role = 'starting' | 'product';
const labels = {starting:'Starting material', product:'Product'};
export const YieldMaterial = Mark.create({
  name: 'yieldMaterial',
  inclusive: false,
  excludes: 'yieldMaterial',
  addAttributes() { return {role:{default:null, rendered:false}, id:{default:null, rendered:false}, manual:{default:null, rendered:false}}; },
  parseHTML() { return [{tag:'span[data-yield-material]', getAttrs:element => {
    const role = element.getAttribute('data-yield-material');
    const id = element.getAttribute('data-yield-id');
    let manual: unknown;
    try {manual = JSON.parse(element.getAttribute('data-yield-manual') || 'null');} catch {return false;}
    return (role === 'starting' || role === 'product') && id && /^[A-Za-z0-9_-]{1,128}$/.test(id) && (manual == null || materialYield.validateManualMaterial(manual)) ? {role,id,manual} : false;
  }}]; },
  renderHTML({mark, HTMLAttributes}) {
    const role: Role = mark.attrs.role === 'product' ? 'product' : 'starting';
    return ['span', mergeAttributes(HTMLAttributes, {'data-yield-material':role, 'data-yield-id':mark.attrs.id, class:`yield-material yield-material-${role}`, title:labels[role], ...(mark.attrs.manual ? {'data-yield-manual':JSON.stringify(mark.attrs.manual)} : {})}), 0];
  },
});

export function MaterialYieldControls({editor, disabled, documents, getDocuments, runId, editors}: {
  editor?: Editor | null; disabled: boolean; documents: SectionDocuments; getDocuments: () => SectionDocuments; runId: string; editors: Partial<Record<keyof SectionDocuments, Editor>>;
}) {
  const [, refresh] = useState(0);
  const [message, setMessage] = useState('');
  const [copying, setCopying] = useState(false);
  const copyEpoch = useRef(0);
  const pendingCopy = useRef(false);
  const documentFingerprint = JSON.stringify(documents);
  const [manualTarget, setManualTarget] = useState<{editor:Editor; from:number; to:number; document:unknown; text:string; role:Role; id:string; copyAfter:boolean} | null>(null);
  const [manualLabel, setManualLabel] = useState('');
  const [manualAmount, setManualAmount] = useState('');
  const [manualUnit, setManualUnit] = useState<ManualMaterial['molarUnit']>('mmol');
  const [manualEquivalents, setManualEquivalents] = useState('');
  const [manualError, setManualError] = useState('');
  function openManual(target: NonNullable<typeof manualTarget>, previous?: ManualMaterial) {
    setManualTarget(target); setManualError('');
    setManualLabel(previous?.label ?? target.text.split('(')[0].trim().slice(0,500));
    setManualAmount(previous?.molarAmount ?? ''); setManualUnit(previous?.molarUnit ?? 'mmol'); setManualEquivalents(previous?.equivalents ?? '');
  }
  function editMarked(role: Role, id: string, copyAfter = false) {
    for (const owner of Object.values(editors)) {
      let from = -1, to = -1; let previous: ManualMaterial | undefined;
      owner.state.doc.descendants((node, position) => {
        const mark = node.marks.find(item => item.type.name === 'yieldMaterial' && item.attrs.id === id && item.attrs.role === role);
        if (node.isText && mark) {if (from < 0) {from = position; previous = mark.attrs.manual ?? undefined;} to = position + node.nodeSize;}
      });
      if (from >= 0) {
        const text = owner.state.doc.textBetween(from,to,'\n');
        openManual({editor:owner,from,to,document:owner.state.doc,text,role,id,copyAfter}, previous?.sourceText === text ? previous : undefined);
        return true;
      }
    }
    setMessage('Select the material again before entering its amounts.'); return false;
  }
  function saveManual() {
    if (!manualTarget) return;
    const manual: ManualMaterial = {version:1, sourceText:manualTarget.text,label:manualLabel.trim(),molarAmount:manualAmount.trim(),molarUnit:manualUnit,equivalents:manualEquivalents.trim()};
    if (!manual.label) {setManualError('Enter a material label.'); return;}
    if (!materialYield.validateManualMaterial(manual) || (manualTarget.role === 'starting' && Number(manual.molarAmount) <= 0)) {setManualError('Enter a valid molar amount and positive equivalents. Starting material must be positive; product may be zero.'); return;}
    const owner = manualTarget.editor;
    if (owner.isDestroyed || owner.state.doc !== manualTarget.document) {setManualError('The marked text changed. Cancel and select the material again.'); return;}
    pendingCopy.current = manualTarget.copyAfter;
    owner.view.dispatch(closeHistory(owner.state.tr));
    owner.chain().focus().setTextSelection({from:manualTarget.from,to:manualTarget.to}).setMark('yieldMaterial',{role:manualTarget.role,id:manualTarget.id,manual}).run();
    owner.view.dispatch(closeHistory(owner.state.tr));
    setManualTarget(null); setMessage('Material amounts saved with the highlight.');
  }
  useEffect(() => {
    setMessage(''); copyEpoch.current++; setCopying(false);
    if (pendingCopy.current) {pendingCopy.current = false; void copyYield();}
  }, [documentFingerprint, runId]);
  useEffect(() => {
    if (!editor) return;
    const update = () => refresh(value => value + 1);
    editor.on('transaction', update); editor.on('selectionUpdate', update);
    return () => {editor.off('transaction', update); editor.off('selectionUpdate', update);};
  }, [editor]);
  useEffect(() => () => {copyEpoch.current++;}, []);
  const marked = materialYield.collectMarkedMaterials(documents);
  const result = materialYield.calculateMarkedYield(documents);
  const hasMarks = marked.starting.length > 0 || marked.product.length > 0 || marked.errors.length > 0;
  function markMaterial(role: Role) {
    if (!editor || disabled) return;
    if (editor.isActive('yieldMaterial', {role})) {
      const attrs = editor.getAttributes('yieldMaterial');
      editor.view.dispatch(closeHistory(editor.state.tr));
      editor.chain().focus().extendMarkRange('yieldMaterial', {role:attrs.role,id:attrs.id}).unsetMark('yieldMaterial').run();
      editor.view.dispatch(closeHistory(editor.state.tr));
      setMessage(`${labels[role]} mark removed.`);
      return;
    }
    const {from, to, empty, $from, $to} = editor.state.selection;
    if (empty) {setMessage('Select the complete chemical name and its parenthesized amounts, then mark it.'); return;}
    let unsupported = !$from.sameParent($to);
    editor.state.doc.nodesBetween(from, to, node => {if (node.isLeaf && !node.isText) unsupported = true;});
    if (unsupported) {setMessage('Select one complete material within a single paragraph, without line breaks or embedded items.'); return;}
    const text = editor.state.doc.textBetween(from, to, '\n');
    const parsed = materialYield.parseMaterial(text);
    const current = materialYield.collectMarkedMaterials(getDocuments());
    if (current[role].length) {setMessage(`A ${labels[role].toLowerCase()} is already marked in this run. Click inside its highlight and use the same button to remove it first.`); return;}
    if (parsed.status !== 'valid' || (role === 'starting' && Number(parsed.molarAmount) <= 0)) {openManual({editor,from,to,document:editor.state.doc,text,role,id:crypto.randomUUID(),copyAfter:false}); return;}
    editor.view.dispatch(closeHistory(editor.state.tr));
    editor.chain().focus().setMark('yieldMaterial', {role,id:crypto.randomUUID(),manual:null}).run();
    editor.view.dispatch(closeHistory(editor.state.tr));
    setMessage(`${labels[role]} marked: ${parsed.label}.`);
  }
  async function copyYield() {
    const current = getDocuments();
    const calculation = materialYield.calculateMarkedYield(current);
    const materials = materialYield.collectMarkedMaterials(current);
    if (calculation.status !== 'valid') {
      if (!materials.errors.length) for (const role of ['starting','product'] as const) {
        if (materials[role].length !== 1) continue;
        const marked = materials[role][0];
        const parsed = materialYield.resolveMaterial(marked.text, marked.manual);
        if (parsed.status !== 'valid' || (role === 'starting' && Number(parsed.molarAmount) <= 0)) {editMarked(role, marked.id, true); return;}
      }
      setMessage(calculation.message); return;
    }
    const epoch = ++copyEpoch.current;
    setCopying(true);
    try {
      if (window.labmate) {
        const copied = await window.labmate.yield.copy({starting:{text:materials.starting[0].text,manual:materials.starting[0].manual}, product:{text:materials.product[0].text,manual:materials.product[0].manual}});
        if (!copied.ok) throw new Error(copied.error.message);
      } else {
        await navigator.clipboard.writeText(calculation.summary);
      }
      if (epoch === copyEpoch.current) setMessage('Copied theoretical yield, actual yield and calculation basis.');
    } catch (error) {if (epoch === copyEpoch.current) setMessage(error instanceof Error ? error.message : 'Yield could not be copied. Try again.');}
    finally {if (epoch === copyEpoch.current) setCopying(false);}
  }
  return <>
    <span className="toolbar-divider" />
    <div className="material-yield-controls" role="group" aria-label="Yield markup">
      {(['starting','product'] as const).map(role => <button key={role} type="button" className={`format-button material-role-${role} ${editor?.isActive('yieldMaterial',{role}) ? 'active' : ''}`} disabled={!editor || disabled} aria-label={`Mark as ${role === 'starting' ? 'Starting Material' : 'Product'}`} title={`Mark as ${role === 'starting' ? 'Starting Material' : 'Product'} — select CHEMICAL (mass or volume, molar amount, eq.). Use again inside the highlight to remove.`} aria-pressed={Boolean(editor?.isActive('yieldMaterial',{role}))} onClick={() => markMaterial(role)}>{role === 'starting' ? <FlaskConical size={16} /> : <PackageCheck size={16} />}</button>)}
      <button type="button" className="format-button" disabled={disabled || copying} aria-label="Copy Yield" title="Copy Yield — theoretical amount, actual amount and percentage from this run’s marked materials" onClick={() => {void copyYield();}}><Copy size={16} /></button>
    </div>
    {(hasMarks || message) && <div className={`material-yield-status ${result.status === 'valid' && result.above100 ? 'yield-above-100' : ''}`} role="status" aria-live="polite">
      {result.status === 'valid' ? <span><strong>{yieldMath.formatPercentage(result.percentage)}% yield</strong> · Theoretical: {yieldMath.formatAmount(result.theoreticalAmount)} {result.product.molarUnit} · Actual: {result.product.molarAmount} {result.product.molarUnit}{result.above100 ? ' · Above 100%: check the marked amounts.' : ''}</span> : hasMarks && <span>{result.message}</span>}
      {message && <span className="material-yield-feedback">{message}</span>}
      {(['starting','product'] as const).map(role => marked[role].length === 1 && marked[role][0].manual && <button key={role} type="button" className="material-manual-edit" disabled={disabled} onClick={() => editMarked(role,marked[role][0].id)}>Edit {labels[role].toLowerCase()} amounts</button>)}
      <span className="material-yield-legend"><span className="yield-material yield-material-starting">Starting material</span><span className="yield-material yield-material-product">Product</span><span>Select a complete material to mark it; use its button again to remove the mark.</span></span>
    </div>}
    {manualTarget && <Modal title="Enter material amounts" eyebrow={labels[manualTarget.role]} onClose={() => setManualTarget(null)}>
      <form onSubmit={event => {event.preventDefault();saveManual();}}>
        <div className="modal-body material-manual-body">
          <p>Enter the molar amount and equivalents for this highlighted material.</p>
          <blockquote>{manualTarget.text}</blockquote>
          <label className="field-label">Material label<input autoFocus value={manualLabel} maxLength={500} onChange={event => setManualLabel(event.target.value)} /></label>
          <div className="material-manual-amount"><label className="field-label">Molar amount<input value={manualAmount} maxLength={100} placeholder="e.g. 1.5 or 1e-3" onChange={event => setManualAmount(event.target.value)} /></label>
            <label className="field-label">Molar unit<select aria-label="Molar unit" value={manualUnit} onChange={event => setManualUnit(event.target.value as ManualMaterial['molarUnit'])}>{Object.keys(yieldMath.UNITS).map(unit => <option key={unit}>{unit}</option>)}</select></label></div>
          <label className="field-label">Equivalents<input value={manualEquivalents} maxLength={100} placeholder="e.g. 1" onChange={event => setManualEquivalents(event.target.value)} /></label>
          {manualError && <p role="alert" className="panel-warning">{manualError}</p>}
          <p className="field-help">Saved with this highlight. Editing its text requires checking these amounts again.</p>
        </div>
        <div className="modal-footer"><button type="button" className="button" onClick={() => setManualTarget(null)}>Cancel</button><button type="submit" className="button button-primary">Save material amounts</button></div>
      </form>
    </Modal>}
  </>;
}
