import { useEffect, useState } from 'react';
import { Link, NavLink, Outlet, useLocation } from 'react-router-dom';
import { useLiveStatus } from '../lib/hooks';
import { chainLive, execLive } from '../lib/liveClients';
import { MY_BETS, PRODUCTS, TOOLS } from '../lib/nav';
import { useVenue } from '../lib/venue';
import '../styles/header.css';

const Sun = () => (
  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
    <circle cx="12" cy="12" r="4" />
    <path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M5.6 18.4 7 17M17 7l1.4-1.4" />
  </svg>
);
const Moon = () => (
  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
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

const tabClass = ({ isActive }: { isActive: boolean }) => `nav-link${isActive ? ' is-on' : ''}`;

/** Below 1000px the tabs fold into one sheet: the products with what each one is, then everything else. */
function MenuSheet() {
  return (
    <div className="sheet" id="site-menu">
      <nav className="sheet-in" aria-label="Menu">
        <h2 className="sheet-label">Products</h2>
        <ul className="sheet-list">
          {PRODUCTS.map((p) => (
            <li key={p.id}>
              <NavLink to={p.to}>
                <b>{p.name}</b>
                <span>{p.tagline}</span>
              </NavLink>
            </li>
          ))}
        </ul>
        <h2 className="sheet-label">Explore</h2>
        <ul className="sheet-list sheet-plain">
          {[...TOOLS, MY_BETS].map((t) => (
            <li key={t.id}>
              <NavLink to={t.to}>{t.name}</NavLink>
            </li>
          ))}
        </ul>
      </nav>
    </div>
  );
}

export function Nav() {
  const venue = useVenue();
  const { pathname, hash } = useLocation();
  const home = pathname === '/';
  const [top, setTop] = useState(true);
  const [menu, setMenu] = useState(false);
  useEffect(() => {
    const on = () => setTop(window.scrollY < 24);
    on();
    window.addEventListener('scroll', on, { passive: true });
    return () => window.removeEventListener('scroll', on);
  }, []);
  useEffect(() => setMenu(false), [pathname, hash]);
  useEffect(() => {
    if (!menu) return;
    document.body.style.overflow = 'hidden';
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setMenu(false);
    document.addEventListener('keydown', esc);
    return () => {
      document.body.style.overflow = '';
      document.removeEventListener('keydown', esc);
    };
  }, [menu]);
  return (
    // With the menu open the bar is drawn solid, so the sheet never sits under a transparent bar.
    <header className="nav" data-home={home ? '' : undefined} data-over={home && top && !menu ? 'dark' : undefined}>
      <div className="nav-in">
        <Link to="/" className="brand" aria-label="Given home">
          Given
        </Link>
        <nav className="nav-links" aria-label="Main">
          {PRODUCTS.map((p) => (
            <NavLink key={p.id} to={p.to} className={tabClass}>
              {p.name}
            </NavLink>
          ))}
          <span className="nav-sep" aria-hidden="true" />
          {TOOLS.map((t) => (
            <NavLink key={t.id} to={t.to} className={tabClass}>
              {t.name}
            </NavLink>
          ))}
        </nav>
        <div className="nav-right">
          {!home && <LiveBadge />}
          {!home && venue.chip && <span className="chip chip-quiet">{venue.chip}</span>}
          <ThemeToggle />
          {home ? (
            <Link to={PRODUCTS[0]!.to} className="btn btn-primary btn-sm">
              Enter app
            </Link>
          ) : (
            <NavLink to={MY_BETS.to} className={({ isActive }) => `btn btn-ghost btn-sm bets-link${isActive ? ' is-on' : ''}`}>
              {MY_BETS.name}
            </NavLink>
          )}
          <button type="button" className="menu-btn" aria-expanded={menu} aria-controls="site-menu" onClick={() => setMenu((v) => !v)}>
            {menu ? 'Close' : 'Menu'}
          </button>
        </div>
      </div>
      {menu && <MenuSheet />}
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

const HOW = [
  { hash: '#how', name: 'Two prices, three outcomes' },
  { hash: '#cost', name: 'What it costs' },
  { hash: '#proof', name: 'The record on Solana' },
];

export function Footer() {
  return (
    <footer className="foot">
      <div className="wrap">
        <div className="foot-top">
          <div className="foot-brand">
            <div className="brand">Given</div>
            <p>Bets on where a price finishes, placed as real orders in your own exchange account.</p>
          </div>
          <nav className="foot-cols" aria-label="Footer">
            <div>
              <h2>Products</h2>
              {PRODUCTS.map((p) => (
                <Link key={p.id} to={p.to}>
                  {p.name}
                </Link>
              ))}
            </div>
            <div>
              <h2>Explore</h2>
              {[...TOOLS, MY_BETS].map((t) => (
                <Link key={t.id} to={t.to}>
                  {t.name}
                </Link>
              ))}
            </div>
            <div>
              <h2>How it works</h2>
              {HOW.map((h) => (
                <Link key={h.hash} to={{ pathname: '/', hash: h.hash }}>
                  {h.name}
                </Link>
              ))}
            </div>
          </nav>
        </div>
        <p className="foot-legal">Not affiliated with Gemini. Prediction markets carry risk, including the loss of your stake.</p>
      </div>
    </footer>
  );
}

/** The phone's bottom bar: the three products and the two places you return to. Leaderboard and Proof are in the Menu. */
const TABS = [...PRODUCTS.map((p) => ({ to: p.to, label: p.short })), { to: TOOLS[0]!.to, label: TOOLS[0]!.name }, { to: MY_BETS.to, label: MY_BETS.name }];

/** Layout for every route. Scrolls to the top on navigation. */
export default function Shell() {
  const { pathname, hash } = useLocation();
  useEffect(() => {
    // A link to a section of a page lands on it; every other navigation starts at the top.
    const target = hash ? document.getElementById(hash.slice(1)) : null;
    if (target) target.scrollIntoView();
    else window.scrollTo(0, 0);
  }, [pathname, hash]);
  return (
    <>
      <Nav />
      {pathname !== '/' && (
        <nav className="tabbar" aria-label="Primary">
          {TABS.map((l) => (
            <NavLink key={l.to} to={l.to} className={({ isActive }) => (isActive ? 'is-on' : '')}>
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
