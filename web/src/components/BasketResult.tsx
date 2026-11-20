import { Link } from 'react-router-dom';
import { ApiError } from '../api/client';
import type { Bet, MarketEvent, PlaceBasketResponse } from '../api/types';
import { stripLegPrefix, kindOfLeg, type LegDraft } from '../lib/basket';
import { betSentence, betTitle, productName } from '../lib/betKind';
import { usd } from '../lib/format';
import { friendly } from '../lib/friendly';
import { assetLabel } from '../lib/markets';

export interface CallProgress {
  /** Placed bets whose call is being recorded. */
  total: number;
  done: number;
  failed: number;
  error: string | null;
}

interface Props {
  result: PlaceBasketResponse;
  /** The legs as they were when the basket was placed, for the legs that have no bet. */
  legs: LegDraft[];
  events: MarketEvent[];
  calls: CallProgress;
  onAgain: () => void;
}

type RowState = 'placed' | 'failed' | 'skipped';

const STATE_WORDS: Record<RowState, string> = {
  placed: 'Placed',
  failed: 'Not completed',
  skipped: 'Not placed',
};

/** What a placed basket turned into: one row per leg, what happened to it, and what it cost. */
export default function BasketResult({
  result,
  legs,
  events,
  calls,
  onAgain,
}: Props) {
  const { basket } = result;
  const failed = basket.failed;
  const betAt = (i: number): Bet | undefined =>
    result.bets.find((b) => b.basket?.index === i) ??
    (result.bets.every((b) => !b.basket) ? result.bets[i] : undefined);

  const rows = Array.from({ length: basket.size }, (_, i) => {
    const bet = betAt(i);
    const leg = legs[i];
    const state: RowState =
      failed && i > failed.index
        ? 'skipped'
        : failed && i === failed.index
          ? 'failed'
          : bet
            ? 'placed'
            : 'skipped';
    const ev = events.find(
      (e) => e.ticker === (bet?.eventTicker ?? leg?.event),
    );
    const strikes = (sym: string | null) =>
      ev?.rungs.find((r) => r.symbol === sym)?.strike;
    const kind = bet
      ? { product: bet.product ?? 'parlay', direction: bet.direction ?? 'up' }
      : leg
        ? kindOfLeg(leg.kind)
        : null;
    const sentence = bet
      ? betTitle(bet)
      : leg &&
          kind &&
          strikes(leg.a) !== undefined &&
          strikes(leg.b) !== undefined
        ? betSentence(kind, {
            condition: strikes(leg.a)!,
            target: strikes(leg.b)!,
          })
        : '';
    return {
      i,
      bet,
      state,
      sentence,
      kind,
      asset: ev ? assetLabel(ev) : (bet?.eventTitle ?? ''),
    };
  });

  const placed = rows.filter((r) => r.state === 'placed').length;
  const failedLeg = failed ? legs[failed.index] : undefined;
  const reason = failed
    ? stripLegPrefix(
        friendly(
          new ApiError(
            422,
            { error: failed.message, code: failed.code },
            failed.message,
          ),
          failedLeg
            ? {
                product: kindOfLeg(failedLeg.kind).product,
                direction: kindOfLeg(failedLeg.kind).direction,
              }
            : {},
        ),
      )
    : null;

  return (
    <div className="basket-result">
      <div className="q-title">
        <span className="eyebrow">
          {failed ? 'Basket placed in part' : 'Basket placed'}
        </span>
        <h2 className="q-sentence">{basket.name ?? 'Basket'}</h2>
      </div>

      {failed && (
        <div className="note note-bad" role="alert">
          <p>
            <b>Leg {failed.index + 1} could not be completed.</b> {reason}
          </p>
          <p>
            {placed === 0
              ? 'No leg before it was placed.'
              : placed === 1
                ? 'Leg 1 is placed and listed on My bets.'
                : `The ${placed} legs before it are placed and listed on My bets.`}{' '}
            {failed.index < basket.size - 1
              ? `Nothing after leg ${failed.index + 1} was placed.`
              : ''}
          </p>
        </div>
      )}

      <table className="scen basket-rows">
        <caption className="sr-only">What happened to each leg</caption>
        <thead>
          <tr>
            <th scope="col">Leg</th>
            <th scope="col" className="n">
              Cost
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.i} data-state={r.state}>
              <td>
                <span className="row-meta">
                  <span className="row-state">{STATE_WORDS[r.state]}</span>
                  {r.kind && (
                    <span>
                      {' '}
                      · {productName(r.kind)} · {r.asset}
                    </span>
                  )}
                </span>
                <span className="row-bet">
                  {r.sentence || `Leg ${r.i + 1}`}
                </span>
              </td>
              <td className="n">
                {r.bet && r.state === 'placed' ? usd(r.bet.cost) : '–'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {calls.total > 0 && (
        <p className="fine basket-calls">
          {calls.done + calls.failed < calls.total
            ? `Recording calls on Solana, ${calls.done} of ${calls.total}`
            : `Calls recorded ${calls.done} of ${calls.total}`}
          {calls.failed > 0 && calls.error
            ? `. ${calls.failed === 1 ? 'One' : calls.failed} could not be recorded: ${calls.error}`
            : ''}
        </p>
      )}

      <div className="basket-actions">
        <Link to="/bets" className="btn btn-ghost">
          See my bets
        </Link>
        <button type="button" className="btn btn-primary" onClick={onAgain}>
          Make another
        </button>
      </div>
    </div>
  );
}
