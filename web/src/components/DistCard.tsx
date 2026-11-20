import { useMemo } from 'react';
import type { Rung } from '../api/types';
import { barPercents, type Zones } from '../lib/chances';
import { bucketLabel, distributionOf, likeliest, zoneOf, type Bucket, type Shape, type Zone } from '../lib/distribution';
import DistChart from './DistChart';

interface Props {
  rungs: Rung[];
  /** The bet being built. Its results colour the bars. */
  shape: Shape;
  /**
   * The ticket's chances for the three stretches the bet's two levels cut the ladder into, lowest prices first, as whole
   * percents. With them the figures here are the ticket's own; without them they are read from the rungs.
   */
  zones?: Zones | null;
}

const KEYS: { kind: Zone; label: string }[] = [
  { kind: 'win', label: 'Win' },
  { kind: 'back', label: 'Stake back' },
  { kind: 'lose', label: 'Lose' },
];

/** The bet's two levels, lower first, whichever way round the bet names them. */
function levelsOf(shape: Shape): [number, number] {
  return shape.kind === 'range' || shape.kind === 'breakout' ? [shape.low, shape.high] : [Math.min(shape.condition, shape.target), Math.max(shape.condition, shape.target)];
}

/**
 * The bet laid over the market's own view of where the price finishes: one bar per gap between prices, each coloured by what
 * the bet does if the price lands there. The same odds as the table above it, seen as where they come from: the figures under
 * the chart are the ticket's, and the bars of each colour add up to the figure for that colour.
 */
export default function DistCard({ rungs, shape, zones: given }: Props) {
  const dist = useMemo(() => distributionOf(rungs), [rungs]);
  if (!dist) return null;
  const [low, high] = levelsOf(shape);
  // Which of the three stretches a bar lies in: below the lower level, between the two, or at or above the higher.
  const stretch = (b: Bucket): 0 | 1 | 2 => (b.from === null || b.from < low ? 0 : b.from < high ? 1 : 2);
  const { bars, zones } = barPercents(
    dist.buckets.map((b) => b.chance),
    (i) => stretch(dist.buckets[i]!),
    given,
  );
  // Each stretch has one result (a range loses in two of them), so a result's chance is the sum of its stretches.
  const chances: Record<Zone, number> = { win: 0, back: 0, lose: 0 };
  ([0, 1, 2] as const).forEach((z) => {
    const first = dist.buckets.find((b) => stretch(b) === z);
    if (first) chances[zoneOf(shape, first)] += zones[z];
  });
  const most = likeliest(dist.buckets);
  // A range and a breakout have two results, with no stake that comes back.
  const twoWay = shape.kind === 'range' || shape.kind === 'breakout';
  return (
    <section className="card dist-card" aria-label="Where the market thinks it finishes">
      <header className="card-head">
        <h2 className="h-card">Where the market thinks it finishes</h2>
        <span className="fine">From the exchange’s prices</span>
      </header>
      <p className="dist-say">
        Each bar is the chance of finishing between two prices.{most ? ` Most likely: ${bucketLabel(most).replace(/^Below/, 'below')}, ${bars[dist.buckets.indexOf(most)]}%.` : ''}
      </p>
      <DistChart dist={dist} shape={shape} percents={bars} />
      <div className="dist-keys">
        {KEYS.filter((k) => k.kind !== 'back' || !twoWay).map((k) => (
          <span key={k.kind} data-kind={k.kind}>
            <i /> {k.label} <b>{chances[k.kind]}%</b>
          </span>
        ))}
        {dist.adjusted && <span>Some prices were out of order and have been evened out.</span>}
      </div>
    </section>
  );
}
