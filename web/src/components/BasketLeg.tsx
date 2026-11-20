import { useEffect, useMemo } from 'react';
import { useStakeCap } from '../lib/stake';
import { api } from '../api';
import type { MarketEvent, Rung } from '../api/types';
import {
  answerMatches,
  firstOptions,
  legStatus,
  secondOptions,
  type LegAnswer,
  type LegDraft,
  type LegKind,
  type LegStatus,
} from '../lib/basket';
import type { Phase } from '../lib/betState';
import { cents, money, pct, usd } from '../lib/format';
import { useDebounced, useResource } from '../lib/hooks';
import { execLive } from '../lib/liveClients';
import { openingNote } from '../lib/marketPhase';
import { assetLabel, closesLabel, groupByAsset } from '../lib/markets';
import { cleanStakeText } from '../lib/stake';

/**
 * The four kinds of leg. `label` is what the switch shows where there is room and `short` what it shows on a phone, where
 * "Parlay down" would not fit beside the other three. `full` is the name a screen reader hears: it starts with the words on
 * screen, so someone using voice control can say what they see, and then says which product it is.
 */
const KINDS: { kind: LegKind; label: string; short: string; full: string }[] = [
  {
    kind: 'up',
    label: 'Parlay up',
    short: 'Up',
    full: 'Parlay up: Return Parlay, rising',
  },
  {
    kind: 'down',
    label: 'Parlay down',
    short: 'Down',
    full: 'Parlay down: Return Parlay, falling',
  },
  { kind: 'range', label: 'Range', short: 'Range', full: 'Range' },
  { kind: 'breakout', label: 'Breakout', short: 'Breakout', full: 'Breakout' },
];

/** The names of the two levels, by kind of leg. */
const LEVELS: Record<LegKind, [string, string]> = {
  up: ['Given at or above', 'Reach'],
  down: ['Stays under', 'Falls below'],
  range: ['Floor', 'Ceiling'],
  breakout: ['Win below', 'Win at or above'],
};

/** What the chance of winning is called for each kind of leg. */
const CHANCE: Record<LegKind, string> = {
  up: 'Chance to win',
  down: 'Chance to win',
  range: 'Chance inside',
  breakout: 'Chance outside',
};

/**
 * One leg's executor quote, requested with the same debounce and live refresh as the single-bet builders. The key holds only
 * this leg's own choices, so editing another leg never refetches this one.
 */
export function useLegQuote(leg: LegDraft) {
  const choice = useDebounced(
    `${leg.kind}|${leg.event ?? ''}|${leg.a ?? ''}|${leg.b ?? ''}`,
    200,
  );
  const dStake = useDebounced(leg.stake, 350);
  const [kind, event, a, b] = choice.split('|') as [
    LegKind,
    string,
    string,
    string,
  ];
  const q = useResource<LegAnswer | null>(
    `basket-quote:${kind}:${event}:${a}:${b}:${dStake}`,
    () => {
      if (!event || !a || !b) return Promise.resolve(null);
      if (kind === 'range')
        return api.quoteRange({ event, low: a, high: b, stake: dStake });
      if (kind === 'breakout')
        return api.quoteBreakout({ event, low: a, high: b, stake: dStake });
      return api.quote({
        event,
        condition: a,
        target: b,
        stake: dStake,
        direction: kind,
      });
    },
    { live: [[execLive, 'markets']], pollMs: 5000, minGapMs: 1500 },
  );
  const now = `${leg.kind}|${leg.event ?? ''}|${leg.a ?? ''}|${leg.b ?? ''}`;
  const forLevels =
    q.data &&
    q.data.event.ticker === leg.event &&
    answerMatches(leg.kind, q.data, leg.a, leg.b)
      ? q.data
      : null;
  // The button may rely on the answer only when it is for these levels AND this stake, not one a moment ago.
  const current = !!forLevels && choice === now && dStake === leg.stake;
  return {
    shown: forLevels,
    answer: current ? forLevels : null,
    error: !!q.error && !q.data,
    reload: q.reload,
  };
}

interface Props {
  index: number;
  leg: LegDraft;
  /** The ladders a leg may be on: the ones with prices. */
  events: MarketEvent[];
  feeCoef: number;
  phase: Phase;
  readOnly: boolean;
  canRemove: boolean;
  /** Why the executor turned this leg down when the basket was placed, in plain words. */
  error: string | null;
  onKind: (kind: LegKind) => void;
  onMarket: (ticker: string) => void;
  onFirst: (symbol: string) => void;
  onSecond: (symbol: string) => void;
  onStake: (text: string) => void;
  onRemove: () => void;
  onStatus: (key: string, status: LegStatus) => void;
  /** Ask this leg to fetch its quote again, after the basket was refused. */
  reloadSignal: number;
}

const optionText = (r: Rung) =>
  `${money(r.strike)}${r.bid === null || r.ask === null ? ' · no price' : ''}`;

export default function BasketLeg(p: Props) {
  const { leg, index } = p;
  const event = p.events.find((e) => e.ticker === leg.event);
  const groups = useMemo(() => groupByAsset(p.events), [p.events]);
  const firsts = event ? firstOptions(event, leg.kind) : [];
  const seconds = event ? secondOptions(event, leg.kind, leg.a) : [];
  const ra = event?.rungs.find((r) => r.symbol === leg.a);
  const rb = event?.rungs.find((r) => r.symbol === leg.b);

  const quote = useLegQuote(leg);
  const { reload } = quote;
  // The venue's own cap on one bet, once it is known; until then the basket's default applies.
  const [maxStake] = useStakeCap();
  useEffect(() => {
    if (p.reloadSignal > 0) reload();
  }, [p.reloadSignal, reload]);

  const status = legStatus({
    kind: leg.kind,
    stake: leg.stake,
    phase: p.phase,
    readOnly: p.readOnly,
    a: ra,
    b: rb,
    answer: quote.answer,
    shown: quote.shown,
    answerError: quote.error,
    feeCoef: p.feeCoef,
    maxStake,
  });

  // The ticket and the button read every leg's status. Reported only when it changes, so the page does not loop.
  const { onStatus } = p;
  const signature = JSON.stringify(status);
  useEffect(() => {
    onStatus(leg.key, JSON.parse(signature) as LegStatus);
  }, [onStatus, leg.key, signature]);

  // A market that takes bets but is still opening gets a heads-up on the leg, until the basket is placed. It refuses
  // nothing: the leg's status and the basket's button are untouched by it.
  const opening = event && p.phase !== 'placed' ? openingNote(event) : null;

  const locked = p.phase !== 'idle';
  const id = `leg-${leg.key}`;
  const [l1, l2] = LEVELS[leg.kind];
  const notice = status.state.notice;
  const blocked =
    !status.state.canPlace &&
    status.state.blockedBy !== 'checking' &&
    status.state.blockedBy !== 'loading' &&
    status.state.blockedBy !== 'placing';

  return (
    <li
      className={`card leg${p.error ? ' is-refused' : ''}`}
      aria-labelledby={`${id}-title`}
    >
      <header className="leg-head">
        <h2 className="leg-title" id={`${id}-title`}>
          <span className="leg-num">Leg {index + 1}</span>
          <span className="leg-asset">
            {event ? assetLabel(event) : 'Choose a market'}
          </span>
        </h2>
        <button
          type="button"
          className="leg-remove"
          onClick={p.onRemove}
          disabled={!p.canRemove || locked}
          aria-label={`Remove leg ${index + 1}`}
        >
          Remove
        </button>
      </header>

      <div
        className="switch leg-kind"
        role="radiogroup"
        aria-label={`Leg ${index + 1} bet type`}
      >
        {KINDS.map((k) => (
          <button
            key={k.kind}
            type="button"
            role="radio"
            aria-checked={leg.kind === k.kind}
            aria-label={k.full}
            className={leg.kind === k.kind ? 'is-on' : ''}
            onClick={() => p.onKind(k.kind)}
            disabled={locked}
          >
            <span className="kind-long">{k.label}</span>
            <span className="kind-short">{k.short}</span>
          </button>
        ))}
      </div>

      <div className="leg-fields">
        <label className="leg-field leg-market">
          <span className="leg-label">Market</span>
          <span className="select">
            <select
              value={leg.event ?? ''}
              onChange={(e) => p.onMarket(e.target.value)}
              disabled={locked}
            >
              {!event && <option value="">Choose a market</option>}
              {groups.map((g) => (
                <optgroup key={g.key} label={g.label}>
                  {g.events.map((e) => (
                    <option key={e.ticker} value={e.ticker}>
                      {assetLabel(e)} · {closesLabel(e.expiry)}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </span>
        </label>
        <label className="leg-field">
          <span className="leg-label">{l1}</span>
          <span className="select">
            <select
              value={leg.a ?? ''}
              onChange={(e) => p.onFirst(e.target.value)}
              disabled={locked || !event}
            >
              {!ra && <option value="">…</option>}
              {firsts.map((r) => (
                <option key={r.symbol} value={r.symbol}>
                  {optionText(r)}
                </option>
              ))}
            </select>
          </span>
        </label>
        <label className="leg-field">
          <span className="leg-label">{l2}</span>
          <span className="select">
            <select
              value={leg.b ?? ''}
              onChange={(e) => p.onSecond(e.target.value)}
              disabled={locked || !event}
            >
              {!rb && <option value="">…</option>}
              {seconds.map((r) => (
                <option key={r.symbol} value={r.symbol}>
                  {optionText(r)}
                </option>
              ))}
            </select>
          </span>
        </label>
        <label className="leg-field leg-stake">
          <span className="leg-label">Stake</span>
          <span className="field">
            <span className="field-pre">$</span>
            <input
              inputMode="decimal"
              autoComplete="off"
              value={leg.stakeText}
              onChange={(e) => p.onStake(cleanStakeText(e.target.value))}
              disabled={locked}
              aria-describedby={`${id}-quote`}
            />
          </span>
        </label>
      </div>

      <div id={`${id}-quote`} className="leg-quote" aria-live="polite">
        {blocked && notice ? (
          <p className={`leg-refusal tone-${notice.tone}`}>{notice.text}</p>
        ) : (
          <dl className={`leg-nums${status.estimated ? ' is-est' : ''}`}>
            <div>
              <dt>{CHANCE[leg.kind]}</dt>
              <dd>{status.chanceWin !== null ? pct(status.chanceWin) : '–'}</dd>
            </div>
            {(leg.kind === 'up' || leg.kind === 'down') && (
              <div>
                <dt>Stake back</dt>
                <dd>
                  {status.chanceBack !== null ? pct(status.chanceBack) : '–'}
                </dd>
              </div>
            )}
            <div>
              <dt>You pay per $1</dt>
              <dd>
                {status.pricePaid !== null ? cents(status.pricePaid) : '–'}
              </dd>
            </div>
            {status.reducedTo !== null && (
              <div className="leg-reduced">
                <dt>Fills about</dt>
                <dd>{usd(status.reducedTo)}</dd>
              </div>
            )}
          </dl>
        )}
      </div>

      {/* The builders' caution, with the leg's own spacing for a note (`leg-error` only takes the note's margins off). */}
      {opening && <p className="note note-warn leg-error">{opening}</p>}

      {p.error && (
        <p className="note note-bad leg-error" role="alert">
          {p.error}
        </p>
      )}
    </li>
  );
}
