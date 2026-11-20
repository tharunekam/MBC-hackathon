import { useEffect, useMemo, useRef } from 'react';
import { Link } from 'react-router-dom';
import type { MarketEvent } from '../api/types';
import { timeLeft } from '../lib/format';
import { assetKey, closesLabel, groupByAsset } from '../lib/markets';

interface Props {
  /** The ladders to choose from: the ones with prices, or all of them when the person asked to see the rest. */
  events: MarketEvent[];
  event: MarketEvent | undefined;
  onPick: (event: MarketEvent) => void;
  /** How many more ladders the exchange lists that have no prices right now. */
  unpriced: number;
  showUnpriced: boolean;
  onToggleUnpriced: () => void;
  /** The current time, so the closing countdown moves. */
  now: number;
}

/**
 * Chooses the market: an asset (Bitcoin, Ethereum ...) and, under it, when that ladder closes. The same picker heads every
 * builder, so a person who has chosen Bitcoin at 8 pm on one page finds the same choice on the next.
 */
export default function MarketPicker({ events, event, onPick, unpriced, showUnpriced, onToggleUnpriced, now }: Props) {
  const groups = useMemo(() => groupByAsset(events), [events]);
  const group = event ? groups.find((g) => g.key === assetKey(event)) : undefined;
  const closing = timeLeft(event?.expiry ?? null, now);

  // Keep the chosen asset in view inside the strip. Only the strip moves, never the page.
  const strip = useRef<HTMLDivElement>(null);
  const shown = event ? assetKey(event) : undefined;
  useEffect(() => {
    const el = strip.current;
    const tab = el?.querySelector<HTMLElement>('[aria-selected="true"]');
    if (!el || !tab) return;
    const left = tab.offsetLeft;
    const right = left + tab.offsetWidth;
    if (left < el.scrollLeft) el.scrollLeft = left - 4;
    else if (right > el.scrollLeft + el.clientWidth) el.scrollLeft = right - el.clientWidth + 4;
  }, [shown, events.length]);

  return (
    <>
      <div className="market-bar">
        <div className="seg" role="tablist" aria-label="Market" ref={strip}>
          {groups.map((g) => (
            <button
              key={g.key}
              role="tab"
              aria-selected={g.key === group?.key}
              className={g.key === group?.key ? 'is-on' : ''}
              onClick={() => g.events[0] && onPick(g.events.find((e) => e.ticker === event?.ticker) ?? g.events[0])}
            >
              {g.label}
            </button>
          ))}
        </div>
        <div className="expiry-row">
          <div className="expiry" role="tablist" aria-label="Closes">
            {(group?.events ?? []).map((e) => (
              <button key={e.ticker} role="tab" aria-selected={e.ticker === event?.ticker} className={e.ticker === event?.ticker ? 'is-on' : ''} onClick={() => onPick(e)}>
                {closesLabel(e.expiry, now)}
              </button>
            ))}
          </div>
          <span className="expiry-note">
            {closing && <span>{closing}</span>}
            <Link to="/markets">All markets</Link>
          </span>
        </div>
      </div>
      {unpriced > 0 && (
        <button type="button" className="more-markets" aria-expanded={showUnpriced} onClick={onToggleUnpriced}>
          {showUnpriced
            ? 'Hide markets with no prices'
            : `${unpriced} more ${unpriced === 1 ? 'market has' : 'markets have'} no prices right now. Show ${unpriced === 1 ? 'it' : 'them'}`}
        </button>
      )}
    </>
  );
}
