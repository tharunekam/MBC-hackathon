import { useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import type { Bet, CallRecord, LegRecord } from '../api/types';
import { explorerTx } from '../api/types';
import { kindOf } from '../lib/betKind';
import { cents, timeLeft, trunc, usd, usdSigned } from '../lib/format';
import type { SealProblem } from '../lib/friendly';
import { landingOf, landingWords, orderHeading, rangeComesBack, receiptWords, sharesText, type OutcomeKind } from '../lib/receiptWords';
import { keepMode } from '../lib/venue';

interface Props {
  bet: Bet;
  call: CallRecord | null;
  /** Set when sealing the call failed: one plain sentence, and whether asking again could help. Whatever failed is never shown. */
  callError: SealProblem | null;
  /** Starts another bet of the same product. */
  onAgain: () => void;
  /** Tries to seal the call again, when it could not be sealed. */
  onRetryCall?: () => void;
}

/** The name each result goes by on every screen. */
const KIND_WORD: Record<OutcomeKind, string> = { win: 'Win', back: 'Stake back', lose: 'Lose' };

/** What one order bought, in a sentence: what it bets on, how many shares at what price, and what they pay if it comes true. */
function orderText(leg: LegRecord | undefined, bets: string): string {
  if (!leg) return `Bets ${bets}.`;
  const price = leg.avgPrice !== null && leg.avgPrice !== undefined ? cents(leg.avgPrice) : '–';
  return `Bets ${bets}: ${sharesText(leg.quantityFilled)} at ${price}, paying ${usd(leg.quantityFilled)} if it does.`;
}

/** The exchange's own number for an order, named so it is not read as the "Order 1" and "Order 2" counting. */
const exchangeId = (id: string) => `Exchange ID ${trunc(id, 6, 4)}`;

/** Whether an order filled in full. Only such an order may be called filled. */
const full = (leg: LegRecord | undefined): boolean => !!leg && leg.quantityFilled > 0 && leg.quantityFilled + 1e-9 >= leg.quantityRequested;

/** What an order that did not fill in full says, in place of the sentence about what it bought and what it pays. */
function unfilledText(leg: LegRecord | undefined, bets: string): string {
  if (!leg || !(leg.quantityFilled > 0)) return `Bets ${bets}, but nothing went through.`;
  return `${orderText(leg, bets)} Only part of it went through.`;
}

/**
 * What a placed bet turned into: what was paid, the two filled orders, the call sealed on Solana, and what each result pays.
 * The executor answers a placement with a bet in whatever state it ended in, so a bet that is not fully in place (only the
 * first order filled, the first order sold back, or nothing bought) is told as that, with no "Bet placed" and no filled order
 * that did not fill, and no call is sealed for it.
 */
export default function Receipt({ bet, call, callError, onAgain, onRetryCall }: Props) {
  const [first, second] = [bet.legs.find((l) => l.role === 'outcome'), bet.legs.find((l) => l.role === 'hedge')];
  const words = receiptWords(bet);
  const landing = landingOf(bet);
  const said = landingWords(bet);
  // A bet that is fully placed keeps its fixed words for both orders. Otherwise each order is judged on what it really filled.
  const filled = (leg: LegRecord | undefined) => landing === 'placed' || full(leg);
  const range = kindOf(bet).product === 'range';
  // A bare "Closed. The result appears…" read as if something had gone wrong with the bet. It is the market that has closed.
  const left = timeLeft(bet.expiry);
  const closes = left === 'Closed' ? 'This market has closed' : (left ?? 'The market closes soon');

  // The Place bet button that was just used is gone from the page, so focus would fall to the top of the document. It goes to the
  // receipt's heading instead, and the receipt is brought into view if the person had scrolled past where it opens (on a phone,
  // the button is below the receipt's top). The sticky header takes the top 76px.
  const root = useRef<HTMLDivElement>(null);
  const title = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    title.current?.focus({ preventScroll: true });
    const top = root.current?.getBoundingClientRect().top ?? 76;
    if (top < 76 || top > window.innerHeight * 0.6) window.scrollBy({ top: top - 76 });
  }, []);

  return (
    <div className="receipt" ref={root}>
      <div className="q-title">
        <span className="eyebrow">{said.eyebrow}</span>
        <h2 className="q-sentence" ref={title} tabIndex={-1}>
          {words.title}
        </h2>
      </div>

      {landing !== 'placed' && (
        <div className={`note ${landing === 'unprotected' ? 'note-warn' : landing === 'unconfirmed' ? 'note-info' : 'note-bad'}`}>
          {said.lines.map((line, i) => (
            <p key={i}>{i === 0 && landing === 'unprotected' ? <b>{line}</b> : line}</p>
          ))}
        </div>
      )}

      {said.paidLabel && (
        <p className="receipt-paid">
          <span>{said.paidLabel}</span>
          <b>{usd(landing === 'unwound' ? Math.max(0, bet.cost) : bet.cost)}</b>
        </p>
      )}

      {landing === 'placed' && bet.stakeReduced && (
        <p className="note note-info">
          The market could cover only part of your {usd(bet.stakeReduced.requested)} stake at this price, so the bet is {usd(bet.cost)}. The figures below are for that size.
        </p>
      )}

      {(landing === 'placed' || landing === 'unprotected') && (
        <ol className="steps">
          <li className={filled(first) ? 'is-done' : 'is-fail'}>
            <span className="dot" aria-hidden="true" />
            <div>
              <div className="step-head">
                <b>{landing === 'placed' ? 'Order 1 went through' : orderHeading(1, first)}</b>
                {first?.orderId && (
                  <code className="mono-chip" title="The exchange’s own ID for this order">
                    {exchangeId(first.orderId)}
                  </code>
                )}
              </div>
              <p>{filled(first) ? orderText(first, words.first) : unfilledText(first, words.first)}</p>
            </div>
          </li>
          <li className={filled(second) ? 'is-done' : 'is-fail'}>
            <span className="dot" aria-hidden="true" />
            <div>
              <div className="step-head">
                <b>{landing === 'placed' ? 'Order 2 went through' : orderHeading(2, second)}</b>
                {second?.orderId && (
                  <code className="mono-chip" title="The exchange’s own ID for this order">
                    {exchangeId(second.orderId)}
                  </code>
                )}
              </div>
              <p>{filled(second) ? `${orderText(second, words.second)} ${words.secondWhy}` : unfilledText(second, words.second)}</p>
            </div>
          </li>
          {landing === 'placed' && (
            <li className={call ? 'is-done' : callError ? 'is-fail' : 'is-active'}>
              <span className="dot" aria-hidden="true" />
              <div>
                <b>{call ? 'Call recorded on Solana' : callError ? 'Could not record the call' : 'Recording your call on Solana'}</b>
                <p>{callError ? callError.text : 'It is sealed with a code, not the details, so you can prove later that you made it first.'}</p>
                {callError && !callError.final && onRetryCall && (
                  <button type="button" className="btn btn-ghost btn-sm" onClick={onRetryCall}>
                    Try again
                  </button>
                )}
                {call &&
                  (call.network === 'devnet' ? (
                    <a className="mono-chip link" href={explorerTx(call.commitSignature)} target="_blank" rel="noreferrer">
                      {trunc(call.commitSignature, 8, 6)} ↗
                    </a>
                  ) : (
                    <code className="mono-chip">{trunc(call.commitSignature, 8, 6)}</code>
                  ))}
              </div>
            </li>
          )}
        </ol>
      )}

      {landing === 'placed' && (
        <>
          <ul className="outcomes">
            {words.outcomes.map((o) => (
              <li key={o.kind} data-kind={o.kind}>
                <em className="kind">{KIND_WORD[o.kind]}</em>
                <span>{o.label}</span>
                {/* What each result nets, in dollars. The name of the result is the column before, so a returned stake reads as the $0.00 it
                    nets, not as "Stake back" a second time. */}
                <b>{usdSigned(o.kind === 'back' ? 0 : o.kind === 'win' ? (bet.payoffs?.ifBothHit ?? 0) : (bet.payoffs?.ifConditionOnly ?? -bet.cost))}</b>
              </li>
            ))}
          </ul>
          {range && <p className="fine">{rangeComesBack(usd(Math.min(first?.quantityFilled ?? 0, second?.quantityFilled ?? 0)), usd(bet.cost))}</p>}

          <p className="fine next-step">
            {closes}. The result appears on My bets by itself, and you do not need to keep this page open.
          </p>
        </>
      )}

      <div className="row-actions">
        {landing === 'placed' ? (
          <>
            <Link className="btn btn-primary" to={keepMode('/bets')}>
              See my bets
            </Link>
            <button type="button" className="btn btn-ghost" onClick={onAgain}>
              Make another
            </button>
          </>
        ) : landing === 'failed' || landing === 'unwound' ? (
          <>
            <button type="button" className="btn btn-primary" onClick={onAgain}>
              Try again
            </button>
            {landing === 'unwound' && (
              <Link className="btn btn-ghost" to={keepMode('/bets')}>
                See my bets
              </Link>
            )}
          </>
        ) : (
          <>
            <Link className="btn btn-primary" to={keepMode('/bets')}>
              {landing === 'unprotected' ? 'Sell it back in My bets' : 'See my bets'}
            </Link>
            <button type="button" className="btn btn-ghost" onClick={onAgain}>
              Make another
            </button>
          </>
        )}
      </div>
    </div>
  );
}
