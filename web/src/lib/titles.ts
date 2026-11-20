/**
 * What the browser tab, the history list and a shared link say for each page. One title for every page made the back button's
 * list and a row of open tabs unreadable ("Stakeback", "Stakeback", "Stakeback"), and a screen reader announces the title on arrival.
 */
const SITE = 'Stakeback';
const HOME = "Stakeback – money back if it doesn't happen";

/** Every page the router knows by an exact address (it matches without regard to case, and has nothing below these). */
const PAGES: Record<string, string> = {
  '/parlay': 'Stake Back',
  '/range': 'Range and Breakout',
  '/basket': 'Basket',
  '/hunch': 'Hunch',
  '/markets': 'Markets',
  '/bets': 'My bets',
  '/leaderboard': 'Leaderboard',
  '/proof': 'Proof',
  // Old addresses that are sent on to the builder.
  '/app/bets': 'My bets',
  '/app': 'Stake Back',
};

/** A proof is a signature after /verify/. Without one the router shows the not-found page, and so does the title. */
const PROOF = /^\/verify\/[^/]+$/;

/**
 * The title for an address. The landing page carries the site's own line; an address the app does not know says so. The Range
 * page holds both the Range and the Breakout (one switch apart), so its title names both.
 */
export function titleFor(pathname: string): string {
  const path = (pathname.replace(/\/+$/, '') || '/').toLowerCase();
  if (path === '/') return HOME;
  if (PROOF.test(path)) return `Proof of a call · ${SITE}`;
  const page = PAGES[path];
  return page ? `${page} · ${SITE}` : `Page not found · ${SITE}`;
}
