import type { RefObject } from 'react';
import { Link } from 'react-router-dom';
import { ApiError } from '../api/client';
import type { Bet, MarketEvent, PlaceBasketResponse } from '../api/types';
import { MIN_LEGS, restFrom, stripLegPrefix, kindOfLeg, type LegDraft } from '../lib/basket';
import { betPay, extremes, outcomeLine } from '../lib/basketPays';
import { betSentence, betTitle } from '../lib/betKind';
import { isUnconfirmed, unconfirmedWords } from '../lib/betsView';
import { usd, usdSigned } from '../lib/format';
import { friendly } from '../lib/friendly';
import { assetLabel } from '../lib/markets';
import { keepMode } from '../lib/venue';
import { kindLabel } from './BasketLeg';

export interface CallProgress {
  /** Placed bets whose call is being recorded. */
  total: number;
  done: number;
  failed: number;
  /** Calls refused for good because the market had closed by then: asking again cannot help, so they are counted apart. */
  late: number;
  /** The placed bets whose call could not be recorded, so they can be tried again. */
  failedIds: string[];
}

interface Props {
  result: PlaceBasketResponse;
  /** The legs as they were when the basket was placed, for the legs that have no bet. */
  legs: LegDraft[];
  events: MarketEvent[];
  calls: CallProgress;
  /** The heading, which the page scrolls to and focuses once the basket is placed. */
  headingRef: RefObject<HTMLHeadingElement>;
  onAgain: () => void;
  /** Reopen the form with the legs that were not placed, when a basket was placed in part and enough of them are left. */
  onRest: () => void;
  onRetryCalls: () => void;
}

type RowState = 'placed' | 'failed' | 'unprotected' | 'unconfirmed' | 'skipped';

const STATE_WORDS: Record<RowState, string> = {
  placed: 'Placed',
  failed: 'Not completed',
  // The first order is in and the second is not: the leg is open, and only half of it is placed.
  unprotected: 'Half placed',
  // An order was sent and nobody knows what became of it: the leg may be partly or fully in place.
  unconfirmed: 'Not confirmed',
  skipped: 'Not placed',
};

/**
 * What a placed basket turned into: one row per leg with what happened to it, what it cost and what it nets each way, then
 * the basket's own total. It leads to My bets, as a single bet's receipt does, because that is where the results arrive.
 */
export default function BasketResult({
  result,
  legs,
  events,
  calls,
  headingRef,
  onAgain,
  onRest,
  onRetryCalls,
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
          ? bet?.status === 'unhedged'
            ? isUnconfirmed(bet)
              ? 'unconfirmed'
              : 'unprotected'
            : 'failed'
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
  // The total is over the legs that were really placed, at what their orders filled for.
  const placedBets = rows.flatMap((r) =>
    r.state === 'placed' && r.bet ? [r.bet] : [],
  );
  // A leg whose first order is in and whose second is not has its money in too, so it is part of what was staked. It is not part
  // of the best and worst case, which are about legs that are fully in place.
  const unprotectedBets = rows.flatMap((r) => ((r.state === 'unprotected' || r.state === 'unconfirmed') && r.bet ? [r.bet] : []));
  const staked = [...placedBets, ...unprotectedBets].reduce((sum, b) => sum + b.cost, 0);
  const range = extremes(placedBets.map(betPay));
  const failedLeg = failed ? legs[failed.index] : undefined;
  // The reason is written for a bet that was refused whole, so its "Nothing was bought" and its advice about other levels are
  // not true here: the legs before it were bought. The banner says what happened to each leg.
  const unconfirmedLeg = rows.some((r) => r.i === failed?.index && r.state === 'unconfirmed');
  const reason = failed
    ? unconfirmedLeg
      ? unconfirmedWords()
      : stripLegPrefix(
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
                  basket: true,
                }
              : { basket: true },
          ),
        )
          .replace(/\s*Nothing was bought\./, '')
          .replace(/\s*(Pick other levels or check back shortly|Try other levels|Try again|Try again in a moment)\./, '')
          // The leg after it was not placed, and the banner says so: it is not a bet to be placed again from here.
          .replace(/\s*Check the new price and place the basket again\./, '')
          .trim()
    : null;
  const unplaced = failed ? basket.size - restFrom(result) : 0;

  return (
    <div className="basket-result">
      <div className="q-title">
        <h2 className="q-sentence" ref={headingRef} tabIndex={-1}>
          {!failed && <span className="done-mark" aria-hidden="true" />}
          {failed ? 'Basket placed in part' : 'Basket placed'}
        </h2>
        {basket.name && <p className="result-name">{basket.name}</p>}
      </div>

      {failed && (
        <div className="note note-bad" role="alert">
          <p>
            <b>{unconfirmedLeg ? `Leg ${failed.index + 1} is not confirmed.` : `Leg ${failed.index + 1} could not be completed.`}</b> {reason}
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
                      · {kindLabel(r.kind)} · {r.asset}
                    </span>
                  )}
                </span>
                <span className="row-bet">
                  {r.sentence || `Leg ${r.i + 1}`}
                </span>
                {r.bet && r.state === 'placed' && outcomeLine(r.bet) && (
                  <span className="row-pays">{outcomeLine(r.bet)}</span>
                )}
              </td>
              <td className="n">
                {r.bet && (r.state === 'placed' || r.state === 'unprotected' || (r.state === 'failed' && r.bet.cost > 0.004))
                  ? usd(Math.max(0, r.bet.cost))
                  : '–'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {placedBets.length + unprotectedBets.length > 0 && (
        <>
          <h3 className="sr-only">The basket in total</h3>
          <dl className="basket-totals">
            <div>
              <dt>Staked{failed ? `, ${placedBets.length + unprotectedBets.length} of ${basket.size} legs` : ''}</dt>
              <dd>{usd(staked)}</dd>
            </div>
            {range && (
              <>
                <div data-kind="win">
                  <dt>{range.everyWin ? 'Best case, every leg wins' : 'Best case'}</dt>
                  <dd>{usdSigned(range.best)}</dd>
                </div>
                <div data-kind="lose">
                  <dt>{range.everyLose ? 'Worst case, every leg loses' : 'Worst case'}</dt>
                  <dd>{usdSigned(range.worst)}</dd>
                </div>
              </>
            )}
          </dl>
        </>
      )}

      {calls.late > 0 && (
        <p className="fine basket-calls">
          {calls.late === 1
            ? 'One call could not be sealed, because its market had closed.'
            : `${calls.late} calls could not be sealed, because their markets had closed.`}
        </p>
      )}

      {calls.total > 0 && (
        <p className="fine basket-calls">
          {calls.done + calls.failed + calls.late < calls.total
            ? `Recording calls on Solana, ${calls.done} of ${calls.total}`
            : `Calls recorded ${calls.done} of ${calls.total}`}
          {calls.failed > 0 && (
            <>
              {'. '}
              {calls.failed === 1 ? 'One call' : `${calls.failed} calls`} could
              not be recorded.{' '}
              <button
                type="button"
                className="link-btn"
                onClick={onRetryCalls}
              >
                Try again
              </button>
            </>
          )}
        </p>
      )}

      {placedBets.length > 0 && (
        <p className="fine basket-next">
          Each result appears on My bets by itself when its market closes. You
          do not need to keep this page open.
        </p>
      )}

      <div className="basket-actions">
        <Link to={keepMode('/bets')} className="btn btn-primary">
          See my bets
        </Link>
        {failed && unplaced >= MIN_LEGS && (
          <button type="button" className="btn btn-ghost" onClick={onRest}>
            Place the rest again
          </button>
        )}
        <button type="button" className="btn btn-ghost" onClick={onAgain}>
          Make another
        </button>
      </div>
    </div>
  );
}
