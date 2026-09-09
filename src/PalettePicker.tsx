import { useId } from 'react';
import { Check } from 'lucide-react';
import { appearancePalette, appearancePalettes } from './appearance';
import type { AppearancePaletteId } from './appearance';
import './appearance-polish.css';

export default function PalettePicker({ value, onChange, disabled = false }: {
  value: AppearancePaletteId;
  onChange: (value: AppearancePaletteId) => void;
  disabled?: boolean;
}) {
  const name = useId();
  return <fieldset className="palette-picker" disabled={disabled}>
    <legend>Workspace palette</legend>
    <p className="palette-description">Choose a little color for your day. Notebook and status colors keep their meaning.</p>
    <div className="palette-options">{appearancePalettes.map(option => {
      const light = appearancePalette(0, option.id);
      const dark = appearancePalette(100, option.id);
      return <label key={option.id} className={`palette-option${value === option.id ? ' selected' : ''}`}>
        <input type="radio" name={name} value={option.id} checked={value === option.id} onChange={() => onChange(option.id)} />
        <span className="palette-swatches" aria-hidden="true">
          <i style={{ backgroundColor: light.canvas }} />
          <i style={{ backgroundColor: light['accent-soft'] }} />
          <i style={{ backgroundColor: light.green }} />
          <i style={{ backgroundColor: dark.canvas }} />
        </span>
        <span className="palette-label">{option.label}{value === option.id && <Check size={14} aria-hidden="true" />}</span>
      </label>;
    })}</div>
  </fieldset>;
}
