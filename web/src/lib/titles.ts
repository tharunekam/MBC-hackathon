/**
 * What the browser tab, the history list and a shared link say for each page. One title for every page made the back button's
 * list and a row of open tabs unreadable ("Given", "Given", "Given"), and a screen reader announces the title on arrival.
 */
const SITE = 'Given';
const HOME = "Given – money back if it doesn't happen";

const PAGES: [prefix: string, title: string][] = [
  ['/parlay', 'Return Parlay'],
  ['/range', 'Range and Breakout'],
  ['/basket', 'Basket'],
  ['/hunch', 'Hunch'],
  ['/sketch', 'Sketch'],
  ['/markets', 'Markets'],
  ['/bets', 'My bets'],
  ['/leaderboard', 'Leaderboard'],
  ['/proof', 'Proof'],
  ['/verify', 'Proof of a call'],
  // Old addresses that are sent on to the builder.
  ['/app/bets', 'My bets'],
  ['/app', 'Return Parlay'],
];

/** The title for an address. The landing page carries the site's own line; an address the app does not know says so. */
export function titleFor(pathname: string): string {
  const path = pathname.replace(/\/+$/, '') || '/';
  if (path === '/') return HOME;
  // The longest prefix wins, so /app/bets is not read as /app.
  const hit = PAGES.filter(([prefix]) => path === prefix || path.startsWith(`${prefix}/`)).sort((a, b) => b[0].length - a[0].length)[0];
  return hit ? `${hit[1]} · ${SITE}` : `Page not found · ${SITE}`;
}
