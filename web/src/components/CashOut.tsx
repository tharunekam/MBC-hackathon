import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { ApiError } from '../api/client';
import type { Bet, CashOutCode, CashOutQuote } from '../api/types';
import { betTitle, kindOf } from '../lib/betKind';
import { usd } from '../lib/format';
import { friendly } from '../lib/friendly';
import '../styles/cashout.css';

/** The sentence under a live price: what selling now makes or loses against what the bet cost. */
export function cashOutWords(q: Pick<CashOutQuote, 'proceeds' | 'stake'>): string {
  if (q.proceeds === null) return '';
  const diff = q.proceeds - q.stake;
  if (diff > 0.004) return `${usd(diff)} more than it cost.`;
  if (diff < -0.004) return `${usd(-diff)} less than it cost.`;
  return 'The same as it cost.';
}

/**
 * Why a bet cannot be sold right now, by the executor's code. The executor sends a sentence of its own with each, but those
 * name contracts and order states; these say the same thing to the person holding the bet, and that nothing was sold.
 */
const REFUSALS: Record<CashOutCode, string> = {
  not_open: 'This bet is no longer open, so there is nothing to sell.',
  market_closed: 'This market is not taking orders right now, so the bet cannot be sold. If the market has finished, the result arrives by itself.',
  no_bid: 'We could not find a buyer for this bet just now, so it cannot be sold. Try again in a moment.',
  insufficient_depth: 'There are not enough buyers at the best price to sell the whole bet right now. Try again in a moment.',
  position_netted: 'Another open bet of yours uses the same prices, so this one cannot be sold on its own. It pays out when the market closes.',
  below_minimum: 'The price moved, so nothing was sold. Check the price again.',
  // Only for a sale that definitely sold nothing. A sale with no confirmed result has a code and a sentence of its own.
  nothing_sold: 'The price moved before the order arrived, so nothing was sold. Your bet is unchanged.',
  sale_unconfirmed: 'We could not confirm whether this sold. Check My bets and your Gemini account before trying again.',
};

/**
 * Refusals that no amount of waiting changes: asking again would only get the same answer, so no button offers it. A sale that
 * may have gone through is one of them: selling again could sell what is already sold.
 */
const PERMANENT: ReadonlySet<string> = new Set<CashOutCode>(['not_open', 'position_netted', 'sale_unconfirmed']);

const isRefusal = (code: string | null | undefined): code is CashOutCode => typeof code === 'string' && code in REFUSALS;

/** What a quote that cannot be sold says. */
export function cashOutRefusal(q: Pick<CashOutQuote, 'code'>): string {
  return isRefusal(q.code) ? REFUSALS[q.code] : 'This bet cannot be sold right now.';
}

/** True when asking for the price again cannot change the answer. */
export const cashOutIsFinal = (q: Pick<CashOutQuote, 'code'>): boolean => typeof q.code === 'string' && PERMANENT.has(q.code);

/**
 * What a failed cash-out says. `doing` matters when the server did not answer: a price that could not be read sold nothing,
 * but a sale that got no answer may have gone through, and the words must not say otherwise.
 */
export function cashOutProblem(err: unknown, doing: 'pricing' | 'selling'): string {
  if (err instanceof ApiError) {
    if (isRefusal(err.code)) return REFUSALS[err.code];
    if (err.code === 'paused') return 'Selling is paused for a moment. Nothing was sold. Try again soon.';
    if (err.code === 'read_only') return 'Bets are switched off here, so there is nothing to sell.';
    if (err.code === 'unknown_bet') return 'We could not find this bet. Reload the page and try again.';
    // A server that does not know cash-out at all, such as an older one still running.
    if (err.status === 404) return 'Cash out is not available on this server right now. Your bet is unchanged.';
    if (err.status === 0 || err.status >= 500) {
      return doing === 'selling' ? 'We could not confirm the sale. Check this bet again in a moment before you try again.' : 'We could not read the price just now. Nothing was sold. Try again in a moment.';
    }
  }
  // Any other refusal is worded for a bet being placed ("We could not place that bet"), which is not what happened here, and the
  // executor's own sentence is never shown: the sale did not go through, and nothing was sold.
  if (err instanceof ApiError && err.status > 0 && err.status < 500 && err.status !== 429) {
    return doing === 'selling' ? 'The sale did not go through. Nothing was sold. Try again in a moment.' : 'We could not read the price just now. Nothing was sold. Try again in a moment.';
  }
  return friendly(err);
}

/**
 * What selling means, said once before the second step. A Stake Back bet gives up its stake back as well as its win; a Range
 * or a Breakout has no stake back to give up. The call stays sealed on Solana whatever happens to the bet.
 */
export function sellingMeans(bet: Pick<Bet, 'product' | 'direction'>, quote: Pick<CashOutQuote, 'legs'>): string {
  const orders = quote.legs.filter((l) => l.quantity > 0).length;
  const givesUp = kindOf(bet).product === 'parlay' && orders !== 1 ? 'the win and the stake back' : 'what the bet could still pay';
  return `You give up ${givesUp}. Your call can still be revealed.`;
}

/** The quote a refusal was refused on, when the executor sent one. */
const quoteOn = (err: unknown): CashOutQuote | null => (err instanceof ApiError ? ((err.body as { quote?: CashOutQuote | null } | null)?.quote ?? null) : null);

type Step = 'idle' | 'pricing' | 'priced' | 'selling' | 'sold' | 'unconfirmed';

/**
 * On an open bet: sell it back before the market closes. Two steps on purpose. The first reads the live price and sends
 * nothing; the second sells for that figure or more, or not at all, so the figure on the button is the least the sale brings in.
 *
 * The buttons sit in the row's bottom bar (bets.css); the price and what it means open on a line of their own beneath them.
 * `onDone` says what happened in a sentence and whether the whole bet was sold.
 */
export function CashOut({
  bet,
  onDone,
  onUnconfirmed,
}: {
  bet: Bet;
  onDone: (message: string, complete: boolean) => void;
  /** The sale may have gone through: says so in a sentence, and the list should be read again to show what became of the bet. */
  onUnconfirmed?: (message: string) => void;
}) {
  const [step, setStep] = useState<Step>('idle');
  const [quote, setQuote] = useState<CashOutQuote | null>(null);
  const [error, setError] = useState<string | null>(null);
  // True when the price on show replaced one the sale was refused at.
  const [moved, setMoved] = useState(false);
  const [soldFor, setSoldFor] = useState<number | null>(null);
  const statusRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  // Where keyboard focus goes once the step has changed. Pressing a button removes it, and focus must not fall to the page.
  const focusNext = useRef<'status' | 'button' | null>(null);
  // True while a request of this row is out: the buttons are disabled once the page has drawn, but several clicks that arrive
  // in one task (assistive input) all run before it does, and each would send its own request.
  const inflight = useRef(false);
  const title = betTitle(bet);

  useEffect(() => {
    const want = focusNext.current;
    if (!want) return;
    focusNext.current = null;
    const el = want === 'status' ? statusRef.current : buttonRef.current;
    el?.focus({ preventScroll: true });
    el?.scrollIntoView({ block: 'nearest' });
  }, [step, quote, error]);

  function reset() {
    setStep('idle');
    setQuote(null);
    setMoved(false);
  }

  async function price() {
    if (inflight.current) return;
    inflight.current = true;
    setStep('pricing');
    setError(null);
    setMoved(false);
    try {
      const q = await api.cashOutQuote(bet.id);
      focusNext.current = 'status';
      setQuote(q);
      setStep('priced');
    } catch (e) {
      focusNext.current = 'button';
      setError(cashOutProblem(e, 'pricing'));
      reset();
    } finally {
      inflight.current = false;
    }
  }

  async function sell() {
    if (!quote || quote.proceeds === null || inflight.current) return;
    inflight.current = true;
    setStep('selling');
    setError(null);
    try {
      // The floor is the figure on the button. With a floor the executor sells at the prices it quoted or better.
      const done = await api.cashOut(bet.id, quote.proceeds);
      if (done.cashOut.complete) {
        // The list reloads and this row comes back without a cash-out; until then it says what happened and offers nothing.
        focusNext.current = 'status';
        setSoldFor(done.cashOut.proceeds);
        setQuote(null);
        setStep('sold');
        onDone(`Sold for ${usd(done.cashOut.proceeds)}.`, true);
      } else {
        // Part of it sold: the bet is still open with what is left, so the row goes back to where it can be priced again.
        reset();
        focusNext.current = 'button';
        onDone(`Part of this bet was sold, for ${usd(done.cashOut.proceeds)} so far. The rest is still open and can be cashed out again.`, false);
      }
    } catch (e) {
      // The sale may have gone through. Say that, offer nothing (a second sale could sell what is already sold), and have the
      // list read again: the bet comes back saying it is not confirmed, and its Cash out button is gone.
      if (e instanceof ApiError && e.code === 'sale_unconfirmed') {
        const said = REFUSALS.sale_unconfirmed;
        focusNext.current = 'status';
        setError(said);
        setQuote(null);
        setStep('unconfirmed');
        onUnconfirmed?.(said);
        return;
      }
      // A sale refused on its price comes back with the price as it is now (demo data sends none, so it is read again).
      // That price goes on the button, so the figure shown is never a stale one.
      const fresh = quoteOn(e) ?? (e instanceof ApiError && e.code === 'below_minimum' ? await api.cashOutQuote(bet.id).catch(() => null) : null);
      const priceMoved = e instanceof ApiError && e.code === 'below_minimum';
      if (fresh && (priceMoved || !fresh.available)) {
        focusNext.current = 'status';
        setQuote(fresh);
        setMoved(priceMoved);
        setStep('priced');
        return;
      }
      setError(cashOutProblem(e, 'selling'));
      focusNext.current = 'button';
      reset();
    } finally {
      inflight.current = false;
    }
  }

  const busy = step === 'pricing' || step === 'selling';
  const checkLabel = step === 'pricing' ? 'Reading the price' : step === 'priced' ? 'Check again' : 'Cash out';
  const priced = step === 'priced' || step === 'selling';
  // The price that can be sold at, when there is one: the same figure goes in the sentence and on the button.
  const offer = priced && quote !== null && quote.available && quote.proceeds !== null ? { quote, proceeds: quote.proceeds } : null;
  // A refusal that waiting cannot change is said once and no button offers to ask again.
  const final = priced && quote !== null && !offer && cashOutIsFinal(quote);

  return (
    <div className="bl-cash" data-cashout={step}>
      {/* Always in the page, empty while there is nothing to say, so a screen reader hears each change. */}
      <div className="bl-cash-say" ref={statusRef} tabIndex={-1} role={error || (moved && offer) ? 'alert' : 'status'}>
        {error ? (
          <p>{error}</p>
        ) : step === 'sold' && soldFor !== null ? (
          <p className="bl-cash-price">Sold for {usd(soldFor)}</p>
        ) : offer ? (
          <>
            <p className="bl-cash-price">
              {moved ? 'The price moved. It now sells for ' : 'Sells for '}
              <b>{usd(offer.proceeds)}</b>
              {moved ? '' : ' now'}
            </p>
            <p>
              {cashOutWords(offer.quote)} {sellingMeans(bet, offer.quote)}
            </p>
          </>
        ) : priced && quote ? (
          <p>{cashOutRefusal(quote)}</p>
        ) : null}
      </div>
      {step !== 'sold' && step !== 'unconfirmed' && !final && (
        <div className="bl-cash-actions">
          {offer ? (
            <>
              <button
                type="button"
                className="btn btn-ghost bl-btn"
                disabled={busy}
                aria-label={`Keep the bet, ${title}`}
                onClick={() => {
                  setError(null);
                  focusNext.current = 'button';
                  reset();
                }}
              >
                Keep the bet
              </button>
              <button type="button" className="btn btn-primary bl-btn" disabled={busy} onClick={sell} aria-label={`Sell for ${usd(offer.proceeds)}, ${title}`}>
                {step === 'selling' ? 'Selling' : `Sell for ${usd(offer.proceeds)}`}
              </button>
            </>
          ) : (
            <button
              ref={buttonRef}
              type="button"
              className="btn btn-ghost bl-btn"
              disabled={busy}
              onClick={price}
              title={step === 'idle' ? 'See the price before you sell' : undefined}
              aria-label={`${checkLabel}, ${title}`}
            >
              {checkLabel}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
