import { useEffect, useState } from 'react';
import { NavLink, Link, Outlet, useLocation } from 'react-router-dom';
import { useLiveStatus } from '../lib/hooks';
import { chainLive, execLive } from '../lib/liveClients';
import { useVenue } from '../lib/venue';

const Sun = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
    <circle cx="12" cy="12" r="4" />
    <path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M5.6 18.4 7 17M17 7l1.4-1.4" />
  </svg>
);
const Moon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5Z" />
  </svg>
);

function currentTheme(): 'light' | 'dark' {
  const t = document.documentElement.dataset.theme;
  if (t === 'light' || t === 'dark') return t;
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function ThemeToggle() {
  const [theme, setTheme] = useState<'light' | 'dark'>(currentTheme);
  const flip = () => {
    const next = theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem('given-theme', next);
    } catch {
      /* private mode */
    }
    setTheme(next);
  };
  return (
    <button className="icon-btn" onClick={flip} aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}>
      {theme === 'dark' ? <Sun /> : <Moon />}
    </button>
  );
}

const LINKS = [
  { to: '/app', label: 'Build', end: true },
  { to: '/app/bets', label: 'My bets' },
  { to: '/leaderboard', label: 'Leaderboard' },
  { to: '/proof', label: 'Proof' },
];

export function Nav() {
  const venue = useVenue();
  const { pathname } = useLocation();
  const home = pathname === '/';
  const [top, setTop] = useState(true);
  useEffect(() => {
    const on = () => setTop(window.scrollY < 24);
    on();
    window.addEventListener('scroll', on, { passive: true });
    return () => window.removeEventListener('scroll', on);
  }, []);
  return (
    <header className="nav" data-home={home ? '' : undefined} data-over={home && top ? 'dark' : undefined}>
      <div className="nav-in">
        <Link to="/" className="brand" aria-label="Given home">
          Given
        </Link>
        {!home && (
          <nav className="nav-links" aria-label="Main">
            {LINKS.map((l) => (
              <NavLink key={l.to} to={l.to} end={l.end} className={({ isActive }) => (isActive ? 'is-on' : '')}>
                {l.label}
              </NavLink>
            ))}
          </nav>
        )}
        <div className="nav-right">
          {!home && <LiveBadge />}
          {!home && venue.chip && <span className="chip chip-quiet">{venue.chip}</span>}
          <ThemeToggle />
          {home && (
            <Link to="/app" className="btn btn-primary btn-sm">
              Enter app
            </Link>
          )}
        </div>
      </div>
    </header>
  );
}

/** Shows that prices and results are arriving on their own, or that the page has fallen back to refreshing. */
function LiveBadge() {
  const exec = useLiveStatus(execLive);
  const chain = useLiveStatus(chainLive);
  if (!execLive && !chainLive) return null;
  const all = [exec, chain];
  const state = all.every((s) => s === 'live') ? 'live' : all.some((s) => s === 'down') ? 'down' : all.some((s) => s === 'live') ? 'live' : 'connecting';
  if (state === 'connecting') return null; // do not flash a status before there is one
  const label = state === 'live' ? 'Live' : 'Reconnecting';
  return (
    <span className="live" data-state={state} role="status" title={state === 'live' ? 'Prices and results update as they happen.' : 'The live connection dropped. The page refreshes every few seconds until it is back.'}>
      <span className="live-dot" aria-hidden="true" />
      {label}
    </span>
  );
}

export function Footer() {
  const venue = useVenue();
  return (
    <footer className="foot">
      <div className="wrap">
        <div className="foot-top">
          <div className="foot-brand">
            <div className="brand brand-foot">Given</div>
            <p>Bets that give your money back if the first half of your hunch doesn’t happen.</p>
          </div>
          <nav className="foot-cols" aria-label="Footer">
            <div>
              <h2>Product</h2>
              <Link to="/app">Build a bet</Link>
              <Link to="/app/bets">My bets</Link>
              <Link to="/leaderboard">Leaderboard</Link>
            </div>
            <div>
              <h2>Trust</h2>
              <Link to="/proof">Proof</Link>
              <Link to={{ pathname: '/', hash: '#how' }}>How it works</Link>
              <Link to={{ pathname: '/', hash: '#cost' }}>What it costs</Link>
            </div>
          </nav>
        </div>
        <p className="fine foot-legal">
          Given uses Gemini’s prediction market API and is not affiliated with Gemini. {venue.footnote} Prediction markets involve risk and can lose the amount you stake.
        </p>
      </div>
    </footer>
  );
}

/** Layout for every route. Scrolls to the top on navigation. */
export default function Shell() {
  const { pathname, hash } = useLocation();
  useEffect(() => {
    // A link to a section of the landing page lands on it; every other navigation starts at the top.
    const target = hash ? document.getElementById(hash.slice(1)) : null;
    if (target) target.scrollIntoView();
    else window.scrollTo(0, 0);
  }, [pathname, hash]);
  return (
    <>
      <Nav />
      {pathname !== '/' && (
        <nav className="tabbar" aria-label="Primary">
          {LINKS.map((l) => (
            <NavLink key={l.to} to={l.to} end={l.end} className={({ isActive }) => (isActive ? 'is-on' : '')}>
              {l.label}
            </NavLink>
          ))}
        </nav>
      )}
      <main id="main">
        <Outlet />
      </main>
      <Footer />
    </>
  );
}
