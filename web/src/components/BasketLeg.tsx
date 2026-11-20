import { useEffect, useMemo } from 'react';
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
import { assetLabel, closesLabel, groupByAsset } from '../lib/markets';

const KINDS: { kind: LegKind; label: string; full: string }[] = [
  { kind: 'up', label: 'Parlay up', full: 'Return Parlay, rising' },
  { kind: 'down', label: 'Parlay down', full: 'Return Parlay, falling' },
  { kind: 'range', label: 'Range', full: 'Range' },
];

/** The names of the two levels, by kind of leg. */
const LEVELS: Record<LegKind, [string, string]> = {
  up: ['Given at or above', 'Reach'],
  down: ['Given below', 'Fall below'],
  range: ['Floor', 'Ceiling'],
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
              value={leg.stakeText}
              onChange={(e) => p.onStake(e.target.value.replace(/[^\d.]/g, ''))}
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
              <dt>
                {leg.kind === 'range' ? 'Chance inside' : 'Chance to win'}
              </dt>
              <dd>{status.chanceWin !== null ? pct(status.chanceWin) : '–'}</dd>
            </div>
            {leg.kind !== 'range' && (
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

      {p.error && (
        <p className="note note-bad leg-error" role="alert">
          {p.error}
        </p>
      )}
    </li>
  );
}
