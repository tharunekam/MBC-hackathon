import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { ApiError } from '../api/client';
import type { MarketEvent, PlaceBasketRequest, PlaceBasketResponse, Rung } from '../api/types';
import BasketLeg, { kindLabel, legTitleId } from '../components/BasketLeg';
import BasketResult, { type CallProgress } from '../components/BasketResult';
import PayoffBars from '../components/PayoffBars';
import StakeField from '../components/StakeField';
import {
  MAX_LEGS,
  MIN_LEGS,
  NAME_MAX,
  basketAttemptKey,
  basketButton,
  basketsFromBets,
  buildRequest,
  costNote,
  cryptoLegs,
  defaultLevels,
  inOrder,
  kindOfLeg,
  legsPointAWay,
  levelsValid,
  listed,
  makeLeg,
  pickMarket,
  refusedLeg,
  restFrom,
  seedLegs,
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
import { betSentence } from '../lib/betKind';
import { usableBets } from '../lib/betsView';
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
  spanEnds,
  spanWords,
  together,
  winsAt,
  type JointLeg,
  type Span,
  type Together,
} from '../lib/together';
import { useStakeCap } from '../lib/stake';
import { mayHaveBeenPlaced, useAttempts, useUnconfirmedBet } from '../lib/unconfirmedBet';
import { keepMode, useVenue } from '../lib/venue';
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


/** The kinds a new leg tries in turn: a rising Stake Back first, as every basket has opened with. */
const KIND_ORDER: LegKind[] = ['up', 'range', 'down', 'breakout'];

/**
 * A market and kind for a new leg that no leg is already on: the market `pickMarket` prefers first (an asset not yet in the
 * basket), then any other. A market that already has a leg gets a different kind of bet, so "Add a leg" never makes a copy of
 * one. Null when every kind on every market is already in the basket.
 */
function freshLeg(
  events: MarketEvent[],
  legs: LegDraft[],
): { ev: MarketEvent; kind: LegKind } | null {
  const taken = new Set(legs.map((l) => `${l.event}|${l.kind}`));
  const first = pickMarket(
    events,
    legs.map((l) => l.event),
  );
  const order = first ? [first, ...events.filter((e) => e !== first)] : events;
  for (const ev of order) {
    const kind = KIND_ORDER.find((k) => !taken.has(`${ev.ticker}|${k}`));
    if (kind) return { ev, kind };
  }
  return null;
}

/** Whether the window is phone or tablet width, where the ticket follows the legs and the Place button rides along. */
const NARROW = '(max-width: 960px)';
function useNarrow(): boolean {
  const [narrow, setNarrow] = useState(
    () => typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(NARROW).matches,
  );
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia(NARROW);
    const on = () => setNarrow(mq.matches);
    on();
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return narrow;
}

/** The phone's tab bar is fixed to the bottom of the window, so the Place bar rides just above it. Zero where there is none. */
function useTabbarHeight(active: boolean): number {
  const [h, setH] = useState(0);
  useLayoutEffect(() => {
    const el = active ? document.querySelector<HTMLElement>('.tabbar') : null;
    if (!el) {
      setH(0);
      return;
    }
    const measure = () => setH(el.offsetHeight);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    window.addEventListener('resize', measure);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [active]);
  return h;
}

const round2 = (x: number) => Math.round(x * 100) / 100;

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
  const [cap] = useStakeCap();
  const attempts = useAttempts();
  // A link may name a market (?market=TICKER). The basket opens on its own choice of markets either way, but a link to one the
  // exchange no longer lists says so, until the person picks a market themselves.
  const wanted = useSearchParams()[0].get('market');
  const [chose, setChose] = useState(false);
  const unlisted =
    !!wanted &&
    !chose &&
    !!markets.data &&
    !markets.data.events.some((e) => e.ticker === wanted);
  const narrow = useNarrow();
  const tabbarH = useTabbarHeight(narrow);

  const [amountText, setAmountText] = useState(String(DEFAULT_AMOUNT));
  const [amount, setAmount] = useState(DEFAULT_AMOUNT);
  // While true, the legs share the amount evenly and follow it; typing a leg's own stake turns it off.
  const [even, setEven] = useState(true);
  const [legs, setLegs] = useState<LegDraft[]>([]);
  const [name, setName] = useState('');
  const [statuses, setStatuses] = useState<Record<string, LegStatus>>({});
  const [legErrors, setLegErrors] = useState<Record<string, string>>({});
  const [basketError, setBasketError] = useState<string | null>(null);
  // An answer that does not say whether the basket was placed. The person is sent to My bets rather than to a retry. The note
  // stays until they change the basket or press Place again; the button's own hold (see `useUnconfirmedBet`) is shorter.
  const [unsure, setUnsure] = useState(false);
  const [reloadSignal, setReloadSignal] = useState(0);
  // What a screen reader is told when something has happened; prices and typing are left silent.
  const [announce, setAnnounce] = useState('');

  const [phase, setPhase] = useState<'idle' | 'placing' | 'placed'>('idle');
  const [placedLegs, setPlacedLegs] = useState<LegDraft[]>([]);
  const [result, setResult] = useState<PlaceBasketResponse | null>(null);
  const [calls, setCalls] = useState<CallProgress>({
    total: 0,
    done: 0,
    failed: 0,
    late: 0,
    failedIds: [],
  });
  const resultHead = useRef<HTMLHeadingElement>(null);
  // Where keyboard focus goes after the control that had it is gone: a leg's heading after Remove, the amount after Make another.
  const focusLeg = useRef<string | null>(null);
  const focusAmount = useRef(false);

  // The basket is placed: bring the result into view and hand it focus, because the button that had focus is gone and the
  // result can be a screen below the legs on a phone.
  useEffect(() => {
    if (phase === 'placed' && result) resultHead.current?.focus();
  }, [phase, result]);
  useEffect(() => {
    if (phase !== 'idle' || !focusAmount.current) return;
    focusAmount.current = false;
    document.getElementById('basket-amount')?.focus();
  }, [phase]);
  useEffect(() => {
    const key = focusLeg.current;
    if (!key) return;
    focusLeg.current = null;
    document.getElementById(legTitleId(key))?.focus();
  }, [legs]);

  const eventOf = useCallback(
    (ticker: string | null): MarketEvent | undefined =>
      events.find((e) => e.ticker === ticker),
    [events],
  );

  // Open on two legs on different assets once the markets arrive; afterwards, keep every leg on a market that still exists
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
    setUnsure(false);
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

  // While the stakes are set by hand the amount box shows what they add up to, so it never says something the legs do not.
  const showTotal = (list: LegDraft[]) => {
    const total = round2(list.reduce((n, l) => n + l.stake, 0));
    setAmount(total);
    setAmountText(stakeText(total));
  };

  // Typing an amount shares it evenly again, which is what the box is for.
  function setAmountFrom(txt: string) {
    setAmountText(txt);
    const n = parseStake(txt);
    if (n === null) return;
    setAmount(n);
    setEven(true);
    setBasketError(null);
    setUnsure(false);
    setLegs((prev) => resplit(prev, n));
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
    setChose(true);
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
    const n = parseStake(txt);
    showTotal(
      legs.map((l) => (l.key === key ? { ...l, stake: n ?? 0 } : l)),
    );
    update(key, (l) => ({ ...l, stakeText: txt, stake: n ?? 0 }));
  }

  const fresh = useMemo(() => freshLeg(events, legs), [events, legs]);
  function addLeg() {
    if (legs.length >= MAX_LEGS || !fresh) return;
    setBasketError(null);
    setUnsure(false);
    const n = legs.length + 1;
    const share = splitEvenly(amount, n)[n - 1] ?? 0;
    const leg = makeLeg(fresh.ev, fresh.kind, share, feeCoef);
    const next = even ? resplit([...legs, leg], amount) : [...legs, leg];
    setLegs(next);
    if (!even) showTotal(next);
  }
  function removeLeg(key: string) {
    if (legs.length <= MIN_LEGS) return;
    setBasketError(null);
    setUnsure(false);
    const at = legs.findIndex((l) => l.key === key);
    focusLeg.current = (legs[at + 1] ?? legs[at - 1])?.key ?? null;
    const rest = legs.filter((l) => l.key !== key);
    const next = even ? resplit(rest, amount) : rest;
    setLegs(next);
    if (!even) showTotal(next);
    setStatuses((prev) => {
      const { [key]: _gone, ...others } = prev;
      return others;
    });
  }

  const loadingFirst = markets.loading && !markets.data;
  const failedToLoad = !!markets.error && !markets.data;
  const noMarkets = !loadingFirst && events.length === 0;

  const legStatuses = legs.map((l) => statuses[l.key]);
  const button = basketButton({
    phase,
    readOnly: venue.readOnly,
    legs: legStatuses,
    placing: legs.length,
  });
  const buttonLabel = loadingFirst ? 'Loading markets' : button.label;
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

  // The same bet twice: the number of the earlier leg, for a leg that copies one.
  const sameAs = legs.map((l, i) => {
    if (!l.event || !l.a || !l.b) return null;
    const j = legs.findIndex(
      (o, at) =>
        at < i &&
        o.event === l.event &&
        o.kind === l.kind &&
        o.a === l.a &&
        o.b === l.b,
    );
    return j < 0 ? null : j + 1;
  });

  // How the legs come out together, read from the same markets the legs are built on, so it moves whenever the prices do.
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

  // What the legs net at each finishing price, market by market, from the same shapes and each leg's own win and loss. The
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
  // The tendency is only worth stating about a range, and a range only exists between separate markets.
  const cryptoApart = cryptoLegs(
    Array.from(new Set(legs.map((l) => l.event)), eventOf),
  );
  // "Legs that point the same way" means something only for a Stake Back, which points up or down. A Range or a Breakout on a
  // crypto market points nowhere, and the joint chance of such a leg can sit below the mark for unrelated markets even though
  // the prices move together, so the sentence is left out whenever one is in the basket.
  const pointing = legsPointAWay(
    legs.map((l) => ({
      kind: l.kind,
      crypto: cryptoLegs([eventOf(l.event)]) > 0,
    })),
  );
  const leaning =
    !!joint.result.allWin &&
    !joint.result.allWin.exact &&
    cryptoApart >= 2 &&
    pointing;
  // The short warning says the legs "can all win", which is wrong once two of them cannot both win, and is already said
  // at more length when the panel talks about the range.
  const warnTogether =
    crypto >= 2 &&
    !leaning &&
    joint.result.impossible.length === 0 &&
    joint.neverAll.length === 0;

  /** The calls are recorded one by one after the bets are placed; a call that fails is kept so it can be tried again. */
  const commitCalls = useCallback((ids: string[]) => {
    for (const id of ids) {
      api.commitCall(id).then(
        () => setCalls((c) => ({ ...c, done: c.done + 1 })),
        (e) =>
          // A call is refused for good once its market has closed: asking again cannot help, so it is counted apart.
          setCalls((c) =>
            e instanceof ApiError && e.code === 'too_late'
              ? { ...c, late: c.late + 1 }
              : { ...c, failed: c.failed + 1, failedIds: [...c.failedIds, id] },
          ),
      );
    }
  }, []);
  function retryCalls() {
    const ids = calls.failedIds;
    setCalls((c) => ({ ...c, failed: 0, failedIds: [] }));
    commitCalls(ids);
  }

  // What went out last: the request with its id and price limits, the legs as they were, and the prices they were placed at. Kept so
  // that when the answer is lost the very same request can be sent again, and so that an answer found later is shown on the legs
  // the person placed, whatever they have changed since.
  const sent = useRef<{ req: PlaceBasketRequest; snapshot: LegDraft[]; prices: (number | null)[] } | null>(null);
  // True while a placement is out: the button is disabled once the page has drawn, but clicks that arrive in one task all run before.
  const inflight = useRef(false);

  /** The executor's answer, or the basket found by the id it was sent under: the result, and the calls to seal. */
  function adopt(res: PlaceBasketResponse, snapshot: LegDraft[]) {
    attempts.spend();
    setPlacedLegs(snapshot);
    setResult(res);
    setPhase('placed');
    setUnsure(false);
    const open = res.bets.filter((b) => b.status === 'open');
    setCalls({ total: open.length, done: 0, failed: 0, late: 0, failedIds: [] });
    setAnnounce(
      res.basket.failed
        ? `Basket placed in part. Leg ${res.basket.failed.index + 1} could not be completed.`
        : `Basket placed. ${res.bets.length} bets.`,
    );
    commitCalls(open.map((b) => b.id));
    markets.reload();
  }

  /** A refusal is the executor's answer: nothing was placed, and the next try is a new attempt. It names a leg when it can. */
  function refuse(e: unknown, snapshot: LegDraft[], prices: (number | null)[]) {
    attempts.spend();
    const refused = refusedLeg(e);
    const leg = refused ? snapshot[refused.index] : undefined;
    if (refused && leg) {
      setLegErrors({
        [leg.key]: stripLegPrefix(
          friendly(e, { ...kindOfLeg(leg.kind), shownPrice: prices[refused.index] ?? null, basket: true }),
        ),
      });
      const text = `Leg ${refused.index + 1} was turned down, so nothing was placed.`;
      setBasketError(text);
      setAnnounce(text);
    } else {
      const text = friendly(e, { basket: true });
      setBasketError(text);
      setAnnounce(text);
    }
    setReloadSignal((n) => n + 1);
    markets.reload();
  }

  // After a dropped connection or a server error the basket may have been placed anyway. The button is held while the list of
  // bets is read for the basket (every bet of it carries the id it was sent under), and once the same request is sent again
  // under the same id: the executor places nothing twice for one id, so that returns the basket that was placed, or places it
  // now, but never two.
  const [holding, setHolding] = useUnconfirmedBet<PlaceBasketResponse>(
    () => api.bets('primary').then((r) => basketsFromBets(usableBets(r.bets))),
    (r) => r.basket.clientRequestId !== undefined && r.basket.clientRequestId === sent.current?.req.requestId,
    (r) => {
      if (sent.current) adopt(r, sent.current.snapshot);
    },
    {
      send: () => (sent.current ? api.placeBasket(sent.current.req) : Promise.reject(new Error('nothing was sent'))),
      refused: (e) => {
        if (sent.current) refuse(e, sent.current.snapshot, sent.current.prices);
      },
    },
  );
  const canPlace = button.canPlace && !holding;

  async function place() {
    if (!canPlace || inflight.current) return;
    // The price per $1 each leg's quote showed: a leg may cost up to a little more than that, and no more.
    const prices = legs.map((l) => statuses[l.key]?.pricePaid ?? null);
    let req;
    try {
      req = buildRequest(name, legs, 'primary', prices);
    } catch {
      // Whatever was thrown is a developer's sentence: the person is told the one thing that can be wrong here.
      setBasketError('Every leg needs a market and two levels.');
      return;
    }
    inflight.current = true;
    // One id for each attempt: pressing Place basket again after an answer was lost sends the same id, so the executor places the
    // basket once whichever of the two requests got through. Another basket, or an answered attempt, gets a new one. The id
    // follows the bets chosen, not the price limits (which tick) or the name.
    req = { ...req, requestId: attempts.idFor(basketAttemptKey(req)) };
    const snapshot = legs;
    sent.current = { req, snapshot, prices };
    setHolding(false);
    setPhase('placing');
    setBasketError(null);
    setUnsure(false);
    setLegErrors({});
    try {
      adopt(await api.placeBasket(req), snapshot);
    } catch (e) {
      if (mayHaveBeenPlaced(e)) {
        // The basket may have been placed: asking again could place it twice. Send the person to My bets and hold the button.
        setUnsure(true);
        setHolding(true);
        setAnnounce('We could not confirm this basket. Check My bets before trying again.');
        setReloadSignal((n) => n + 1);
        markets.reload();
      } else {
        refuse(e, snapshot, prices);
      }
      setPhase('idle');
    } finally {
      inflight.current = false;
    }
  }

  function again() {
    focusAmount.current = true;
    setPhase('idle');
    setResult(null);
    setName('');
    setAnnounce('');
    setCalls({ total: 0, done: 0, failed: 0, late: 0, failedIds: [] });
  }

  // A basket placed in part: reopen the form on the legs that were not placed, with the stakes they had.
  function placeRest() {
    const from = result ? restFrom(result) : 0;
    const next = legs.filter((_, i) => i >= from);
    focusAmount.current = true;
    setLegs(next);
    setEven(false);
    showTotal(next);
    setPhase('idle');
    setResult(null);
    setAnnounce('');
    setCalls({ total: 0, done: 0, failed: 0, late: 0, failedIds: [] });
  }

  const showBar = narrow && phase !== 'placed' && !loadingFirst && !noMarkets;
  const cappedAll = cap !== null && legs.length > 0 ? cap * legs.length : null;
  const capWords =
    cap !== null && legs.length > 0
      ? `Up to ${usd(cap, 0)} a bet, so up to ${usd(cap * legs.length, 0)} in total with ${legs.length} legs.`
      : '';

  const placeButton = (
    <button type="button"
      className="btn btn-primary btn-wide"
      disabled={!canPlace}
      onClick={place}
    >
      {phase === 'placing' ? <span className="spin" aria-hidden="true" /> : null}
      {buttonLabel}
    </button>
  );
  const buttonNotes = (
    <>
      {venue.readOnly && (
        <p className="fine basket-off">
          Prices only. Placing bets is switched off here.
        </p>
      )}
      {basketError && (
        <p className="note note-bad" role="alert">
          {basketError}
        </p>
      )}
      {unsure && (
        <p className="note note-warn" role="alert">
          We could not confirm this basket.{' '}
          <Link to={keepMode('/bets')}>Check My bets</Link> before trying
          again.
        </p>
      )}
    </>
  );

  return (
    <div className="page builder basket" data-phase={phase}>
      <header className="page-head">
        <div>
          <h1 className="h-page">Basket</h1>
          <p className="lede">
            Up to {MAX_LEGS} bets, placed in one step. Each keeps its own two
            orders and its own result.
          </p>
        </div>
      </header>

      <p className="sr-only" role="status">
        {announce}
      </p>

      {unlisted && (
        <p className="note note-info deep-link-note">
          That market is no longer listed.{' '}
          <Link to={keepMode('/markets')}>See all markets</Link>
        </p>
      )}

      {failedToLoad && (
        <div className="card notice" role="alert">
          <span>We could not load the markets. Try again in a moment.</span>
          <button type="button" className="btn btn-ghost" onClick={markets.reload}>
            Try again
          </button>
        </div>
      )}

      {noMarkets && !failedToLoad && (
        <div className="card notice">
          <span>No markets have prices right now. Check back in a few minutes.</span>
          <button type="button" className="btn btn-ghost" onClick={markets.reload}>
            Try again
          </button>
        </div>
      )}

      {!noMarkets && (
        <div className="build-grid">
          <div className="left-col">
            <section className="card basket-amount" aria-label="Total to share across legs">
              <StakeField
                id="basket-amount"
                label="Total to share across legs"
                text={amountText}
                stake={amount}
                max={cappedAll}
                onText={setAmountFrom}
                presets={[20, 30, 50, 100]}
                note={
                  legs.length === 0
                    ? 'Shared evenly across the legs.'
                    : even
                      ? `${splitWords(amount, legs.length)} ${capWords}`.trim()
                      : `Leg stakes are set by hand and add up to ${usd(sum.stake)}. ${capWords}`.trim()
                }
              />
              {!even && (
                <button
                  type="button"
                  className="btn btn-ghost basket-split"
                  onClick={splitNow}
                  disabled={phase !== 'idle' || legs.length === 0}
                >
                  Split evenly
                </button>
              )}
            </section>

            {loadingFirst ? (
              <div className="legs-skel" aria-hidden="true">
                <div className="skeleton leg-skel" />
                <div className="skeleton leg-skel" />
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
                    minNoteId="basket-min-note"
                    sameAs={sameAs[i] ?? null}
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

            {!loadingFirst && (
              <div className="add-leg">
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={addLeg}
                  disabled={legs.length >= MAX_LEGS || phase !== 'idle' || !fresh}
                >
                  Add a leg
                </button>
                <span className="fine" id="basket-min-note">
                  {legs.length >= MAX_LEGS
                    ? `A basket holds ${MAX_LEGS} legs at most.`
                    : !fresh
                      ? 'Every bet you can make here is already in your basket.'
                      : legs.length <= MIN_LEGS
                        ? `${legs.length} of ${MAX_LEGS} legs. A basket needs at least ${MIN_LEGS}.`
                        : `${legs.length} of ${MAX_LEGS} legs`}
                </span>
              </div>
            )}

            {/* Beside the ticket, not in it: the charts need the width, and the ticket has to stay short enough to act on. */}
            {!loadingFirst && legs.length >= MIN_LEGS && (
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
            aria-label="Your basket"
          >
            {phase === 'placed' && result ? (
              <BasketResult
                result={result}
                legs={placedLegs}
                events={events}
                calls={calls}
                headingRef={resultHead}
                onAgain={again}
                onRest={placeRest}
                onRetryCalls={retryCalls}
              />
            ) : loadingFirst ? (
              <>
                <header className="card-head">
                  <h2 className="h-card">Your basket</h2>
                </header>
                <div className="skeleton ticket-skel" aria-hidden="true" />
                {placeButton}
              </>
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
                  <input type="text"
                    value={name}
                    maxLength={NAME_MAX}
                    onChange={(e) => setName(e.target.value.slice(0, NAME_MAX))}
                    placeholder="Majors this hour"
                    disabled={phase !== 'idle'}
                  />
                </label>

                {/* The legs are already on screen above the ticket on a phone, so the recap is for the wide layout. */}
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
                            {i + 1} · {kindLabel(k)} ·{' '}
                            {ev ? assetLabel(ev) : '–'}
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

                {legs.length > 0 && (
                  <dl className="basket-totals">
                    {/* The one figure the person pays, set above the rest. The stake follows as a quiet line: it is what the
                        bets were sized from, and a cent or two apart from the cost, so the two are never shown as equals. */}
                    <div data-kind="cost">
                      <dt>What the orders cost</dt>
                      <dd>{usd(sum.cost)}</dd>
                      {sized && <dd className="basket-cost">{sized}</dd>}
                    </div>
                    <div data-kind="stake">
                      <dt>Total stake</dt>
                      <dd>{usd(sum.stake)}</dd>
                    </div>
                    {pays.extremes ? (
                      <>
                        <div data-kind="win">
                          <dt>
                            {!pays.extremes.everyWin
                              ? 'Best case'
                              : 'Best case, every leg wins'}
                          </dt>
                          <dd>{usdSigned(pays.extremes.best)}</dd>
                        </div>
                        <div data-kind="lose">
                          <dt>
                            {!pays.extremes.everyLose
                              ? 'Worst case'
                              : 'Worst case, every leg loses'}
                          </dt>
                          <dd>{usdSigned(pays.extremes.worst)}</dd>
                        </div>
                      </>
                    ) : (
                      <div>
                        <dt>Best and worst case</dt>
                        <dd className="basket-cost">
                          Shown once every leg has a price.
                        </dd>
                      </div>
                    )}
                  </dl>
                )}

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

                {!showBar && buttonNotes}
                {!showBar && placeButton}
              </>
            )}
          </aside>

          {/* On a phone the button rides above the tab bar, so it stays in reach while the legs are being edited. */}
          {showBar && (
            <div className="place-bar" style={{ bottom: tabbarH + 8 }}>
              {(basketError || unsure || venue.readOnly) && (
                <div className="place-bar-notes">{buttonNotes}</div>
              )}
              {/* The button says what the basket costs, so the bar says nothing else about money: a stake a cent away from it
                  would be a second figure to weigh at the moment that matters. */}
              <div className="place-bar-row">{placeButton}</div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** A span as "4% to 31%", one figure when its ends meet. */
function spanText(s: Span): string {
  if (s.exact) return chanceWords(s.low);
  if (pct(s.low) === pct(s.high)) return spanWords(s);
  const ends = spanEnds(s);
  return `${ends.low}% to ${ends.high}%`;
}

/**
 * How the legs come out together. Legs on one market get an exact figure, because one finishing price decides them. Legs on
 * separate markets get the range that holds however the markets move together, with the figure for unrelated markets marked
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
  /** Three or more legs on one market that can win two by two but never all at once (see `neverAllWin`). */
  neverAll: { legs: number[]; ticker: string }[];
  /** What a market's price is of, for a sentence: "Bitcoin". */
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

  // Two legs on one market whose winning prices never overlap. The first pair is spelled out; any others are counted.
  const clash = impossible[0];
  const first = clash ? shapes[clash.legs[0]] : null;
  const second = clash ? shapes[clash.legs[1]] : null;

  return (
    <section className="together" aria-labelledby="together-head">
      <h3 className="together-head" id="together-head">
        How the legs move together
      </h3>

      <p className="together-line">
        Chance every leg wins: <b>{allWin ? spanText(allWin) : '–'}</b>
      </p>
      {allWin && ranged && (
        <div className="together-meter">
          <div
            className="together-bar"
            role="img"
            aria-label={`A bar from 0% to 100%, shaded from ${spanEnds(allWin).low}% to ${spanEnds(allWin).high}% and marked at ${pct(allWin.ifUnrelated)}.`}
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
          <p className="together-key">
            Marker: if the markets were unrelated,{' '}
            {chanceWords(allWin.ifUnrelated)}
          </p>
        </div>
      )}
      <p className="together-line">
        At least one leg wins: <b>{anyWin ? spanText(anyWin) : '–'}</b>
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
            ` ${impossible.length - 1} other pairs of legs cannot both win either.`}
        </p>
      )}

      {neverAll.map((n) => (
        <p className="note note-warn" key={n.ticker}>
          {n.legs.length === count
            ? 'These legs'
            : `Legs ${listed(n.legs.map((i) => i + 1))}`}{' '}
          cannot all win: no finishing price for {assetOf(n.ticker)} wins every
          one of them.
        </p>
      ))}

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
            ' Prices cannot show how separate markets move together, so these are a range.'}
          {joint.adjusted &&
            ' Some of the prices were out of order, so they were averaged first.'}
        </p>
      )}
      {leaning && (
        <p className="fine">
          Crypto prices often move together, so legs that point the same way
          win together more often.
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
                      ' Some of this market’s prices were out of order, so they were evened out first.'}
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
