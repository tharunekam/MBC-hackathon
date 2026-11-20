import type { LevelsPercents } from '../lib/chances';

interface Props {
  /**
   * The market's chances for the three stretches the two levels cut the ladder into, as whole percents that add to 100
   * (lib/chances.ts). The page works them out once and shows the same figures here, in the ticket and in the table.
   */
  shares: LevelsPercents;
  /** Which side wins. A range wins inside its two levels (the default); a breakout wins outside them. */
  side?: 'in' | 'out';
  className?: string;
}

/**
 * A bet on two levels on one line: the market's chance that the bet wins against the chance that it loses. A Range wins between
 * its two levels and a Breakout outside them; the line under the question says which, so the bar uses the two result names
 * every other part of the page uses.
 */
export default function RangeBar({ shares, side = 'in', className }: Props) {
  const out = side === 'out';
  const keys = [
    { key: 'win', label: 'Win', p: shares.win },
    { key: 'lose', label: 'Lose', p: shares.lose },
  ];
  // The track is drawn as the price line is: below the lower level, between the two, above the higher. A breakout wins on
  // both sides of its loss, a range loses on both sides of its win.
  const segs = [
    { id: 'below', kind: out ? 'win' : 'lose', p: shares.below },
    { id: 'between', kind: out ? 'lose' : 'win', p: shares.between },
    { id: 'above', kind: out ? 'win' : 'lose', p: shares.above },
  ];
  return (
    <div className={`rb ${className ?? ''}`} role="img" aria-label={keys.map((x) => `${x.label} ${x.p}%`).join(', ')}>
      <div className="rb-track">
        {segs.map((x) => (
          <div key={x.id} className="rb-seg" data-kind={x.kind} style={{ flexGrow: Math.max(x.p, 0.01) }} />
        ))}
      </div>
      <div className="rb-legend">
        {keys.map((x) => (
          <span key={x.key} className="rb-key" data-kind={x.key}>
            <i />
            {x.label} <b>{x.p}%</b>
          </span>
        ))}
      </div>
    </div>
  );
}
