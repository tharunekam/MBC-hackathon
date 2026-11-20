/** Every place the app links to by name. One list feeds the header, the phone menu, the footer and the landing page. */
export interface Destination {
  id: string;
  name: string;
  to: string;
}

export interface Product extends Destination {
  /** The name on the phone's tab bar, where a full name does not fit. */
  short: string;
  tagline: string;
}

export const PRODUCTS: readonly Product[] = [
  { id: 'parlay', name: 'Return Parlay', short: 'Parlay', tagline: 'A parlay that pays your stake back if the first leg misses', to: '/parlay' },
  { id: 'range', name: 'Range', short: 'Range', tagline: 'Bet that a price stays between two levels, or breaks out of them', to: '/range' },
  { id: 'basket', name: 'Basket', short: 'Basket', tagline: 'Several bets on different assets, placed in a single step', to: '/basket' },
];

export const TOOLS: readonly Destination[] = [
  { id: 'markets', name: 'Markets', to: '/markets' },
  { id: 'hunch', name: 'Hunch', to: '/hunch' },
  { id: 'sketch', name: 'Sketch', to: '/sketch' },
  { id: 'leaderboard', name: 'Leaderboard', to: '/leaderboard' },
  { id: 'proof', name: 'Proof', to: '/proof' },
];

export const MY_BETS: Destination = { id: 'bets', name: 'My bets', to: '/bets' };
