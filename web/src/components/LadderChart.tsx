import { useCallback, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent, PointerEvent } from 'react';
import type { Rung } from '../api/types';
import { money } from '../lib/format';
import { useWidth } from '../lib/hooks';

interface Props {
  rungs: Rung[];
  condition: string;
  target: string;
  onChange: (condition: string, target: string) => void;
}

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

export default function LadderChart({ rungs, condition, target, onChange }: Props) {
  const [wrapRef, width] = useWidth<HTMLDivElement>();
  const svgRef = useRef<SVGSVGElement>(null);
  const [dragging, setDragging] = useState<'condition' | 'target' | null>(null);
  const [focused, setFocused] = useState<'condition' | 'target' | null>(null);

  const sorted = useMemo(() => [...rungs].sort((a, b) => a.strike - b.strike), [rungs]);
  const ci = Math.max(0, sorted.findIndex((r) => r.symbol === condition));
  const ti = Math.max(0, sorted.findIndex((r) => r.symbol === target));

  const compact = width < 520;
  const height = compact ? 260 : 304;
  const pad = { left: 38, right: 22, top: 70, bottom: 34 };
  const plotW = Math.max(10, width - pad.left - pad.right);
  const plotH = height - pad.top - pad.bottom;
  const minK = sorted[0]?.strike ?? 0;
  const maxK = sorted[sorted.length - 1]?.strike ?? 1;
  const xOf = useCallback((k: number) => pad.left + ((k - minK) / Math.max(1, maxK - minK)) * plotW, [minK, maxK, plotW, pad.left]);
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
    const last = sorted.length - 1;
    let c = ci;
    let t = ti;
    if (which === 'condition') c = Math.min(Math.max(0, index), Math.max(0, t - 1));
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

  const pill = (which: 'condition' | 'target', r: Rung | undefined, x: number, row: number) => {
    if (!r) return null;
    const text = which === 'condition' ? `Given ≥ ${strikeText(r)}` : `Reaches ≥ ${strikeText(r)}`;
    const w = text.length * 6.9 + 22;
    const px = Math.min(Math.max(x - w / 2, 2), width - w - 2);
    const py = 6 + row * 28;
    return (
      <g style={{ transform: `translate(${px}px, ${py}px)` }} className="lc-pill" data-kind={which} aria-hidden="true">
        <rect width={w} height={24} rx={12} />
        <text x={w / 2} y={16} textAnchor="middle">
          {text}
        </text>
      </g>
    );
  };

  const overlap = width > 0 && Math.abs(xC - xT) < 150;

  // Show a label only where there is room for it: at least ~68px apart, and the last one always.
  const gap = sorted.length > 1 ? plotW / (sorted.length - 1) : plotW;
  const every = Math.max(1, Math.ceil(68 / gap));
  const labelled = new Set<number>();
  for (let i = 0; i < sorted.length; i += every) labelled.add(i);
  const lastIdx = sorted.length - 1;
  if (!labelled.has(lastIdx)) {
    const prev = Math.max(...labelled);
    if ((lastIdx - prev) * gap < 56) labelled.delete(prev);
    labelled.add(lastIdx);
  }

  return (
    <div className="lc" ref={wrapRef} role="group" aria-label="Chance of finishing at or above each price, with two handles to choose your bet">
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
          {sorted.map((r, i) =>
            labelled.has(i) ? (
              <text key={r.symbol} className="lc-xtick" x={xOf(r.strike)} y={height - 10} textAnchor="middle">
                {strikeText(r)}
              </text>
            ) : null,
          )}

          {/* the window between the two handles */}
          {cr && tr && <rect className="lc-window" x={xC} y={pad.top} width={Math.max(0, xT - xC)} height={plotH} />}

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
            const m = mid(r) ?? 0;
            const y = yOf(m);
            const idx = which === 'condition' ? ci : ti;
            return (
              <g
                key={which}
                className={`lc-handle ${dragging === which ? 'is-dragging' : ''} ${focused === which ? 'is-focused' : ''}`}
                data-kind={which}
                style={{ transform: `translate(${x}px, 0)` }}
                tabIndex={0}
                role="slider"
                aria-label={which === 'condition' ? 'Condition price' : 'Target price'}
                aria-valuemin={0}
                aria-valuemax={sorted.length - 1}
                aria-valuenow={idx}
                aria-valuetext={`${strikeText(r)} or above, ${Math.round(m * 100)} percent chance`}
                onPointerDown={onDown(which)}
                onPointerMove={onMove(which)}
                onPointerUp={onUp}
                onPointerCancel={onUp}
                onKeyDown={onKey(which)}
                onFocus={() => setFocused(which)}
                onBlur={() => setFocused(null)}
              >
                <line className="lc-stem" x1={0} x2={0} y1={pad.top - 6} y2={pad.top + plotH} />
                <rect className="lc-grab" x={-18} y={pad.top - 10} width={36} height={plotH + 20} />
                <circle className="lc-dot-ring" cx={0} cy={y} r={11} />
                <circle className="lc-dot" cx={0} cy={y} r={6} />
                <text
                  className="lc-chance"
                  // Near the top of the plot the label goes below its dot, out from under the pills; two close handles put
                  // theirs on opposite sides so the numbers never sit on each other; at the right edge it flips inward.
                  x={(x > width - pad.right - 44 || (which === 'condition' && xT - xC < 56 && x > pad.left + 40)) ? -14 : 14}
                  y={y < pad.top + 18 ? y + 26 : y - 12}
                  textAnchor={(x > width - pad.right - 44 || (which === 'condition' && xT - xC < 56 && x > pad.left + 40)) ? 'end' : 'start'}
                >
                  {Math.round(m * 100)}%
                </text>
              </g>
            );
          })}

          {/* labels sit above the plot and never overlap */}
          {pill('condition', cr, xC, 0)}
          {pill('target', tr, xT, overlap ? 1 : 0)}
        </svg>
      )}
    </div>
  );
}
