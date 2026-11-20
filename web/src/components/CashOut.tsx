import { useState } from 'react';
import { api } from '../api';
import { ApiError } from '../api/client';
import type { Bet, CashOutQuote } from '../api/types';
import { usd } from '../lib/format';

/** How far the price may slip, in dollars, between the figure shown and the sale. Past this the sale is refused. */
const TOLERANCE = 0.02;

/** The sentence under a live price: what selling now makes or loses against what the bet cost. */
export function cashOutWords(q: Pick<CashOutQuote, 'proceeds' | 'stake'>): string {
  if (q.proceeds === null) return '';
  const diff = q.proceeds - q.stake;
  if (diff > 0.004) return `${usd(diff)} more than it cost.`;
  if (diff < -0.004) return `${usd(-diff)} less than it cost.`;
  return 'The same as it cost.';
}

/**
 * On an open bet: sell it back before the market settles. Two steps on purpose. The first reads the live price and sends
 * nothing; the second sells at that price or not at all, so the figure on the button is the figure that was checked.
 */
export function CashOut({ bet, onDone }: { bet: Bet; onDone: (message: string) => void }) {
  const [step, setStep] = useState<'idle' | 'pricing' | 'priced' | 'selling'>('idle');
  const [quote, setQuote] = useState<CashOutQuote | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function price() {
    setStep('pricing');
    setError(null);
    try {
      setQuote(await api.cashOutQuote(bet.id));
      setStep('priced');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not read the price.');
      setStep('idle');
    }
  }

  async function sell() {
    if (!quote || quote.proceeds === null) return;
    setStep('selling');
    setError(null);
    try {
      const done = await api.cashOut(bet.id, Math.max(0, Math.round((quote.proceeds - TOLERANCE) * 100) / 100));
      onDone(done.cashOut.complete ? `Sold for ${usd(done.cashOut.proceeds)}. Both orders were sold back on Gemini.` : 'Part of the bet was sold. The rest is still in place.');
    } catch (e) {
      // A refusal carries the quote it was refused on, so the price shown is never left stale.
      const fresh = e instanceof ApiError ? (e.body as { quote?: CashOutQuote } | null)?.quote : undefined;
      if (fresh) setQuote(fresh);
      setError(e instanceof Error ? e.message : 'Could not sell this bet.');
      setStep(fresh ? 'priced' : 'idle');
    }
  }

  const busy = step === 'pricing' || step === 'selling';
  const canSell = step !== 'idle' && quote?.available === true && quote.proceeds !== null;

  return (
    <div className="bl-foot bl-cash" data-cashout={step}>
      <p role={error ? 'alert' : 'status'}>
        {error ? (
          error
        ) : step === 'idle' || step === 'pricing' ? (
          'You can sell this bet back before the market settles, at the price on offer now.'
        ) : quote && quote.available && quote.proceeds !== null ? (
          <>
            Sells for <b>{usd(quote.proceeds)}</b> now. {cashOutWords(quote)}
          </>
        ) : (
          (quote?.reason ?? 'This bet cannot be sold right now.')
        )}
      </p>
      <div className="bl-cash-actions">
        {canSell ? (
          <>
            <button type="button" className="btn btn-ghost bl-btn" disabled={busy} onClick={() => setStep('idle')}>
              Keep the bet
            </button>
            <button type="button" className="btn btn-primary bl-btn" disabled={busy} onClick={sell}>
              {step === 'selling' ? 'Selling' : `Sell for ${usd(quote!.proceeds!)}`}
            </button>
          </>
        ) : (
          <button type="button" className="btn btn-ghost bl-btn" disabled={busy} onClick={price}>
            {step === 'pricing' ? 'Reading the price' : step === 'priced' ? 'Check again' : 'Cash out'}
          </button>
        )}
      </div>
    </div>
  );
}
