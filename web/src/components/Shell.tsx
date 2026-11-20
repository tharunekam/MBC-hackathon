import { useEffect, useRef, useState } from 'react';
import { Link, NavLink, Outlet, useLocation } from 'react-router-dom';
import { useLiveStatus } from '../lib/hooks';
import { chainLive, execLive } from '../lib/liveClients';
import { MY_BETS, PRODUCTS, TOOLS } from '../lib/nav';
import { titleFor } from '../lib/titles';
import { keepMode, useVenue, type VenueNote } from '../lib/venue';
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
    <button type="button" className="icon-btn" onClick={flip} aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}>
      {theme === 'dark' ? <Sun /> : <Moon />}
    </button>
  );
}

const tabClass = ({ isActive }: { isActive: boolean }) => `nav-link${isActive ? ' is-on' : ''}`;

/** At 1080px and below the tabs fold into one sheet: the products with what each one is, then everything else. */
function MenuSheet({ onPick }: { onPick: () => void }) {
  return (
    <div className="sheet" id="site-menu">
      <nav className="sheet-in" aria-label="Menu">
        <h2 className="sheet-label">Products</h2>
        <ul className="sheet-list">
          {PRODUCTS.map((p) => (
            <li key={p.id}>
              <NavLink to={keepMode(p.to)} onClick={onPick}>
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
              <NavLink to={keepMode(t.to)} onClick={onPick}>
                {t.name}
              </NavLink>
            </li>
          ))}
        </ul>
      </nav>
    </div>
  );
}

/** What the app is talking to. The second half ("practice money") moves to a line of its own where the bar is short of room. */
function VenueChip({ venue }: { venue: VenueNote }) {
  if (!venue.chip) return null;
  const [what, more] = venue.chip.split(' · ');
  return (
    <span className="chip chip-quiet venue" title={venue.about || undefined}>
      <span>{what}</span>
      {more && (
        <>
          <span className="venue-dot" aria-hidden="true">
            ·
          </span>
          <span>{more}</span>
        </>
      )}
    </span>
  );
}

export function Nav({ venue }: { venue: VenueNote }) {
  const { pathname, hash } = useLocation();
  const home = pathname === '/';
  const [top, setTop] = useState(true);
  const [menu, setMenu] = useState(false);
  const menuBtn = useRef<HTMLButtonElement>(null);
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
    // The sheet covers the page, so what is behind it leaves the tab order and the reading order until it closes.
    const behind = document.querySelectorAll<HTMLElement>('#main, .tabbar, .foot');
    behind.forEach((el) => (el.inert = true));
    const esc = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setMenu(false);
      menuBtn.current?.focus(); // the link that had focus is about to go, so hand it back to the button
    };
    // The sheet only exists at 1080px and below (header.css). A window widened past that with the menu open must not stay locked.
    const wide = window.matchMedia('(min-width: 1081px)');
    const widened = () => wide.matches && setMenu(false);
    document.addEventListener('keydown', esc);
    wide.addEventListener('change', widened);
    return () => {
      document.body.style.overflow = '';
      behind.forEach((el) => (el.inert = false));
      document.removeEventListener('keydown', esc);
      wide.removeEventListener('change', widened);
    };
  }, [menu]);
  return (
    // With the menu open the bar is drawn solid, so the sheet never sits under a transparent bar.
    <header className="nav" data-home={home ? '' : undefined} data-over={home && top && !menu ? 'dark' : undefined}>
      <div className="nav-in">
        <Link to={keepMode('/')} className="brand" aria-label="Given home">
          Given
        </Link>
        <nav className="nav-links" aria-label="Main">
          {PRODUCTS.map((p) => (
            <NavLink key={p.id} to={keepMode(p.to)} className={tabClass}>
              {p.name}
            </NavLink>
          ))}
          <span className="nav-sep" aria-hidden="true" />
          {TOOLS.map((t) => (
            <NavLink key={t.id} to={keepMode(t.to)} className={tabClass}>
              {t.name}
            </NavLink>
          ))}
        </nav>
        <div className="nav-right">
          {!home && <LiveBadge />}
          <VenueChip venue={venue} />
          <ThemeToggle />
          {home ? (
            <Link to={keepMode(PRODUCTS[0]!.to)} className="btn btn-primary btn-sm">
              Enter app
            </Link>
          ) : (
            <NavLink to={keepMode(MY_BETS.to)} className={({ isActive }) => `btn btn-ghost btn-sm bets-link${isActive ? ' is-on' : ''}`}>
              {MY_BETS.name}
            </NavLink>
          )}
          <button ref={menuBtn} type="button" className="menu-btn" aria-expanded={menu} aria-controls="site-menu" onClick={() => setMenu((v) => !v)}>
            {menu ? 'Close' : 'Menu'}
          </button>
        </div>
      </div>
      {menu && <MenuSheet onPick={() => setMenu(false)} />}
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

export function Footer({ venue }: { venue: VenueNote }) {
  return (
    <footer className="foot">
      <div className="wrap">
        <div className="foot-top">
          <div className="foot-brand">
            <div className="brand">Given</div>
            <p>Bets on where a price finishes, with every result on screen before you bet.</p>
          </div>
          <nav className="foot-cols" aria-label="Footer">
            <div>
              <h2>Products</h2>
              {PRODUCTS.map((p) => (
                <Link key={p.id} to={keepMode(p.to)}>
                  {p.name}
                </Link>
              ))}
            </div>
            <div>
              <h2>Explore</h2>
              {[...TOOLS, MY_BETS].map((t) => (
                <Link key={t.id} to={keepMode(t.to)}>
                  {t.name}
                </Link>
              ))}
            </div>
            <div>
              <h2>How it works</h2>
              {HOW.map((h) => (
                <Link key={h.hash} to={keepMode(`/${h.hash}`)}>
                  {h.name}
                </Link>
              ))}
            </div>
          </nav>
        </div>
        {/* What this copy of the app is really talking to comes first, then the two lines that never change. */}
        <p className="foot-legal">{venue.about} Not affiliated with Gemini. Prediction markets carry risk, including the loss of your stake.</p>
      </div>
    </footer>
  );
}

/**
 * The phone's bottom bar: the three builders, Hunch (another way to start a bet) and the place you come back to. Markets is an
 * index rather than a way in, so it sits in the Menu with Leaderboard and Proof.
 */
const TABS = [
  ...PRODUCTS.map((p) => ({ to: p.to, label: p.short })),
  ...TOOLS.filter((t) => t.id === 'hunch').map((t) => ({ to: t.to, label: t.name })),
  { to: MY_BETS.to, label: MY_BETS.name },
];

/** Layout for every route. Scrolls to the top on navigation. */
export default function Shell() {
  const { pathname, hash } = useLocation();
  const venue = useVenue();
  useEffect(() => {
    // A link to a section of a page lands on it; every other navigation starts at the top.
    const target = hash ? document.getElementById(hash.slice(1)) : null;
    if (target) target.scrollIntoView();
    else window.scrollTo(0, 0);
  }, [pathname, hash]);
  useEffect(() => {
    document.title = titleFor(pathname);
  }, [pathname]);
  return (
    <>
      {/* The first thing a keyboard reaches: past the bar, straight to the page. */}
      <a className="skip" href="#main">
        Skip to content
      </a>
      <Nav venue={venue} />
      {pathname !== '/' && (
        <nav className="tabbar" aria-label="Primary">
          {TABS.map((l) => (
            <NavLink key={l.to} to={keepMode(l.to)} className={({ isActive }) => (isActive ? 'is-on' : '')}>
              {l.label}
            </NavLink>
          ))}
        </nav>
      )}
      {/* Focusable only by the skip link, so focus (and a screen reader) really does move here. */}
      <main id="main" tabIndex={-1}>
        <Outlet context={venue} />
      </main>
      <Footer venue={venue} />
    </>
  );
}
