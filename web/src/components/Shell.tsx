import { useEffect, useRef, useState } from 'react';
import { Link, NavLink, Outlet, useLocation } from 'react-router-dom';
import { useLiveStatus } from '../lib/hooks';
import { chainLive, execLive } from '../lib/liveClients';
import { PRODUCTS, STATUS_LABEL, TOOLS, type Product } from '../lib/products';
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
const Chevron = () => (
  <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="m3 4.5 3 3 3-3" />
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

/** Where a product's menu entry goes: its own screen when it has one, otherwise its place on the Products page. */
const productTo = (p: Product) => p.to ?? `/products#pr-${p.id}`;

function StatusTag({ status }: { status: Product['status'] }) {
  return (
    <span className="tag" data-status={status}>
      {STATUS_LABEL[status]}
    </span>
  );
}

/** The Products menu: the live product first and larger, then everything built on the same idea, each with how far along it is. */
function ProductsMenu({ active }: { active: boolean }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const timer = useRef<number>();
  const { pathname, hash } = useLocation();

  useEffect(() => setOpen(false), [pathname, hash]);
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('pointerdown', away);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('pointerdown', away);
      document.removeEventListener('keydown', esc);
    };
  }, [open]);

  const enter = () => {
    window.clearTimeout(timer.current);
    if (window.matchMedia?.('(hover: hover)').matches) setOpen(true);
  };
  const leave = () => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setOpen(false), 140);
  };

  const [primary, ...rest] = PRODUCTS;
  return (
    <div
      className="menu-wrap"
      ref={box}
      onMouseEnter={enter}
      onMouseLeave={leave}
      onBlur={(e) => {
        if (!box.current?.contains(e.relatedTarget as Node | null)) setOpen(false);
      }}
    >
      <button type="button" className={`nav-link${active ? ' is-on' : ''}`} aria-expanded={open} aria-controls="products-menu" onClick={() => setOpen((v) => (window.matchMedia?.('(hover: hover)').matches ? true : !v))}>
        Products
        <span className="chev" data-open={open} aria-hidden="true">
          <Chevron />
        </span>
      </button>
      {open && (
        <div className="menu" id="products-menu">
          <Link to={productTo(primary!)} className="menu-lead">
            <span className="menu-top">
              <b>{primary!.name}</b>
              <StatusTag status={primary!.status} />
            </span>
            <span>{primary!.summary}</span>
            <span className="menu-go">Build a bet</span>
          </Link>
          <div className="menu-label">Also on the way</div>
          <ul className="menu-list">
            {rest.map((p) => (
              <li key={p.id}>
                <Link to={productTo(p)}>
                  <span className="menu-top">
                    <b>{p.name}</b>
                    <StatusTag status={p.status} />
                  </span>
                  <span>{p.tagline}</span>
                </Link>
              </li>
            ))}
          </ul>
          <Link to="/products" className="menu-foot">
            All products and how each is built
          </Link>
        </div>
      )}
    </div>
  );
}

/** The phone menu: everything in one sheet, since the tab bar only has room for the places you go most. */
function MobileMenu() {
  const [open, setOpen] = useState(false);
  const { pathname, hash } = useLocation();
  useEffect(() => setOpen(false), [pathname, hash]);
  useEffect(() => {
    document.body.style.overflow = open ? 'hidden' : '';
    return () => {
      document.body.style.overflow = '';
    };
  }, [open]);
  return (
    <>
      <button type="button" className="menu-btn" aria-expanded={open} aria-controls="mobile-menu" onClick={() => setOpen((v) => !v)}>
        {open ? 'Close' : 'Menu'}
      </button>
      {open && (
        <div className="sheet" id="mobile-menu">
          <div className="sheet-in">
            <div className="menu-label">Products</div>
            <ul className="sheet-list">
              {PRODUCTS.map((p) => (
                <li key={p.id}>
                  <Link to={productTo(p)}>
                    <span className="menu-top">
                      <b>{p.name}</b>
                      <StatusTag status={p.status} />
                    </span>
                    <span>{p.tagline}</span>
                  </Link>
                </li>
              ))}
            </ul>
            <div className="menu-label">Explore</div>
            <ul className="sheet-list sheet-plain">
              {TOOLS.map((t) => (
                <li key={t.id}>
                  <Link to={t.to}>{t.name}</Link>
                </li>
              ))}
              <li>
                <Link to="/app/bets">My bets</Link>
              </li>
            </ul>
          </div>
        </div>
      )}
    </>
  );
}

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
  const inProducts = pathname === '/products' || pathname === '/app';
  return (
    <header className="nav" data-home={home ? '' : undefined} data-over={home && top ? 'dark' : undefined}>
      <div className="nav-in">
        <Link to="/" className="brand" aria-label="Given home">
          Given
        </Link>
        <nav className="nav-links" aria-label="Main">
          <ProductsMenu active={inProducts} />
          {TOOLS.map((t) => (
            <NavLink key={t.id} to={t.to} className={({ isActive }) => `nav-link${isActive ? ' is-on' : ''}`}>
              {t.name}
            </NavLink>
          ))}
        </nav>
        <div className="nav-right">
          {!home && <LiveBadge />}
          {!home && venue.chip && <span className="chip chip-quiet">{venue.chip}</span>}
          <ThemeToggle />
          {home ? (
            <Link to="/app" className="btn btn-primary btn-sm">
              Enter app
            </Link>
          ) : (
            <NavLink to="/app/bets" className={({ isActive }) => `btn btn-ghost btn-sm bets-link${isActive ? ' is-on' : ''}`}>
              My bets
            </NavLink>
          )}
          <MobileMenu />
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
              <h2>Products</h2>
              {PRODUCTS.map((p) => (
                <Link key={p.id} to={productTo(p)}>
                  {p.name}
                  {p.status !== 'live' && <span className="foot-status">{STATUS_LABEL[p.status]}</span>}
                </Link>
              ))}
            </div>
            <div>
              <h2>Explore</h2>
              {TOOLS.map((t) => (
                <Link key={t.id} to={t.to}>
                  {t.name}
                </Link>
              ))}
              <Link to="/app/bets">My bets</Link>
              <Link to="/products">All products</Link>
            </div>
            <div>
              <h2>How it works</h2>
              <Link to={{ pathname: '/', hash: '#how' }}>Two orders, three outcomes</Link>
              <Link to={{ pathname: '/', hash: '#cost' }}>What it costs</Link>
              <Link to={{ pathname: '/', hash: '#proof' }}>The record on Solana</Link>
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

/** The phone's bottom bar: the places you go most. Products and the rest are in the Menu. */
const TABS = [
  { to: '/app', label: 'Build', end: true },
  { to: '/markets', label: 'Markets' },
  { to: '/app/bets', label: 'My bets' },
  { to: '/leaderboard', label: 'Ranks' },
  { to: '/proof', label: 'Proof' },
];

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
