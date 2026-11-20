import { useMemo } from 'react';
import type { Rung } from '../api/types';
import { bucketLabel, distributionOf, likeliest, zoneChances, type Shape, type Zone } from '../lib/distribution';
import { pct } from '../lib/format';
import DistChart from './DistChart';

interface Props {
  rungs: Rung[];
  /** The bet being built. Its results colour the bars. */
  shape: Shape;
}

const KEYS: { kind: Zone; label: string }[] = [
  { kind: 'win', label: 'Win' },
  { kind: 'back', label: 'Stake back' },
  { kind: 'lose', label: 'Lose' },
];

/**
 * The bet laid over the market's own view of where the price finishes: one bar per gap between prices, each coloured by what
 * the bet does if the price lands there. The same odds as the table above it, seen as where they come from.
 */
export default function DistCard({ rungs, shape }: Props) {
  const dist = useMemo(() => distributionOf(rungs), [rungs]);
  if (!dist) return null;
  const chances = zoneChances(shape, dist.buckets);
  const most = likeliest(dist.buckets);
  return (
    <section className="card dist-card" aria-label="Where the market thinks it finishes">
      <header className="card-head">
        <h2 className="h-card">Where the market thinks it finishes</h2>
        <span className="fine">From the exchange’s prices</span>
      </header>
      <p className="dist-say">
        Each bar is the chance of finishing between two prices.{most ? ` Most likely: ${bucketLabel(most).replace(/^Below/, 'below')}, ${pct(most.chance)}.` : ''}
      </p>
      <DistChart dist={dist} shape={shape} />
      <div className="dist-keys">
        {KEYS.filter((k) => k.kind !== 'back' || shape.kind !== 'range').map((k) => (
          <span key={k.kind} data-kind={k.kind}>
            <i /> {k.label} <b>{pct(chances[k.kind])}</b>
          </span>
        ))}
        {dist.adjusted && <span>Some prices were out of order and have been evened out.</span>}
      </div>
    </section>
  );
}
