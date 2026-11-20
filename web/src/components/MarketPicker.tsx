import { useEffect, useMemo, useRef } from 'react';
import { Link } from 'react-router-dom';
import type { MarketEvent } from '../api/types';
import { closesIn } from '../lib/marketPhase';
import { assetKey, closesLabel, groupByAsset } from '../lib/markets';
import { rovingKeys, rovingTab } from '../lib/roving';
import { keepMode } from '../lib/venue';

interface Props {
  /** The markets to choose from: the ones with prices, or all of them when the person asked to see the rest. */
  events: MarketEvent[];
  event: MarketEvent | undefined;
  onPick: (event: MarketEvent) => void;
  /** How many more markets the exchange lists that have no prices right now. */
  unpriced: number;
  showUnpriced: boolean;
  onToggleUnpriced: () => void;
  /** The current time, so the closing countdown moves. */
  now: number;
  /** The first list of markets has not arrived: the bar holds its place, so the page does not jump when it does. */
  loading?: boolean;
  /** A bet is on its way or has been placed: the choice is locked until the person starts another. */
  disabled?: boolean;
}

/** The order the tabs always come in, so they never move under a finger as prices come and go. Anything else follows by name. */
const ORDER = ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE'];

/**
 * Chooses the market: an asset (Bitcoin, Ethereum ...) and, under it, when that market closes. The same picker heads every
 * builder, so a person who has chosen Bitcoin at 8 pm on one page finds the same choice on the next.
 *
 * Both rows are one Tab stop each, moved along with the arrow keys; Enter or Space chooses.
 */
export default function MarketPicker({ events, event, onPick, unpriced, showUnpriced, onToggleUnpriced, now, loading = false, disabled = false }: Props) {
  const groups = useMemo(() => {
    const rank = (key: string) => {
      const at = ORDER.indexOf(key);
      return at < 0 ? ORDER.length : at;
    };
    // Assets with prices first, then a fixed order. Not by how many bets each offers this second, which reshuffled the tabs.
    return [...groupByAsset(events)].sort((a, b) => Number(b.priced > 0) - Number(a.priced > 0) || rank(a.key) - rank(b.key) || a.label.localeCompare(b.label));
  }, [events]);
  const group = event ? groups.find((g) => g.key === assetKey(event)) : undefined;
  // A market that has closed no longer counts down: the builder says once that it has closed (lib/marketPhase.ts).
  const closing = event ? closesIn(event, now) : null;

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

  if (loading && events.length === 0) return <div className="market-bar is-loading" aria-hidden="true" />;

  const chosenAsset = groups.findIndex((g) => g.key === group?.key);
  const times = group?.events ?? [];
  const chosenTime = times.findIndex((e) => e.ticker === event?.ticker);

  return (
    <>
      <div className="market-bar">
        <div className="seg" role="tablist" aria-label="Market" ref={strip} onKeyDown={rovingKeys}>
          {groups.map((g, i) => (
            <button type="button"
              key={g.key}
              role="tab"
              aria-selected={g.key === group?.key}
              tabIndex={rovingTab(i, chosenAsset)}
              disabled={disabled}
              className={g.key === group?.key ? 'is-on' : ''}
              onClick={() => g.events[0] && onPick(g.events.find((e) => e.ticker === event?.ticker) ?? g.events[0])}
            >
              {g.label}
            </button>
          ))}
        </div>
        <div className="expiry-row">
          <div className="expiry" role="tablist" aria-label="Closes" onKeyDown={rovingKeys}>
            {times.map((e, i) => (
              // The label sits in a span so the button around it can be a full 44px touch target on a phone while the chip
              // that is drawn stays small.
              <button type="button"
                key={e.ticker}
                role="tab"
                aria-selected={e.ticker === event?.ticker}
                tabIndex={rovingTab(i, chosenTime)}
                disabled={disabled}
                className={e.ticker === event?.ticker ? 'is-on' : ''}
                onClick={() => onPick(e)}
              >
                <span>{closesLabel(e.expiry, now)}</span>
              </button>
            ))}
          </div>
          <span className="expiry-note">
            {closing && <span>{closing}</span>}
            <Link to={keepMode('/markets')}>All markets</Link>
          </span>
        </div>
      </div>
      {unpriced > 0 && (
        <button type="button" className="more-markets" aria-expanded={showUnpriced} onClick={onToggleUnpriced}>
          {showUnpriced ? 'Hide markets with no prices' : `Show ${unpriced} ${unpriced === 1 ? 'market' : 'markets'} with no prices`}
        </button>
      )}
    </>
  );
}
