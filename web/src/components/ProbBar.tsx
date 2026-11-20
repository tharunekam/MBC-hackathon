import type { Direction } from '../api/types';
import { parlayPercents } from '../lib/chances';

interface Props {
  /** Chance the first level holds (e.g. finishes at or above $62,500). */
  chanceCondition: number;
  /** Chance the bet wins: the first level holds and the target is reached. */
  chanceBoth: number;
  /** Which way the bet looks. It does not change the three figures, only the order they are rounded in (see lib/chances.ts). */
  direction?: Direction;
  className?: string;
}

/**
 * The whole bet on one line: three results sized by the market's own odds. The three figures are rounded together, so they
 * add to exactly 100% and match every other place the page shows them.
 */
export default function ProbBar({ chanceCondition, chanceBoth, direction = 'up', className }: Props) {
  const shown = parlayPercents(direction, chanceCondition, chanceBoth);
  const parts = [
    { key: 'refund', label: 'Stake back', p: Math.max(0, 1 - chanceCondition), percent: shown.back },
    { key: 'win', label: 'Win', p: Math.max(0, chanceBoth), percent: shown.win },
    { key: 'lose', label: 'Lose', p: Math.max(0, chanceCondition - chanceBoth), percent: shown.lose },
  ];
  return (
    <div className={`pb ${className ?? ''}`} role="img" aria-label={parts.map((x) => `${x.label} ${x.percent}%`).join(', ')}>
      <div className="pb-track">
        {parts.map((x) => (
          <div key={x.key} className="pb-seg" data-kind={x.key} style={{ flexGrow: Math.max(x.p, 0.0001) }} />
        ))}
      </div>
      <div className="pb-legend">
        {parts.map((x) => (
          <span key={x.key} className="pb-key" data-kind={x.key}>
            <i />
            {x.label} <b>{x.percent}%</b>
          </span>
        ))}
      </div>
    </div>
  );
}
