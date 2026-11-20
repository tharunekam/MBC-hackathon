import { useId, useMemo, useState } from 'react';
import { api } from '../api';
import type { Bet } from '../api/types';
import { bookIntro, bookOf, countWords, figureParts, leftOutWords, marketWords, moreWords, openBets, splitMarkets, waitingWords, type BookMarket } from '../lib/book';
import { useResource } from '../lib/hooks';
import { execLive } from '../lib/liveClients';
import { assetLabel, marketHeading } from '../lib/markets';
import PayoffBars from './PayoffBars';
import '../styles/book.css';

/** A sentence with its results and chances set apart: each is kept on one line and given weight (see `figureParts`). */
function Figures({ text }: { text: string }) {
  return <>{figureParts(text).map((part, i) => (i % 2 === 1 ? <b key={i}>{part}</b> : part))}</>;
}

/** A phone opens with the charts folded away, so the list of bets stays within reach; a wider window shows them. */
const chartsStartOpen = (): boolean => typeof window === 'undefined' || typeof window.matchMedia !== 'function' || window.matchMedia('(min-width: 721px)').matches;

/** One market: its name and close, how many bets are added up, the chart, and the chart in a sentence or two. */
function Market({ market }: { market: BookMarket }) {
  const asset = assetLabel(market.event);
  const words = marketWords(market.curve, market.pays, asset);
  const waiting = waitingWords(market.waiting);
  return (
    <article className="ob-market" data-market={market.event.ticker}>
      <h3 className="ob-name">
        <span>{marketHeading(market.event)}</span>
        <span>{countWords(market.bets.length)}</span>
      </h3>
      <PayoffBars curve={market.curve} asset={asset} />
      <p className="ob-line">
        <Figures text={words.odds} /> <Figures text={words.reach} />
      </p>
      {(market.curve.adjusted || waiting) && (
        <p className="fine">
          {market.curve.adjusted && 'Some of this market’s prices were out of order, so they were evened out first.'}
          {market.curve.adjusted && waiting && ' '}
          {waiting}
        </p>
      )}
    </article>
  );
}

/**
 * The card itself. Mounted only while there is an open bet, so a page with none never asks for prices. It draws nothing
 * until the prices have arrived, and then keeps itself current the way the Markets page does: live updates, or a poll
 * while there is no live connection.
 */
function Card({ open }: { open: Bet[] }) {
  const markets = useResource('markets', () => api.markets(), { live: [[execLive, 'markets']], pollMs: 4000, minGapMs: 800 });
  const events = markets.data?.events;
  const book = useMemo(() => (events ? bookOf(open, events) : null), [open, events]);
  const [shown, setShown] = useState(chartsStartOpen);
  const [more, setMore] = useState(false);
  const id = useId();
  if (!book) return null;

  const { first, rest } = splitMarkets(book.markets);
  const leftOut = leftOutWords(book.leftOut, book.markets.length);
  const many = book.markets.length > 1 ? '' : undefined;
  const title = (
    <h2 className="h-card" id={`${id}-title`}>
      Your open bets, together
    </h2>
  );

  // Every open bet is on a market with no prices: nothing to draw or fold away, only the sentence that says so.
  if (book.markets.length === 0)
    return (
      <section className="ob" aria-labelledby={`${id}-title`}>
        <div className="ob-head">{title}</div>
        <div className="ob-body">
          <p className="fine">{leftOut}</p>
        </div>
      </section>
    );

  return (
    <section className="ob" aria-labelledby={`${id}-title`}>
      <details open={shown} onToggle={(e) => setShown(e.currentTarget.open)}>
        <summary className="ob-head">
          {title}
          <span className="ob-toggle">
            {shown ? 'Hide' : book.markets.length === 1 ? 'Show chart' : 'Show charts'}
            <span className="ob-caret" aria-hidden="true" />
          </span>
        </summary>
        <div className="ob-body">
          <p className="ob-intro">{bookIntro(book)}</p>
          <div className="ob-grid" data-many={many}>
            {first.map((m) => (
              <Market key={m.event.ticker} market={m} />
            ))}
          </div>
          {rest.length > 0 && (
            <>
              <button type="button" className="bl-expand ob-more" aria-expanded={more} aria-controls={`${id}-more`} onClick={() => setMore(!more)}>
                <span className="bl-caret" aria-hidden="true" />
                {moreWords(rest.length)}
              </button>
              <div className="ob-grid" data-many={many} id={`${id}-more`} hidden={!more}>
                {rest.map((m) => (
                  <Market key={m.event.ticker} market={m} />
                ))}
              </div>
            </>
          )}
          <p className="fine">
            These are the market’s chances, from its prices right now.{leftOut && ` ${leftOut}`}
          </p>
        </div>
      </details>
    </section>
  );
}

/**
 * "Your open bets, together": for each market the person has an open bet on, what all their open bets on it net at every
 * price the market can finish at (lib/book.ts). The same chart and wording as "What this basket pays" on the Basket page, for
 * bets that have already been placed. Nothing at all is rendered when no bet is open.
 */
export default function OpenBetsCard({ bets }: { bets: readonly Bet[] }) {
  const open = useMemo(() => openBets(bets), [bets]);
  if (open.length === 0) return null;
  return <Card open={open} />;
}
