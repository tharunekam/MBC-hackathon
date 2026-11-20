/**
 * The products Given is built around, and how far along each one is. One list feeds the header menu, the footer and the
 * Products page, so the three never disagree. A status is a promise about the code: only "live" has working orders behind it.
 */
export type ProductStatus = 'live' | 'next' | 'planned';

export interface Product {
  id: string;
  name: string;
  /** One line, for a menu. */
  tagline: string;
  /** A short paragraph, for the Products page. */
  summary: string;
  status: ProductStatus;
  /** Where it lives in the app; null until there is somewhere to go. */
  to: string | null;
  /** The real orders behind it, in words. */
  orders: string[];
  /** When it pays, and when it does not. */
  pays: string;
  /** Why it is not live yet, for anything that is not. */
  blocker?: string;
}

export const STATUS_LABEL: Record<ProductStatus, string> = { live: 'Live', next: 'Next', planned: 'Planned' };

export const PRODUCTS: Product[] = [
  {
    id: 'given',
    name: 'Given',
    tagline: 'Money back if the first half fails',
    summary: 'Bet that a price reaches a higher level, given that it first holds a lower one. If the lower level fails, your stake comes back.',
    status: 'live',
    to: '/app',
    orders: ['Buy YES on the higher price, which is the bet itself.', 'Buy a sized NO on the lower price, which pays your stake back if it fails.'],
    pays: 'Pays $1 per contract if both prices hold. Returns the stake if the lower price fails. Loses the stake only when the lower price holds and the higher one does not.',
  },
  {
    id: 'range',
    name: 'Range',
    tagline: 'Win if it finishes between two prices',
    summary: 'Pick a floor and a ceiling and win if the price closes between them. Priced from the same ladder as every other bet.',
    status: 'next',
    to: null,
    orders: ['Buy YES on the lower price.', 'Buy NO on the higher price, for the same number of contracts.'],
    pays: 'One of the two orders always pays $1, so what you risk is the gap between what you paid and that dollar. The second dollar arrives only if the price lands inside the range.',
    blocker: 'Needs the order path extended to equal-sized pairs, then a sandbox run and a reconciliation.',
  },
  {
    id: 'below',
    name: 'Below',
    tagline: 'The same safety net, for falling prices',
    summary: 'Given that a price stays under one level, bet that it stays under a lower one. The mirror image of Given, with the refund on the way up.',
    status: 'planned',
    to: null,
    orders: ['Buy NO on the lower price, which is the bet itself.', 'Buy a sized YES on the higher price, which pays your stake back if it breaks through.'],
    pays: 'Pays $1 per contract if the price stays under both levels. Returns the stake if it rises through the higher one.',
    blocker: 'Works on the same ladders; the executor handles rising bets only.',
  },
  {
    id: 'chain',
    name: 'Chain',
    tagline: 'Three prices, with the refund at each step',
    summary: 'Given the first price holds and then the second, will the third? A longer version of Given for people with a view on a path.',
    status: 'planned',
    to: null,
    orders: ['Buy YES on the highest price.', 'Buy sized NO orders on the two lower prices so each failed step is made whole.'],
    pays: 'Pays only if all three hold. A failure at either earlier step returns the stake.',
    blocker: 'Three-leg sizing is not built, and the cost of three spreads may be too high to offer.',
  },
  {
    id: 'favourite',
    name: 'Without the favourite',
    tagline: 'Draw no bet, for markets with one winner',
    summary: 'Bet on a team or outcome and get the stake back if the favourite wins. Familiar from sportsbooks, where it is called draw no bet.',
    status: 'planned',
    to: null,
    orders: ['Buy YES on the outcome you want.', 'Buy a sized YES on the favourite, which returns the stake if the favourite wins.'],
    pays: 'Pays if your outcome wins. Returns the stake if the favourite wins. Loses only if neither does.',
    blocker: 'Needs a market where exactly one outcome always wins, and the exchange’s rule for a void result.',
  },
  {
    id: 'across',
    name: 'Across markets',
    tagline: 'Given one market, bet on another',
    summary: 'Tie a bet on one market to a condition in a different one, such as a price level and a rate decision.',
    status: 'planned',
    to: null,
    orders: ['Buy the combined contract on both markets.', 'Buy a sized NO on the condition.'],
    pays: 'Pays if both happen. Returns the stake if the condition fails.',
    blocker: 'Depends on the exchange opening combined-contract creation, which it has not.',
  },
];

export const PRODUCT = Object.fromEntries(PRODUCTS.map((p) => [p.id, p])) as Record<string, Product>;

/** Everything in the app that is not a bet type. */
export const TOOLS: { id: string; name: string; tagline: string; to: string }[] = [
  { id: 'markets', name: 'Markets', tagline: 'Every ladder the exchange lists, by asset and close', to: '/markets' },
  { id: 'leaderboard', name: 'Leaderboard', tagline: 'Ranked by skill against the market, rebuilt from Solana', to: '/leaderboard' },
  { id: 'proof', name: 'Proof', tagline: 'Check our books and any call yourself', to: '/proof' },
];
