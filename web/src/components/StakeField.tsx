import type { ReactNode } from 'react';

interface Props {
  id: string;
  /** What is typed in the box. */
  text: string;
  /** The amount that text means, to mark the matching preset. */
  stake: number;
  onText: (text: string) => void;
  presets?: number[];
  /** The line under the field: how much fits, or what the stake buys. */
  note: ReactNode;
  label?: string;
}

const DEFAULT_PRESETS = [5, 10, 25, 50];

/** The stake box with its quick amounts. Typing keeps digits and one dot, and every builder reads it the same way. */
export default function StakeField({ id, text, stake, onText, presets = DEFAULT_PRESETS, note, label = 'Stake' }: Props) {
  return (
    <div className="stake">
      <label htmlFor={id}>{label}</label>
      <div className="stake-row">
        <div className="field">
          <span className="field-pre">$</span>
          <input id={id} inputMode="decimal" value={text} onChange={(e) => onText(e.target.value.replace(/[^\d.]/g, ''))} aria-describedby={`${id}-note`} />
        </div>
        <div className="presets">
          {presets.map((p) => (
            <button key={p} type="button" className={`chip ${stake === p ? 'is-on' : ''}`} onClick={() => onText(String(p))}>
              ${p}
            </button>
          ))}
        </div>
      </div>
      <p id={`${id}-note`} className="fine">
        {note}
      </p>
    </div>
  );
}
