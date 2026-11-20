import { useCallback, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent, PointerEvent } from 'react';
import type { Rung } from '../api/types';
import { AXIS_TITLE, AXIS_TITLE_SHORT, chartZones, levelLabel, levelSpoken } from '../lib/chartWords';
import { money } from '../lib/format';
import { across, spacedLabels } from '../lib/ladders';
import { useWidth } from '../lib/hooks';

/**
 * What the two handles stand for.
 *   up      a rising Stake Back: the first handle is the first level, which has to hold, the second the target to reach (higher)
 *   down    a falling Stake Back: the first handle is the first level to stay under, the second the target to fall below (lower)
 *   range   the first handle is the lower level and the second the higher level
 *   breakout  the same two handles, for a bet that the price finishes outside them: below the first, or at or above the second
 */
export type ChartMode = 'up' | 'down' | 'range' | 'breakout';

interface Props {
  rungs: Rung[];
  /** The first handle's rung. */
  condition: string;
  /** The second handle's rung. */
  target: string;
  mode?: ChartMode;
  /** The chart is a record (a bet placed, a market closed): the handles are not reachable and do nothing. */
  locked?: boolean;
  onChange: (condition: string, target: string) => void;
}

/** The words a handle goes by for a screen reader, and the chart's own name. */
interface Words {
  firstName: string;
  secondName: string;
  group: string;
}

const WORDS: Record<ChartMode, Words> = {
  up: {
    firstName: 'First level',
    secondName: 'Target',
    group: 'Chance of finishing at or above each price. Two handles set your first level and your target.',
  },
  down: {
    firstName: 'First level',
    secondName: 'Target',
    group: 'Chance of finishing at or above each price. Two handles set your first level and your target for a fall.',
  },
  range: {
    firstName: 'Lower level',
    secondName: 'Higher level',
    group: 'Chance of finishing at or above each price. Two handles set the lower and higher levels of a range.',
  },
  breakout: {
    firstName: 'Lower level',
    secondName: 'Higher level',
    group: 'Chance of finishing at or above each price. Two handles set the levels a breakout must finish outside.',
  },
};

const strikeText = (r: Rung) => money(r.strike);
const mid = (r: Rung) => (r.bid !== null && r.ask !== null ? (r.bid + r.ask) / 2 : null);

/** Monotone cubic path (Fritsch–Carlson) so the curve never overshoots the data. */
function smoothPath(pts: [number, number][]): string {
  if (pts.length < 2) return '';
  const n = pts.length;
  const dx: number[] = [];
  const m: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    dx.push(pts[i + 1]![0] - pts[i]![0]);
    m.push((pts[i + 1]![1] - pts[i]![1]) / dx[i]!);
  }
  const t: number[] = [m[0]!];
  for (let i = 1; i < n - 1; i++) t.push(m[i - 1]! * m[i]! <= 0 ? 0 : (m[i - 1]! + m[i]!) / 2);
  t.push(m[n - 2]!);
  for (let i = 0; i < n - 1; i++) {
    if (m[i] === 0) {
      t[i] = 0;
      t[i + 1] = 0;
      continue;
    }
    const a = t[i]! / m[i]!;
    const b = t[i + 1]! / m[i]!;
    const s = a * a + b * b;
    if (s > 9) {
      const k = 3 / Math.sqrt(s);
      t[i] = k * a * m[i]!;
      t[i + 1] = k * b * m[i]!;
    }
  }
  let d = `M${pts[0]![0].toFixed(2)},${pts[0]![1].toFixed(2)}`;
  for (let i = 0; i < n - 1; i++) {
    const h = dx[i]! / 3;
    d += `C${(pts[i]![0] + h).toFixed(2)},${(pts[i]![1] + t[i]! * h).toFixed(2)} ${(pts[i + 1]![0] - h).toFixed(2)},${(pts[i + 1]![1] - t[i + 1]! * h).toFixed(2)} ${pts[i + 1]![0].toFixed(2)},${pts[i + 1]![1].toFixed(2)}`;
  }
  return d;
}

export default function LadderChart({ rungs, condition, target, mode = 'up', locked = false, onChange }: Props) {
  const words = WORDS[mode];
  const [wrapRef, width] = useWidth<HTMLDivElement>();
  const svgRef = useRef<SVGSVGElement>(null);
  const [dragging, setDragging] = useState<'condition' | 'target' | null>(null);
  const [focused, setFocused] = useState<'condition' | 'target' | null>(null);

  const sorted = useMemo(() => [...rungs].sort((a, b) => a.strike - b.strike), [rungs]);
  const ci = Math.max(0, sorted.findIndex((r) => r.symbol === condition));
  const ti = Math.max(0, sorted.findIndex((r) => r.symbol === target));

  const compact = width < 520;
  const height = compact ? 260 : 304;
  // The left margin holds the axis title (turned on its side) as well as the percent marks.
  const pad = { left: 52, right: 22, top: 70, bottom: 34 };
  const plotW = Math.max(10, width - pad.left - pad.right);
  const plotH = height - pad.top - pad.bottom;
  const minK = sorted[0]?.strike ?? 0;
  const maxK = sorted[sorted.length - 1]?.strike ?? 1;
  const xOf = useCallback((k: number) => pad.left + across(k, minK, maxK) * plotW, [minK, maxK, plotW, pad.left]);
  const yOf = (p: number) => pad.top + (1 - p) * plotH;

  const points = sorted.flatMap((r) => {
    const m = mid(r);
    return m === null ? [] : [{ r, x: xOf(r.strike), y: yOf(m), m }];
  });
  const curve = smoothPath(points.map((p) => [p.x, p.y]));
  const band =
    points.length > 1
      ? `M${points.map((p) => `${p.x.toFixed(1)},${yOf(p.r.ask ?? p.m).toFixed(1)}`).join('L')}L${[...points]
          .reverse()
          .map((p) => `${p.x.toFixed(1)},${yOf(p.r.bid ?? p.m).toFixed(1)}`)
          .join('L')}Z`
      : '';

  const nearestIndex = (clientX: number) => {
    const box = svgRef.current?.getBoundingClientRect();
    if (!box) return 0;
    const x = clientX - box.left;
    let best = 0;
    let bestD = Infinity;
    sorted.forEach((r, i) => {
      const d = Math.abs(xOf(r.strike) - x);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    });
    return best;
  };

  const move = (which: 'condition' | 'target', index: number) => {
    if (locked) return;
    const last = sorted.length - 1;
    let c = ci;
    let t = ti;
    if (mode === 'down') {
      // the level to stay under is the higher one, the level to fall below the lower
      if (which === 'condition') c = Math.max(Math.min(last, index), Math.min(last, t + 1));
      else t = Math.min(Math.max(0, index), Math.max(0, c - 1));
    } else if (which === 'condition') c = Math.min(Math.max(0, index), Math.max(0, t - 1));
    else t = Math.max(Math.min(last, index), Math.min(last, c + 1));
    const cs = sorted[c]?.symbol;
    const ts = sorted[t]?.symbol;
    if (cs && ts && (cs !== condition || ts !== target)) onChange(cs, ts);
  };

  const onDown = (which: 'condition' | 'target') => (e: PointerEvent<SVGGElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    setDragging(which);
  };
  const onMove = (which: 'condition' | 'target') => (e: PointerEvent<SVGGElement>) => {
    if (dragging === which) move(which, nearestIndex(e.clientX));
  };
  const onUp = () => setDragging(null);

  const onKey = (which: 'condition' | 'target') => (e: KeyboardEvent<SVGGElement>) => {
    const cur = which === 'condition' ? ci : ti;
    const step = e.key === 'ArrowLeft' || e.key === 'ArrowDown' ? -1 : e.key === 'ArrowRight' || e.key === 'ArrowUp' ? 1 : 0;
    if (step !== 0) {
      e.preventDefault();
      move(which, cur + step);
    } else if (e.key === 'Home') {
      e.preventDefault();
      move(which, 0);
    } else if (e.key === 'End') {
      e.preventDefault();
      move(which, sorted.length - 1);
    }
  };

  const onBackground = (e: PointerEvent<SVGRectElement>) => {
    const i = nearestIndex(e.clientX);
    // Move whichever handle is closer to the tap.
    move(Math.abs(i - ci) <= Math.abs(i - ti) ? 'condition' : 'target', i);
  };

  const cr = sorted[ci];
  const tr = sorted[ti];
  const xC = cr ? xOf(cr.strike) : 0;
  const xT = tr ? xOf(tr.strike) : 0;

  /**
   * Where a handle's label is drawn: centred on its handle, pushed inwards when that would run off the chart. It names the
   * handle (the same name a screen reader hears) and gives its level. What the curve is, and so what height the dot is at, is
   * the axis title's to say; what the bet itself wins on is in the ticket and the shaded stretches.
   */
  const pillBox = (which: 'condition' | 'target', r: Rung | undefined, x: number) => {
    if (!r) return null;
    const text = levelLabel(which === 'condition' ? words.firstName : words.secondName, strikeText(r));
    const w = text.length * 6.9 + 22;
    return { which, text, w, px: Math.min(Math.max(x - w / 2, 2), width - w - 2) };
  };
  const pill = (box: ReturnType<typeof pillBox>, row: number) => {
    if (!box) return null;
    return (
      <g style={{ transform: `translate(${box.px}px, ${6 + row * 28}px)` }} className="lc-pill" data-kind={box.which} aria-hidden="true">
        <rect width={box.w} height={24} rx={12} />
        <text x={box.w / 2} y={16} textAnchor="middle">
          {box.text}
        </text>
      </g>
    );
  };

  const apart = Math.abs(xT - xC);
  const left = Math.min(xC, xT);
  const zones = chartZones(mode);
  const reach = { left: pad.left - 6, right: pad.left + plotW + 6 };
  const firstPill = pillBox('condition', cr, xC);
  const secondPill = pillBox('target', tr, xT);
  // The second label takes a row of its own when the two would touch. Measured where each is actually drawn: a label near the
  // edge of the chart is pushed inwards, towards the other one, so the distance between the handles alone does not settle it.
  const overlap = !!firstPill && !!secondPill && firstPill.px < secondPill.px + secondPill.w + 8 && secondPill.px < firstPill.px + firstPill.w + 8;

  // Show a label only where there is room for it: at least ~68px apart, and the last one always. Measured where each
  // rung is actually drawn, because ladders are not always evenly stepped.
  const labelled = spacedLabels(sorted.map((r) => xOf(r.strike)));

  return (
    <div className="lc" ref={wrapRef} role="group" aria-label={words.group}>
      {width > 0 && (
        <svg ref={svgRef} width={width} height={height} viewBox={`0 0 ${width} ${height}`}>
          {/* grid and axes */}
          {[0, 0.25, 0.5, 0.75, 1].map((p) => (
            <g key={p}>
              <line className="lc-grid" x1={pad.left} x2={width - pad.right} y1={yOf(p)} y2={yOf(p)} />
              <text className="lc-ytick" x={pad.left - 8} y={yOf(p) + 4} textAnchor="end">
                {Math.round(p * 100)}%
              </text>
            </g>
          ))}
          <text className="lc-axis" transform={`translate(8 ${pad.top + plotH / 2}) rotate(-90)`} textAnchor="middle">
            {plotH >= 190 ? AXIS_TITLE : AXIS_TITLE_SHORT}
          </text>
          {sorted.map((r, i) =>
            labelled.has(i) ? (
              <text key={r.symbol} className="lc-xtick" x={xOf(r.strike)} y={height - 10} textAnchor="middle">
                {strikeText(r)}
              </text>
            ) : null,
          )}

          {/* The three stretches the two handles cut the chart into, each lit as what the bet does there: green where it wins, red
              where it loses, nothing where a Stake Back gets its stake back (amber is the handles' colour alone). The outer two run a
              little past the last price, because a bet that wins or loses beyond a level does so beyond the ladder too. */}
          {cr && tr && (
            <>
              {zones.below && <rect className="lc-window" data-zone={zones.below} x={reach.left} y={pad.top} width={Math.max(0, left - reach.left)} height={plotH} />}
              {zones.between && <rect className="lc-window" data-zone={zones.between} x={left} y={pad.top} width={apart} height={plotH} />}
              {zones.above && <rect className="lc-window" data-zone={zones.above} x={left + apart} y={pad.top} width={Math.max(0, reach.right - (left + apart))} height={plotH} />}
            </>
          )}

          {/* the market: spread band, mid curve, and every real rung */}
          <path className="lc-band" d={band} />
          <path className="lc-curve" d={curve} pathLength={1} />
          {points.map((p) => (
            <circle key={p.r.symbol} className="lc-rung" cx={p.x} cy={p.y} r={2.6} />
          ))}

          {/* tap anywhere to move the nearest handle */}
          <rect className="lc-hit" x={pad.left - 6} y={pad.top - 8} width={plotW + 12} height={plotH + 16} onPointerDown={onBackground} />

          {/* handles */}
          {([
            ['condition', cr, xC] as const,
            ['target', tr, xT] as const,
          ]).map(([which, r, x]) => {
            if (!r) return null;
            const y = yOf(mid(r) ?? 0);
            const idx = which === 'condition' ? ci : ti;
            const spoken = levelSpoken(strikeText(r), mid(r));
            return (
              <g
                key={which}
                className={`lc-handle ${dragging === which ? 'is-dragging' : ''} ${focused === which ? 'is-focused' : ''}`}
                data-kind={which}
                // The whole handle, not only its grab area, is a drag: a thumb that lands on the dot must not scroll the page.
                style={{ transform: `translate(${x}px, 0)`, touchAction: 'none' }}
                tabIndex={locked ? -1 : 0}
                role="slider"
                aria-label={which === 'condition' ? words.firstName : words.secondName}
                aria-valuemin={0}
                aria-valuemax={sorted.length - 1}
                aria-valuenow={idx}
                aria-valuetext={spoken}
                aria-disabled={locked || undefined}
                onPointerDown={onDown(which)}
                onPointerMove={onMove(which)}
                onPointerUp={onUp}
                onPointerCancel={onUp}
                onKeyDown={onKey(which)}
                onFocus={() => setFocused(which)}
                onBlur={() => setFocused(null)}
              >
                <line className="lc-stem" x1={0} x2={0} y1={pad.top - 6} y2={pad.top + plotH} />
                <rect className="lc-grab" x={-22} y={pad.top - 10} width={44} height={plotH + 20} />
                <circle className="lc-dot-ring" cx={0} cy={y} r={11} style={{ pointerEvents: 'none' }} />
                <circle className="lc-dot" cx={0} cy={y} r={6} style={{ pointerEvents: 'none' }} />
              </g>
            );
          })}

          {/* labels sit above the plot and never overlap */}
          {pill(firstPill, 0)}
          {pill(secondPill, overlap ? 1 : 0)}
        </svg>
      )}
    </div>
  );
}

/**
 * The key under the chart. The two colours are the ones a bet's result has everywhere else: green where it wins, red where it
 * loses. Which price each marker is on is on the marker's own pill, and what the curve plots is the axis title, so neither is
 * said again here. The band of buy and sell prices is left out on a phone (builder.css).
 */
export function ChartKey() {
  return (
    <div className="chart-foot">
      <span className="foot-band">
        <i className="lg lg-band" /> Buy and sell prices
      </span>
      <span>
        <i className="lg lg-win" /> Where you win
      </span>
      <span>
        <i className="lg lg-lose" /> Where you lose
      </span>
    </div>
  );
}
