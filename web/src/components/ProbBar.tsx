import { pct } from '../lib/format';

interface Props {
  /** Chance the condition happens (e.g. holds $62,500). */
  chanceCondition: number;
  /** Chance both happen. */
  chanceBoth: number;
  className?: string;
}

/**
 * The whole bet on one line: three outcomes sized by the market's own odds.
 * Refund + win + lose always add to 100%.
 */
export default function ProbBar({ chanceCondition, chanceBoth, className }: Props) {
  const refund = Math.max(0, 1 - chanceCondition);
  const win = Math.max(0, chanceBoth);
  const lose = Math.max(0, chanceCondition - chanceBoth);
  const parts = [
    { key: 'refund', label: 'Stake back', p: refund },
    { key: 'win', label: 'Win', p: win },
    { key: 'lose', label: 'Lose', p: lose },
  ];
  return (
    <div className={`pb ${className ?? ''}`} role="img" aria-label={parts.map((x) => `${x.label} ${pct(x.p)}`).join(', ')}>
      <div className="pb-track">
        {parts.map((x) => (
          <div key={x.key} className="pb-seg" data-kind={x.key} style={{ flexGrow: Math.max(x.p, 0.0001) }} />
        ))}
      </div>
      <div className="pb-legend">
        {parts.map((x) => (
          <span key={x.key} className="pb-key" data-kind={x.key}>
            <i />
            {x.label} <b>{pct(x.p)}</b>
          </span>
        ))}
      </div>
    </div>
  );
}
