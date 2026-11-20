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
import type { BetKind } from '../lib/betKind';
import { cents, money, pct, usd } from '../lib/format';
import { useDebounced, useResource } from '../lib/hooks';
import { execLive } from '../lib/liveClients';
import { assetLabel, closesLabel, groupByAsset } from '../lib/markets';
import { rovingKeys, rovingTab } from '../lib/roving';
import { cleanStakeText } from '../lib/stake';

/**
 * The four kinds of leg, named the way the rest of the app names them: the label on the switch is the same words as the
 * ticket, the result and My bets use. On a phone the four sit in two rows, so no short names are needed.
 */
const KINDS: { kind: LegKind; label: string }[] = [
  { kind: 'up', label: 'Stake Back up' },
  { kind: 'down', label: 'Stake Back down' },
  { kind: 'range', label: 'Range' },
  { kind: 'breakout', label: 'Breakout' },
];

/** What a bet is called wherever a person reads it: Stake Back goes up or down, a Range and a Breakout are one thing each. */
export const kindLabel = (kind: BetKind): string =>
  kind.product === 'range'
    ? 'Range'
    : kind.product === 'breakout'
      ? 'Breakout'
      : kind.direction === 'down'
        ? 'Stake Back down'
        : 'Stake Back up';

/**
 * The names of the two levels, by kind of leg: a Stake Back has a first level and a target, the others a lower and a higher level.
 * Which way a Stake Back goes is on the leg's bet-type switch above them, so the names do not repeat it.
 */
const LEVELS: Record<LegKind, [string, string]> = {
  up: ['First level', 'Target'],
  down: ['First level', 'Target'],
  range: ['Lower level', 'Higher level'],
  breakout: ['Lower level', 'Higher level'],
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
  /** The markets a leg may be on: the ones with prices. */
  events: MarketEvent[];
  feeCoef: number;
  phase: Phase;
  readOnly: boolean;
  canRemove: boolean;
  /** The id of the line that says a basket needs at least two legs, so a Remove that is switched off can point at it. */
  minNoteId: string;
  /** The number of an earlier leg that is exactly this bet, when there is one. */
  sameAs: number | null;
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

/** The id of a leg's heading, which the page moves focus to when the leg before it is removed. */
export const legTitleId = (key: string): string => `leg-${key}-title`;

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

  const locked = p.phase !== 'idle';
  const id = `leg-${leg.key}`;
  const [l1, l2] = LEVELS[leg.kind];
  const notice = status.state.notice;
  const blocked =
    p.phase === 'idle' &&
    !status.state.canPlace &&
    status.state.blockedBy !== 'checking' &&
    status.state.blockedBy !== 'loading' &&
    status.state.blockedBy !== 'placing';
  const overCap = status.state.blockedBy === 'stake';

  // The two figures the executor's answer carries and the status does not. Both are the answer's own, so they are "–" until
  // there is one. A range's fair price is its chance, so a value of 1 or more is a missing one.
  const answered = quote.shown?.quote ?? null;
  const fair =
    answered?.fairPrice != null && answered.fairPrice < 1
      ? answered.fairPrice
      : null;
  const sellBack = answered?.cashOutPer100 ?? null;

  // A radio group: only the chosen kind is a Tab stop, and the arrow keys move the choice and the focus together.
  const chosenKind = KINDS.findIndex((k) => k.kind === leg.kind);

  return (
    <li className={`card leg${p.error ? ' is-refused' : ''}`}>
      <header className="leg-head">
        <h2 className="leg-title" id={legTitleId(leg.key)} tabIndex={-1}>
          <span className="leg-num">Leg {index + 1}</span>{' '}
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
          aria-describedby={!p.canRemove ? p.minNoteId : undefined}
          title={!p.canRemove ? 'A basket needs at least 2 legs' : undefined}
        >
          Remove
        </button>
      </header>

      <div
        className="switch leg-kind"
        role="radiogroup"
        aria-label={`Leg ${index + 1} bet type`}
        onKeyDown={(e) => rovingKeys(e, { choose: true })}
      >
        {KINDS.map((k, at) => (
          <button
            key={k.kind}
            type="button"
            role="radio"
            aria-checked={leg.kind === k.kind}
            tabIndex={rovingTab(at, chosenKind)}
            className={leg.kind === k.kind ? 'is-on' : ''}
            onClick={() => p.onKind(k.kind)}
            disabled={locked}
          >
            {k.label}
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
              {!ra && <option value="">–</option>}
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
              {!rb && <option value="">–</option>}
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
            {/* Outside the label's name: the field is "Stake", as on the other builders, not "Stake $". */}
            <span className="field-pre" aria-hidden="true">
              $
            </span>
            <input type="text"
              inputMode="decimal"
              autoComplete="off"
              value={leg.stakeText}
              onChange={(e) => p.onStake(cleanStakeText(e.target.value))}
              disabled={locked}
              aria-invalid={overCap || undefined}
              aria-describedby={`${id}-quote`}
            />
          </span>
        </label>
      </div>

      {/* Not a live region: a price that ticks or a stake being typed would be read out again and again. */}
      <div id={`${id}-quote`} className="leg-quote">
        {blocked && notice ? (
          <p className={`leg-refusal tone-${notice.tone}`}>{notice.text}</p>
        ) : (
          <dl className={`leg-nums${status.estimated ? ' is-est' : ''}`}>
            <div>
              <dt>Chance of winning</dt>
              <dd>{status.chanceWin !== null ? pct(status.chanceWin) : '–'}</dd>
            </div>
            {(leg.kind === 'up' || leg.kind === 'down') && (
              <div>
                <dt>Chance of stake back</dt>
                <dd>
                  {status.chanceBack !== null ? pct(status.chanceBack) : '–'}
                </dd>
              </div>
            )}
            <div>
              <dt>Fair price per $1</dt>
              <dd>{fair !== null ? cents(fair) : '–'}</dd>
            </div>
            <div>
              <dt>You pay per $1</dt>
              {status.pricePaid !== null ? (
                <dd>{cents(status.pricePaid)}</dd>
              ) : (
                <dd className="is-none">No price yet</dd>
              )}
            </div>
            <div>
              <dt>Sell back now per $100</dt>
              <dd>{sellBack !== null ? usd(sellBack, 0) : '–'}</dd>
            </div>
            {status.reducedTo !== null && (
              <div className="leg-reduced">
                <dt>Likely stake</dt>
                <dd>{usd(status.reducedTo)}</dd>
              </div>
            )}
          </dl>
        )}
      </div>

      {p.sameAs !== null && !p.error && (
        <p className="note note-warn leg-error">Same bet as leg {p.sameAs}.</p>
      )}
      {p.error && (
        <p className="note note-bad leg-error" role="alert">
          {p.error}
        </p>
      )}
    </li>
  );
}
