import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import type { MarketEvent, PlaceBasketResponse } from '../api/types';
import BasketLeg from '../components/BasketLeg';
import BasketResult, { type CallProgress } from '../components/BasketResult';
import StakeField from '../components/StakeField';
import {
  MAX_LEGS,
  MIN_LEGS,
  NAME_MAX,
  basketButton,
  buildRequest,
  cryptoLegs,
  defaultLevels,
  kindOfLeg,
  levelsValid,
  makeLeg,
  pickMarket,
  refusedLeg,
  seedLegs,
  splitEvenly,
  stakeText,
  stripLegPrefix,
  totals,
  withFirst,
  type LegDraft,
  type LegKind,
  type LegStatus,
} from '../lib/basket';
import { betSentence, productName } from '../lib/betKind';
import { usd, usdSigned } from '../lib/format';
import { friendly } from '../lib/friendly';
import { useResource } from '../lib/hooks';
import { listLadders } from '../lib/ladders';
import { execLive } from '../lib/liveClients';
import { assetLabel } from '../lib/markets';
import { useVenue } from '../lib/venue';
import '../styles/builder.css';
import '../styles/basket.css';

const DEFAULT_AMOUNT = 30;
const MAX_AMOUNT = 100000;

const parseStake = (txt: string): number | null => {
  const n = Number(txt);
  return txt.trim() !== '' && Number.isFinite(n) && n >= 0
    ? Math.min(n, MAX_AMOUNT)
    : null;
};

export default function Basket() {
  const venue = useVenue();
  const markets = useResource('markets', () => api.markets(), {
    live: [[execLive, 'markets']],
    pollMs: 4000,
    minGapMs: 800,
  });
  const ladders = useMemo(
    () => listLadders(markets.data?.events ?? [], false),
    [markets.data],
  );
  const events = ladders.shown;
  const feeCoef = markets.data?.feeCoefCharged ?? 0;

  const [amountText, setAmountText] = useState(String(DEFAULT_AMOUNT));
  const [amount, setAmount] = useState(DEFAULT_AMOUNT);
  // While true, the legs share the amount evenly and follow it; typing a leg's own stake turns it off.
  const [even, setEven] = useState(true);
  const [legs, setLegs] = useState<LegDraft[]>([]);
  const [name, setName] = useState('');
  const [statuses, setStatuses] = useState<Record<string, LegStatus>>({});
  const [legErrors, setLegErrors] = useState<Record<string, string>>({});
  const [basketError, setBasketError] = useState<string | null>(null);
  const [reloadSignal, setReloadSignal] = useState(0);

  const [phase, setPhase] = useState<'idle' | 'placing' | 'placed'>('idle');
  const [placedLegs, setPlacedLegs] = useState<LegDraft[]>([]);
  const [result, setResult] = useState<PlaceBasketResponse | null>(null);
  const [calls, setCalls] = useState<CallProgress>({
    total: 0,
    done: 0,
    failed: 0,
    error: null,
  });

  const eventOf = useCallback(
    (ticker: string | null): MarketEvent | undefined =>
      events.find((e) => e.ticker === ticker),
    [events],
  );

  // Open on two legs on different assets once the markets arrive; afterwards, keep every leg on a ladder that still exists
  // (the hour rolls over and tickers change) and on levels that are in order.
  useEffect(() => {
    if (events.length === 0 || phase !== 'idle') return;
    setLegs((prev) => {
      if (prev.length === 0) return seedLegs(events, amount, feeCoef);
      let changed = false;
      const next = prev.map((l, i) => {
        let ev = eventOf(l.event);
        if (!ev) {
          ev = pickMarket(
            events,
            prev.filter((_, j) => j !== i).map((x) => x.event),
          );
          changed = true;
          return makeLeg(ev, l.kind, l.stake, feeCoef, l.key);
        }
        if (!levelsValid(ev, l.kind, l.a, l.b)) {
          const lv = defaultLevels(ev, l.kind, feeCoef);
          changed = true;
          return { ...l, a: lv?.a ?? null, b: lv?.b ?? null };
        }
        return l;
      });
      return changed ? next : prev;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [events, eventOf, feeCoef, phase]);

  const onStatus = useCallback(
    (key: string, s: LegStatus) =>
      setStatuses((prev) =>
        JSON.stringify(prev[key]) === JSON.stringify(s)
          ? prev
          : { ...prev, [key]: s },
      ),
    [],
  );

  /** Any change to a leg clears what the last refusal said about it. */
  const touch = (key: string) => {
    setBasketError(null);
    setLegErrors((prev) => {
      if (!(key in prev)) return prev;
      const { [key]: _gone, ...rest } = prev;
      return rest;
    });
  };
  const update = (key: string, fn: (l: LegDraft) => LegDraft) => {
    touch(key);
    setLegs((prev) => prev.map((l) => (l.key === key ? fn(l) : l)));
  };

  const resplit = (list: LegDraft[], total: number): LegDraft[] => {
    const parts = splitEvenly(total, list.length);
    return list.map((l, i) => ({
      ...l,
      stake: parts[i]!,
      stakeText: stakeText(parts[i]!),
    }));
  };

  function setAmountFrom(txt: string) {
    setAmountText(txt);
    const n = parseStake(txt);
    if (n === null) return;
    setAmount(n);
    if (even) {
      setBasketError(null);
      setLegs((prev) => resplit(prev, n));
    }
  }

  function splitNow() {
    setEven(true);
    setBasketError(null);
    setLegs((prev) => resplit(prev, amount));
  }

  function setKind(key: string, kind: LegKind) {
    update(key, (l) => {
      if (l.kind === kind) return l;
      const ev = eventOf(l.event);
      const lv = ev ? defaultLevels(ev, kind, feeCoef) : null;
      return { ...l, kind, a: lv?.a ?? null, b: lv?.b ?? null };
    });
  }
  function setMarket(key: string, ticker: string) {
    update(key, (l) => {
      const ev = eventOf(ticker);
      const lv = ev ? defaultLevels(ev, l.kind, feeCoef) : null;
      return { ...l, event: ticker, a: lv?.a ?? null, b: lv?.b ?? null };
    });
  }
  function setFirst(key: string, symbol: string) {
    update(key, (l) => {
      const ev = eventOf(l.event);
      return ev ? { ...l, ...withFirst(ev, l.kind, symbol, l.b) } : l;
    });
  }
  function setStake(key: string, txt: string) {
    setEven(false);
    update(key, (l) => {
      const n = parseStake(txt);
      return { ...l, stakeText: txt, stake: n ?? 0 };
    });
  }

  function addLeg() {
    if (legs.length >= MAX_LEGS) return;
    setBasketError(null);
    const ev = pickMarket(
      events,
      legs.map((l) => l.event),
    );
    const n = legs.length + 1;
    const share = splitEvenly(amount, n)[n - 1] ?? 0;
    const leg = makeLeg(ev, 'up', share, feeCoef);
    setLegs((prev) =>
      even ? resplit([...prev, leg], amount) : [...prev, leg],
    );
  }
  function removeLeg(key: string) {
    if (legs.length <= MIN_LEGS) return;
    setBasketError(null);
    setLegs((prev) => {
      const next = prev.filter((l) => l.key !== key);
      return even ? resplit(next, amount) : next;
    });
    setStatuses((prev) => {
      const { [key]: _gone, ...rest } = prev;
      return rest;
    });
  }

  const legStatuses = legs.map((l) => statuses[l.key]);
  const button = basketButton({
    phase,
    readOnly: venue.readOnly,
    legs: legStatuses,
    placing: legs.length,
  });
  const sum = totals(
    legs.map((l) => ({ stake: l.stake, status: statuses[l.key] })),
  );
  const crypto = cryptoLegs(legs.map((l) => eventOf(l.event)));

  async function place() {
    if (!button.canPlace) return;
    let req;
    try {
      req = buildRequest(name, legs);
    } catch (e) {
      setBasketError(
        e instanceof Error
          ? e.message
          : 'Every leg needs a market and two levels.',
      );
      return;
    }
    const snapshot = legs;
    setPhase('placing');
    setBasketError(null);
    setLegErrors({});
    try {
      const res = await api.placeBasket(req);
      setPlacedLegs(snapshot);
      setResult(res);
      setPhase('placed');
      const open = res.bets.filter((b) => b.status === 'open');
      setCalls({ total: open.length, done: 0, failed: 0, error: null });
      for (const bet of open) {
        api.commitCall(bet.id).then(
          () => setCalls((c) => ({ ...c, done: c.done + 1 })),
          (e) =>
            setCalls((c) => ({
              ...c,
              failed: c.failed + 1,
              error: friendly(e),
            })),
        );
      }
      markets.reload();
    } catch (e) {
      const refused = refusedLeg(e);
      const leg = refused ? snapshot[refused.index] : undefined;
      if (refused && leg) {
        const k = kindOfLeg(leg.kind);
        setLegErrors({ [leg.key]: stripLegPrefix(friendly(e, k)) });
        setBasketError(
          `Leg ${refused.index + 1} was turned down, so nothing was placed.`,
        );
      } else {
        setBasketError(friendly(e));
      }
      setPhase('idle');
      setReloadSignal((n) => n + 1);
      markets.reload();
    }
  }

  function again() {
    setPhase('idle');
    setResult(null);
    setName('');
    setCalls({ total: 0, done: 0, failed: 0, error: null });
  }

  const loadingFirst = markets.loading && !markets.data;

  return (
    <div className="page builder basket">
      <header className="page-head">
        <div>
          <span className="eyebrow">A view across several assets</span>
          <h1 className="h-page">Basket</h1>
          <p className="lede">
            Up to {MAX_LEGS} bets on different markets, placed in one step. Each
            keeps its own two orders and its own result.
          </p>
        </div>
      </header>

      {markets.error && !markets.data && (
        <div className="card notice" role="alert">
          <b>We could not load the markets.</b>
          <span>{markets.error.message}</span>
          <button className="btn btn-ghost" onClick={markets.reload}>
            Try again
          </button>
        </div>
      )}

      <div className="build-grid">
        <div className="left-col">
          <section className="card basket-amount" aria-label="Amount to spread">
            <StakeField
              id="basket-amount"
              label="Amount to spread"
              text={amountText}
              stake={amount}
              onText={setAmountFrom}
              presets={[20, 30, 50, 100]}
              note={
                even
                  ? `Shared evenly: ${usd(splitEvenly(amount, Math.max(1, legs.length))[0] ?? 0)} a leg. Change a leg's stake to set it yourself.`
                  : 'Leg stakes are set by hand.'
              }
            />
            <button
              type="button"
              className="btn btn-ghost basket-split"
              onClick={splitNow}
              disabled={phase !== 'idle' || legs.length === 0}
            >
              Split evenly
            </button>
          </section>

          {loadingFirst ? (
            <div className="skeleton leg-skel" aria-hidden="true" />
          ) : events.length === 0 ? (
            <div className="card empty">
              No ladders have prices right now. Check back in a few minutes.
            </div>
          ) : (
            <ol className="legs" aria-label="Legs">
              {legs.map((l, i) => (
                <BasketLeg
                  key={l.key}
                  index={i}
                  leg={l}
                  events={events}
                  feeCoef={feeCoef}
                  phase={phase}
                  readOnly={venue.readOnly}
                  canRemove={legs.length > MIN_LEGS}
                  error={legErrors[l.key] ?? null}
                  onKind={(k) => setKind(l.key, k)}
                  onMarket={(t) => setMarket(l.key, t)}
                  onFirst={(s) => setFirst(l.key, s)}
                  onSecond={(s) => update(l.key, (x) => ({ ...x, b: s }))}
                  onStake={(t) => setStake(l.key, t)}
                  onRemove={() => removeLeg(l.key)}
                  onStatus={onStatus}
                  reloadSignal={reloadSignal}
                />
              ))}
            </ol>
          )}

          {events.length > 0 && (
            <div className="add-leg">
              <button
                type="button"
                className="btn btn-ghost"
                onClick={addLeg}
                disabled={legs.length >= MAX_LEGS || phase !== 'idle'}
              >
                Add a leg
              </button>
              <span className="fine">
                {legs.length >= MAX_LEGS
                  ? `A basket holds ${MAX_LEGS} legs at most.`
                  : `${legs.length} of ${MAX_LEGS} legs`}
              </span>
            </div>
          )}
        </div>

        <aside
          className="card quote-card basket-ticket"
          aria-live="polite"
          aria-label="Your basket"
        >
          {phase === 'placed' && result ? (
            <BasketResult
              result={result}
              legs={placedLegs}
              events={events}
              calls={calls}
              onAgain={again}
            />
          ) : (
            <>
              <header className="card-head">
                <h2 className="h-card">Your basket</h2>
                <span className="fine">
                  {legs.length} {legs.length === 1 ? 'leg' : 'legs'}
                </span>
              </header>

              <label className="basket-name">
                <span className="leg-label">Name, optional</span>
                <input
                  value={name}
                  maxLength={NAME_MAX}
                  onChange={(e) => setName(e.target.value.slice(0, NAME_MAX))}
                  placeholder="Majors this hour"
                  disabled={phase !== 'idle'}
                />
              </label>

              <ol className="ticket-legs">
                {legs.map((l, i) => {
                  const ev = eventOf(l.event);
                  const ra = ev?.rungs.find((r) => r.symbol === l.a);
                  const rb = ev?.rungs.find((r) => r.symbol === l.b);
                  const s = statuses[l.key];
                  const k = kindOfLeg(l.kind);
                  return (
                    <li
                      key={l.key}
                      className={
                        button.blockedLeg === i ? 'is-blocking' : undefined
                      }
                    >
                      <div>
                        <span className="ticket-meta">
                          {i + 1} · {productName(k)} ·{' '}
                          {ev ? assetLabel(ev) : '…'}
                        </span>
                        <span className="ticket-bet">
                          {ra && rb
                            ? betSentence(k, {
                                condition: ra.strike,
                                target: rb.strike,
                              })
                            : 'Choose two levels'}
                        </span>
                      </div>
                      <b>{usd(s?.cost ?? l.stake)}</b>
                    </li>
                  );
                })}
              </ol>

              <dl className="basket-totals">
                <div>
                  <dt>Total stake</dt>
                  <dd>{usd(sum.stake)}</dd>
                </div>
                <div data-kind="win">
                  <dt>Best case, every leg wins</dt>
                  <dd>{sum.best !== null ? usdSigned(sum.best) : '–'}</dd>
                </div>
                <div data-kind="lose">
                  <dt>Worst case, every leg loses</dt>
                  <dd>{sum.worst !== null ? usdSigned(sum.worst) : '–'}</dd>
                </div>
              </dl>

              <div className="basket-notes">
                <p className="fine">
                  A Return Parlay leg gives its stake back if its first level
                  fails. A Range leg always returns part of what it cost.
                </p>
                {crypto >= 2 && (
                  <p className="fine">
                    Legs on assets that tend to move together can all win or all
                    lose at once.
                  </p>
                )}
                <p className="fine">
                  Each leg is its own bet. If a leg cannot be completed, the
                  legs before it stay placed and the rest are not sent.
                </p>
              </div>

              {basketError && (
                <p className="note note-bad" role="alert">
                  {basketError}
                </p>
              )}

              <button
                className="btn btn-primary btn-wide"
                disabled={!button.canPlace}
                onClick={place}
              >
                {phase === 'placing' ? (
                  <span className="spin" aria-hidden="true" />
                ) : null}
                {button.label}
              </button>
            </>
          )}
        </aside>
      </div>
    </div>
  );
}
