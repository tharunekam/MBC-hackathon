import { useId, useState } from 'react';
import { api } from '../api';
import { ApiError } from '../api/client';
import type { Bet, CashOutCode, CashOutQuote } from '../api/types';
import { kindOf } from '../lib/betKind';
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
  market_closed: 'This market is not taking orders right now, so the bet cannot be sold. If the market has finished, the bet settles by itself.',
  no_bid: 'We could not find a buyer for this bet just now, so it cannot be sold. Try again in a moment.',
  insufficient_depth: 'There are not enough buyers at the best price to sell the whole bet right now. Try again in a moment.',
  position_netted: 'Another open bet of yours holds the other side of one of these contracts, and the exchange has already paid out that overlap. This bet cannot be sold by itself. It settles as usual.',
  below_minimum: 'The price moved, so nothing was sold. Check the price again.',
  nothing_sold: 'The price moved before the order arrived, so nothing was sold. Your bet is unchanged.',
};

const isRefusal = (code: string | null | undefined): code is CashOutCode => typeof code === 'string' && code in REFUSALS;

/** What a quote that cannot be sold says. */
export function cashOutRefusal(q: Pick<CashOutQuote, 'code'>): string {
  return isRefusal(q.code) ? REFUSALS[q.code] : 'This bet cannot be sold right now.';
}

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
  return friendly(err);
}

/**
 * What selling means, said once before the second step. A parlay gives up its refund as well as its win; a range or a
 * breakout has no refund to give up. The call stays sealed on Solana whatever happens to the bet.
 */
export function sellingMeans(bet: Pick<Bet, 'product' | 'direction'>, quote: Pick<CashOutQuote, 'legs'>): string {
  const orders = quote.legs.filter((l) => l.quantity > 0).length;
  const sends = orders === 1 ? 'one sell order at the price on offer now' : 'two sell orders at the prices on offer now';
  const givesUp = kindOf(bet).product === 'parlay' && orders !== 1 ? 'both the win and the stake coming back' : 'what the bet could still pay';
  return `Selling sends ${sends}: you give up ${givesUp}, and the call you made can still be revealed once the market settles.`;
}

/** The quote a refusal was refused on, when the executor sent one. */
const quoteOn = (err: unknown): CashOutQuote | null => (err instanceof ApiError ? ((err.body as { quote?: CashOutQuote | null } | null)?.quote ?? null) : null);

type Step = 'idle' | 'pricing' | 'priced' | 'selling' | 'sold';

/**
 * On an open bet: sell it back before the market settles. Two steps on purpose. The first reads the live price and sends
 * nothing; the second sells for that figure or more, or not at all, so the figure on the button is the least the sale brings in.
 */
export function CashOut({ bet, onDone }: { bet: Bet; onDone: (message: string) => void }) {
  const [step, setStep] = useState<Step>('idle');
  const [quote, setQuote] = useState<CashOutQuote | null>(null);
  const [error, setError] = useState<string | null>(null);
  // True when the price on show replaced one the sale was refused at.
  const [moved, setMoved] = useState(false);
  const [soldFor, setSoldFor] = useState<number | null>(null);
  const hintId = useId();

  function reset() {
    setStep('idle');
    setQuote(null);
    setMoved(false);
  }

  async function price() {
    setStep('pricing');
    setError(null);
    setMoved(false);
    try {
      setQuote(await api.cashOutQuote(bet.id));
      setStep('priced');
    } catch (e) {
      setError(cashOutProblem(e, 'pricing'));
      reset();
    }
  }

  async function sell() {
    if (!quote || quote.proceeds === null) return;
    setStep('selling');
    setError(null);
    try {
      // The floor is the figure on the button. With a floor the executor sells at the prices it quoted or better.
      const done = await api.cashOut(bet.id, quote.proceeds);
      if (done.cashOut.complete) {
        // The list reloads and this row comes back without a cash-out; until then it says what happened and offers nothing.
        setSoldFor(done.cashOut.proceeds);
        setQuote(null);
        setStep('sold');
        onDone(`Sold for ${usd(done.cashOut.proceeds)}. Both of the bet’s orders were sold back.`);
      } else {
        // Part of it sold: the bet is still open with what is left, so the row goes back to where it can be priced again.
        reset();
        onDone(`Part of this bet was sold, for ${usd(done.cashOut.proceeds)} so far. The rest is still open and can be cashed out again.`);
      }
    } catch (e) {
      // A sale refused on its price comes back with the price as it is now (demo data sends none, so it is read again).
      // That price goes on the button, so the figure shown is never a stale one.
      const fresh = quoteOn(e) ?? (e instanceof ApiError && e.code === 'below_minimum' ? await api.cashOutQuote(bet.id).catch(() => null) : null);
      const priceMoved = e instanceof ApiError && e.code === 'below_minimum';
      if (fresh && (priceMoved || !fresh.available)) {
        setQuote(fresh);
        setMoved(priceMoved);
        setStep('priced');
        return;
      }
      setError(cashOutProblem(e, 'selling'));
      reset();
    }
  }

  const busy = step === 'pricing' || step === 'selling';
  const priced = step === 'priced' || step === 'selling';
  // The price that can be sold at, when there is one: the same figure goes in the sentence and on the button.
  const offer = priced && quote !== null && quote.available && quote.proceeds !== null ? { quote, proceeds: quote.proceeds } : null;

  return (
    <div className="bl-foot bl-cash" data-cashout={step}>
      {/* Always in the page, empty while there is nothing to say, so a screen reader hears each change. */}
      <p role={error || (moved && offer) ? 'alert' : 'status'}>
        {error ? (
          error
        ) : step === 'sold' && soldFor !== null ? (
          <>
            Sold for <b>{usd(soldFor)}</b>.
          </>
        ) : offer ? (
          <>
            {moved ? 'The price moved. It now sells for ' : 'Sells for '}
            <b>{usd(offer.proceeds)}</b>
            {moved ? '.' : ' now.'} {cashOutWords(offer.quote)}
            <span className="bl-cash-means">{sellingMeans(bet, offer.quote)}</span>
          </>
        ) : priced && quote ? (
          cashOutRefusal(quote)
        ) : null}
      </p>
      {step !== 'sold' && (
        <div className="bl-cash-actions">
          {offer ? (
            <>
              <button
                type="button"
                className="btn btn-ghost bl-btn"
                disabled={busy}
                onClick={() => {
                  setError(null);
                  reset();
                }}
              >
                Keep the bet
              </button>
              <button type="button" className="btn btn-primary bl-btn" disabled={busy} onClick={sell}>
                {step === 'selling' ? 'Selling' : `Sell for ${usd(offer.proceeds)}`}
              </button>
            </>
          ) : (
            <>
              <button type="button" className="btn btn-ghost bl-btn" disabled={busy} onClick={price} aria-describedby={step === 'idle' ? hintId : undefined}>
                {step === 'pricing' ? 'Reading the price' : priced ? 'Check again' : 'Cash out'}
              </button>
              {/* The sentence each open bet used to carry, kept for a screen reader; on screen the button is enough. */}
              <span id={hintId} className="sr-only">
                Sell this bet back before the market settles. This reads the price on offer now and sells nothing yet.
              </span>
            </>
          )}
        </div>
      )}
    </div>
  );
}
