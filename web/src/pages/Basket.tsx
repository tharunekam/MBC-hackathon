import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { api } from '../api';
import type { MarketEvent, PlaceBasketResponse, Rung } from '../api/types';
import BasketLeg from '../components/BasketLeg';
import BasketResult, { type CallProgress } from '../components/BasketResult';
import PayoffBars from '../components/PayoffBars';
import StakeField from '../components/StakeField';
import {
  MAX_LEGS,
  MIN_LEGS,
  NAME_MAX,
  basketButton,
  buildRequest,
  costNote,
  cryptoLegs,
  defaultLevels,
  inOrder,
  kindOfLeg,
  levelsValid,
  listed,
  makeLeg,
  pickMarket,
  refusedLeg,
  seedLegs,
  sharedMarketNote,
  splitEvenly,
  splitWords,
  stakeText,
  stripLegPrefix,
  ticketTop,
  totals,
  withFirst,
  type LegDraft,
  type LegKind,
  type LegStatus,
} from '../lib/basket';
import {
  curveWords,
  extremes,
  legPay,
  paysIntro,
  waitingOnLadder,
  waitingWords,
} from '../lib/basketPays';
import { betSentence, productName } from '../lib/betKind';
import { pct, usd, usdSigned } from '../lib/format';
import { friendly } from '../lib/friendly';
import { useResource } from '../lib/hooks';
import { listLadders } from '../lib/ladders';
import { execLive } from '../lib/liveClients';
import { assetLabel, closesLabel } from '../lib/markets';
import {
  payoffCurves,
  type LadderCurve,
  type LegPay,
} from '../lib/payoffCurve';
import {
  chanceWords,
  neverAllWin,
  shapeOf,
  spanWords,
  together,
  winsAt,
  type JointLeg,
  type Together,
} from '../lib/together';
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

/**
 * The ticket's place while the legs scroll beside it (see `ticketTop`). Its height changes with every leg, chart and note,
 * so it is measured as it changes rather than guessed.
 */
function useTicketTop(): [React.RefObject<HTMLElement>, number | undefined] {
  const ref = useRef<HTMLElement>(null);
  const [top, setTop] = useState<number>();
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setTop(ticketTop(el.offsetHeight, window.innerHeight));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    window.addEventListener('resize', measure);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, []);
  return [ref, top];
}

export default function Basket() {
  const venue = useVenue();
  const [ticketRef, ticketAt] = useTicketTop();
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
  const sized = costNote(
    sum,
    legs.flatMap((l, i) =>
      (statuses[l.key]?.reducedTo ?? null) !== null ? [i] : [],
    ),
  );
  const crypto = cryptoLegs(legs.map((l) => eventOf(l.event)));
  // Legs may share a market (the picker allows it, and with one asset the page opens that way). Said once, on the ticket.
  const sameMarket = sharedMarketNote(legs.map((l) => l.event));

  // How the legs come out together, read from the same ladders the legs are built on, so it moves whenever the prices do.
  // A leg with no market or levels yet goes in as null and is reported as left out.
  const joint = useMemo(() => {
    const rungs: Record<string, Rung[]> = {};
    const shapes = legs.map((l): JointLeg | null => {
      const ev = eventOf(l.event);
      const a = ev?.rungs.find((r) => r.symbol === l.a);
      const b = ev?.rungs.find((r) => r.symbol === l.b);
      if (!ev || !a || !b || !inOrder(l.kind, a, b)) return null;
      rungs[ev.ticker] = ev.rungs;
      return { ticker: ev.ticker, shape: shapeOf(l.kind, a.strike, b.strike) };
    });
    return {
      shapes,
      rungs,
      result: together(shapes, rungs),
      neverAll: neverAllWin(shapes),
    };
  }, [legs, eventOf]);

  // What the legs net at each finishing price, ladder by ladder, from the same shapes and each leg's own win and loss. The
  // best and worst case come from the same legs: they are what a finishing price can really give, which is not always
  // "every leg wins" and "every leg loses".
  const pays = useMemo(() => {
    const list = joint.shapes.map((shape, i) =>
      legPay(shape, statuses[legs[i]?.key ?? '']),
    );
    return {
      list,
      ...payoffCurves(list, joint.rungs),
      extremes: extremes(list),
    };
  }, [joint, statuses, legs]);
  // The tendency is only worth stating about a range, and a range only exists between separate ladders.
  const cryptoApart = cryptoLegs(
    Array.from(new Set(legs.map((l) => l.event)), eventOf),
  );
  const leaning =
    !!joint.result.allWin && !joint.result.allWin.exact && cryptoApart >= 2;
  // The short warning says the legs "can all win", which is wrong once two of them cannot both win, and is already said
  // at more length when the panel talks about the range.
  const warnTogether =
    crypto >= 2 &&
    !leaning &&
    joint.result.impossible.length === 0 &&
    joint.neverAll.length === 0;

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
                  ? `${splitWords(amount, Math.max(1, legs.length))} Change a leg’s stake to set it yourself.`.trim()
                  : `Leg stakes are set by hand and add up to ${usd(sum.stake)}.`
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

          {/* Beside the ticket, not in it: the charts need the width, and the ticket has to stay short enough to act on. */}
          {events.length > 0 && legs.length >= MIN_LEGS && (
            <PaysPanel
              curves={pays.curves}
              missing={pays.missing}
              pays={pays.list}
              eventOf={eventOf}
              tickerOf={(i) =>
                joint.shapes[i]?.ticker ?? legs[i]?.event ?? null
              }
            />
          )}
        </div>

        <aside
          ref={ticketRef}
          className="card quote-card basket-ticket"
          style={ticketAt === undefined ? undefined : { top: ticketAt }}
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
                      <b>{usd(l.stake)}</b>
                    </li>
                  );
                })}
              </ol>

              <dl className="basket-totals">
                <div>
                  <dt>Total stake</dt>
                  <dd>{usd(sum.stake)}</dd>
                </div>
                <div>
                  <dt>What the orders cost</dt>
                  <dd>{usd(sum.cost)}</dd>
                  {sized && <dd className="basket-cost">{sized}</dd>}
                </div>
                <div data-kind="win">
                  <dt>
                    {pays.extremes && !pays.extremes.everyWin
                      ? 'Best case'
                      : 'Best case, every leg wins'}
                  </dt>
                  <dd>
                    {pays.extremes ? usdSigned(pays.extremes.best) : '–'}
                  </dd>
                </div>
                <div data-kind="lose">
                  <dt>
                    {pays.extremes && !pays.extremes.everyLose
                      ? 'Worst case'
                      : 'Worst case, every leg loses'}
                  </dt>
                  <dd>
                    {pays.extremes ? usdSigned(pays.extremes.worst) : '–'}
                  </dd>
                </div>
              </dl>

              {legs.length >= MIN_LEGS && (
                <TogetherPanel
                  joint={joint.result}
                  shapes={joint.shapes}
                  neverAll={joint.neverAll}
                  assetOf={(ticker) => {
                    const ev = eventOf(ticker);
                    return ev ? assetLabel(ev) : 'the price';
                  }}
                  leaning={leaning}
                  warn={warnTogether}
                />
              )}

              {sameMarket && <p className="note note-warn">{sameMarket}</p>}

              <p className="fine basket-terms">
                Each leg is its own bet, with its own result. If a leg cannot
                be completed, the legs before it stay placed and the rest are
                not sent.
              </p>

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

/**
 * How the legs come out together. Legs on one ladder get an exact figure, because one finishing price decides them. Legs on
 * separate ladders get the range that holds however the markets move together, with the figure for unrelated markets marked
 * inside it as a reference point. The figures are the market's, from the exchange's prices, and show "–" while a leg has none.
 */
function TogetherPanel({
  joint,
  shapes,
  neverAll,
  assetOf,
  leaning,
  warn,
}: {
  joint: Together;
  shapes: (JointLeg | null)[];
  /** Three or more legs on one ladder that can win two by two but never all at once (see `neverAllWin`). */
  neverAll: { legs: number[]; ticker: string }[];
  /** What a ladder's price is of, for a sentence: "Bitcoin". */
  assetOf: (ticker: string) => string;
  /** Whether to say which way legs on crypto assets tend to pull the range. */
  leaning: boolean;
  /** Whether to say that the legs can move together while the figures that would show it are still missing. */
  warn: boolean;
}) {
  const { allWin, anyWin, missing, impossible } = joint;
  const ranged = !!allWin && !allWin.exact;
  const anyRange = ranged || (!!anyWin && !anyWin.exact);
  const count = shapes.length;

  // Two legs on one ladder whose winning prices never overlap. The first pair is spelled out; any others are counted.
  const clash = impossible[0];
  const first = clash ? shapes[clash.legs[0]] : null;
  const second = clash ? shapes[clash.legs[1]] : null;

  return (
    <section className="together" aria-labelledby="together-head">
      <h3 className="together-head" id="together-head">
        How the legs move together
      </h3>

      <p className="together-line">
        Chance every leg wins: <b>{allWin ? spanWords(allWin) : '–'}</b>
      </p>
      {allWin && ranged && (
        <div className="together-meter">
          <div
            className="together-bar"
            role="img"
            aria-label={`A bar from 0% to 100%, shaded from ${pct(allWin.low)} to ${pct(allWin.high)} and marked at ${pct(allWin.ifUnrelated)}.`}
          >
            <span
              className="together-range"
              style={{
                left: `${allWin.low * 100}%`,
                width: `${(allWin.high - allWin.low) * 100}%`,
              }}
            />
            <span
              className="together-tick"
              style={{ left: `${allWin.ifUnrelated * 100}%` }}
            />
          </div>
          <div className="together-scale" aria-hidden="true">
            <span>0%</span>
            <span>100%</span>
          </div>
        </div>
      )}
      <p className="together-line">
        At least one leg wins: <b>{anyWin ? spanWords(anyWin) : '–'}</b>
      </p>

      {clash && first && second && (
        <p className="note note-warn">
          {count === 2
            ? 'These two legs'
            : `Legs ${clash.legs[0] + 1} and ${clash.legs[1] + 1}`}{' '}
          cannot both win: leg {clash.legs[0] + 1} needs{' '}
          {assetOf(clash.ticker)} {winsAt(first.shape)} and leg{' '}
          {clash.legs[1] + 1} needs it {winsAt(second.shape)}.
          {impossible.length === 2 &&
            ' One other pair of legs cannot both win either.'}
          {impossible.length > 2 &&
            ` ${impossible.length - 1} other pairs of legs cannot both win either.`}{' '}
          A basket is not all-or-nothing, so each leg still has its own result.
        </p>
      )}

      {neverAll.map((n) => (
        <p className="note note-warn" key={n.ticker}>
          {n.legs.length === count
            ? 'These legs'
            : `Legs ${listed(n.legs.map((i) => i + 1))}`}{' '}
          cannot all win: no finishing price for {assetOf(n.ticker)} wins every
          one of them. A basket is not all-or-nothing, so each leg still has its
          own result.
        </p>
      ))}

      {/* One paragraph of small print, not three: whose chances these are, and what the bar's range and mark mean. */}
      {missing.length > 0 ? (
        <p className="fine">
          {waitingWords(missing)}
          {warn &&
            ' Legs on assets that tend to move together can all win or all lose at once.'}
        </p>
      ) : (
        <p className="fine">
          {joint.groups.length === 1 &&
            (count === 2
              ? 'Both legs are on the same market, so one finishing price decides both. '
              : `All ${count} legs are on the same market, so one finishing price decides them all. `)}
          These are the market’s chances, from its prices right now.
          {anyRange &&
            ' Prices do not say how separate markets move together, so a range is all that is certain.'}
          {allWin &&
            ranged &&
            ` The mark is where it would sit if they were unrelated: ${chanceWords(allWin.ifUnrelated)}.`}
          {joint.adjusted &&
            ' Some of the prices were out of order, so they were averaged first.'}
        </p>
      )}
      {leaning && (
        <p className="fine">
          Crypto prices tend to move together: legs that point the same way
          lean toward the top of the range, and legs that point opposite ways
          toward the bottom.
        </p>
      )}
    </section>
  );
}

/**
 * A sentence with its figures set apart: each dollar amount and each percent is kept on one line, so "−$30.00" never breaks
 * after its minus sign, and can be given weight where the figures are the point of the sentence.
 */
function Figures({ text }: { text: string }) {
  const parts = text.split(/((?:[+−])?\$[\d,]+(?:\.\d+)?|(?:under |over )?\d+%)/);
  return (
    <>
      {parts.map((part, i) => (i % 2 === 1 ? <b key={i}>{part}</b> : part))}
    </>
  );
}

/** A phone opens with the charts folded away, so the ticket and its button stay within reach; a wider window shows them. */
const chartsStartOpen = (): boolean =>
  typeof window === 'undefined' ||
  typeof window.matchMedia !== 'function' ||
  window.matchMedia('(min-width: 721px)').matches;

/**
 * What the basket pays: for each ladder it uses, the legs on that ladder added up at every price the ladder can finish at
 * (see lib/payoffCurve.ts), with the same thing in a sentence. One finishing price decides every leg on a ladder, so each
 * chart is exact for the exchange's prices. Ladders are never added to each other, and the sentence above the charts says so.
 */
function PaysPanel({
  curves,
  missing,
  pays,
  eventOf,
  tickerOf,
}: {
  curves: LadderCurve[];
  /** Legs that are in no chart yet, by their place in the basket. */
  missing: number[];
  /** The list the curves were made from: one per leg, null for a leg with no levels or no figures. */
  pays: (LegPay | null)[];
  eventOf: (ticker: string | null) => MarketEvent | undefined;
  /** The ladder a leg is on, when it has one, so a leg that is left out is named under its own ladder's chart. */
  tickerOf: (leg: number) => string | null;
}) {
  const [open, setOpen] = useState(chartsStartOpen);
  const assetOf = (ticker: string) => {
    const ev = eventOf(ticker);
    return ev ? assetLabel(ev) : 'this market';
  };
  // Two ladders on one asset (Bitcoin at 3pm and at 4pm) are told apart by when they close.
  const shared = (ticker: string) =>
    curves.some(
      (c) => c.ticker !== ticker && assetOf(c.ticker) === assetOf(ticker),
    );
  const closes = (ticker: string) =>
    closesLabel(eventOf(ticker)?.expiry ?? null);
  const elsewhere = missing.filter(
    (i) => !curves.some((c) => c.ticker === tickerOf(i)),
  );

  return (
    <details
      className="card pays"
      open={open}
      onToggle={(e) => setOpen(e.currentTarget.open)}
    >
      <summary>
        <h2 className="h-card">What this basket pays</h2>
        <span className="pays-toggle">
          {open ? 'Hide' : curves.length === 1 ? 'Show chart' : 'Show charts'}
          <span className="pays-caret" aria-hidden="true" />
        </span>
      </summary>
      <div className="pays-body">
        <p className="pays-intro">
          {paysIntro(curves, missing, pays.length)}
        </p>
        {curves.length > 0 && (
          <div
            className="pays-grid"
            data-many={curves.length > 2 ? '' : undefined}
          >
            {curves.map((c) => {
              const asset = assetOf(c.ticker);
              const words = curveWords(
                c,
                pays,
                shared(c.ticker) ? `${asset} (${closes(c.ticker)})` : asset,
              );
              const waiting = missing.filter((i) => tickerOf(i) === c.ticker);
              return (
                <article className="pays-ladder" key={c.ticker}>
                  <h3 className="pays-name">
                    <span>
                      {asset} · {closes(c.ticker)}
                    </span>
                    <span>
                      {c.legs.length === 1 ? 'Leg' : 'Legs'}{' '}
                      {listed(c.legs.map((i) => i + 1))}
                    </span>
                  </h3>
                  <PayoffBars curve={c} asset={asset} />
                  <p className="pays-line">
                    <Figures text={words.line} />
                  </p>
                  <p className="fine">
                    <Figures text={words.average} />
                    {c.adjusted &&
                      ' Some of this ladder’s prices were out of order, so they were evened out first.'}
                  </p>
                  {waiting.length > 0 && (
                    <p className="fine">{waitingOnLadder(waiting)}</p>
                  )}
                </article>
              );
            })}
          </div>
        )}
        {elsewhere.length > 0 && (
          <p className="fine">{waitingWords(elsewhere)}</p>
        )}
      </div>
    </details>
  );
}
