import { pct } from '../lib/format';

interface Props {
  /** Chance the price finishes at or above the floor and below the ceiling. */
  chanceInRange: number;
  className?: string;
}

/** A range on one line: the market's chance of finishing inside it against the chance of finishing outside. */
export default function RangeBar({ chanceInRange, className }: Props) {
  // Rounded once, so the two figures always add to 100%.
  const inside = Math.round(Math.min(1, Math.max(0, chanceInRange)) * 100) / 100;
  const parts = [
    { key: 'win', label: 'Inside the range', p: inside },
    { key: 'lose', label: 'Outside', p: Math.round((1 - inside) * 100) / 100 },
  ];
  return (
    <div className={`rb ${className ?? ''}`} role="img" aria-label={parts.map((x) => `${x.label} ${pct(x.p)}`).join(', ')}>
      <div className="rb-track">
        {parts.map((x) => (
          <div key={x.key} className="rb-seg" data-kind={x.key} style={{ flexGrow: Math.max(x.p, 0.0001) }} />
        ))}
      </div>
      <div className="rb-legend">
        {parts.map((x) => (
          <span key={x.key} className="rb-key" data-kind={x.key}>
            <i />
            {x.label} <b>{pct(x.p)}</b>
          </span>
        ))}
      </div>
    </div>
  );
}
