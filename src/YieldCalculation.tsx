import { useId } from 'react';
import { Node, mergeAttributes } from '@tiptap/core';
import { closeHistory } from '@tiptap/pm/history';
import { NodeViewWrapper, ReactNodeViewRenderer } from '@tiptap/react';
import type { NodeViewProps } from '@tiptap/react';
import { Calculator, Trash2 } from 'lucide-react';
import yieldMath from '../shared/yield.cjs';
import type { YieldInputs, YieldUnit } from '../shared/yield.cjs';
import './yield-calculation.css';

export const { DEFAULT_YIELD_INPUTS } = yieldMath;

function YieldCard({ node, updateAttributes, deleteNode, editor, selected }: NodeViewProps) {
  const prefix = useId();
  const inputs = node.attrs as YieldInputs;
  const result = yieldMath.calculateYield(inputs);
  const disabled = !editor.isEditable;
  const input = (field: keyof YieldInputs, label: string, placeholder: string, numeric = false) => <label htmlFor={`${prefix}-${field}`}>
    <span>{label}</span><input id={`${prefix}-${field}`} type="text" value={String(inputs[field] ?? '')} placeholder={placeholder} disabled={disabled} maxLength={numeric ? 100 : 500} spellCheck={!numeric} onChange={event => updateAttributes({ [field]: event.target.value })} />
  </label>;
  const unit = (field: 'startingUnit' | 'productUnit', label: string) => <label htmlFor={`${prefix}-${field}`}><span>{label}</span><select id={`${prefix}-${field}`} value={inputs[field]} disabled={disabled} onChange={event => updateAttributes({ [field]: event.target.value as YieldUnit })}>{Object.keys(yieldMath.UNITS).map(value => <option key={value} value={value}>{value}</option>)}</select></label>;
  return <NodeViewWrapper className={`yield-card${selected ? ' selected' : ''}`} contentEditable={false}>
    <div className="yield-card-heading"><strong><Calculator size={17} />Yield calculation</strong><button type="button" className="button button-small" aria-label="Remove yield calculation" disabled={disabled} onClick={() => { editor.view.dispatch(closeHistory(editor.state.tr)); deleteNode(); editor.view.dispatch(closeHistory(editor.state.tr)); }}><Trash2 size={14} />Remove</button></div>
    <div className="yield-input-group"><h4>Starting material</h4>{input('materialLabel', 'Label (optional)', 'Material name')}
      <div className="yield-amount-row">{input('startingAmount', 'Amount', 'e.g. 2 or 2e-3', true)}{unit('startingUnit', 'Unit')}{input('startingEquivalents', 'Equivalents', '1', true)}</div>
    </div>
    <div className="yield-input-group"><h4>Product</h4>{input('productLabel', 'Label (optional)', 'Product name')}
      <div className="yield-amount-row">{input('productAmount', 'Amount', 'e.g. 750', true)}{unit('productUnit', 'Unit')}{input('productEquivalents', 'Equivalents', '1', true)}</div>
    </div>
    <div className="yield-result" role="status" aria-live="polite">{result.status === 'valid' ? <>
      <strong>{yieldMath.formatPercentage(result.percentage)}% yield</strong>
      <span>Theoretical product: {yieldMath.formatAmount(result.theoreticalAmount)} {inputs.productUnit}</span>
      {result.above100 && <span className="yield-warning">Above 100% — check the inputs and experimental result.</span>}
    </> : <span>{result.message}</span>}</div>
    <p className="yield-basis">Theoretical product = starting amount × product equivalents ÷ starting-material equivalents.<br />Yield = actual product ÷ theoretical product × 100, after unit conversion.</p>
  </NodeViewWrapper>;
}

export const YieldCalculation = Node.create({
  name: 'yieldCalculation',
  group: 'block',
  atom: true,
  isolating: true,
  draggable: false,
  addAttributes() {
    return Object.fromEntries(Object.entries(DEFAULT_YIELD_INPUTS).map(([key, value]) => [key, { default: value, rendered: false }]));
  },
  parseHTML() {
    return [{ tag: 'div[data-yield-calculation]', getAttrs: element => {
      try { const inputs: unknown = JSON.parse((element as HTMLElement).getAttribute('data-yield-calculation') || ''); return yieldMath.validateYieldInputs(inputs) ? { ...inputs } : false; }
      catch { return false; }
    } }];
  },
  renderHTML({ node, HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { 'data-yield-calculation': JSON.stringify(node.attrs) }), ...yieldMath.yieldSummary(node.attrs as YieldInputs).map(line => ['p', {}, line])];
  },
  renderText({ node }) { return yieldMath.yieldSummary(node.attrs as YieldInputs).join('\n'); },
  addNodeView() { return ReactNodeViewRenderer(YieldCard); },
});
