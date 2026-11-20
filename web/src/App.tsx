import { Suspense, lazy } from 'react';
import { Route, Routes } from 'react-router-dom';
import Shell from './components/Shell';
import Build from './pages/Build';
import Landing from './pages/Landing';

// The first screens load at once; the rest are fetched when first visited, so the opening download stays small.
const Bets = lazy(() => import('./pages/Bets'));
const Leaderboard = lazy(() => import('./pages/Leaderboard'));
const Proof = lazy(() => import('./pages/Proof'));
const Markets = lazy(() => import('./pages/Markets'));
const Products = lazy(() => import('./pages/Products'));
const Verify = lazy(() => import('./pages/Verify'));

// Once the first screen is up and the browser is idle, fetch the other pages, so moving to them is instant and never shows
// the loading placeholder. (Safari has no requestIdleCallback, hence the timeout.)
function preloadPages(): void {
  void import('./pages/Bets');
  void import('./pages/Leaderboard');
  void import('./pages/Proof');
  void import('./pages/Markets');
  void import('./pages/Products');
  void import('./pages/Verify');
}
if (typeof window !== 'undefined') {
  const idle = (window as { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number }).requestIdleCallback;
  if (idle) idle.call(window, preloadPages, { timeout: 4000 });
  else setTimeout(preloadPages, 1500);
}

// The placeholder carries the page's own heading, so the page is never without one while its code loads.
const Pending = ({ title }: { title: string }) => (
  <div className="page narrow" aria-busy="true">
    <h1 className="sr-only">{title}</h1>
    <div className="skeleton row-skel" />
  </div>
);
const lazyPage = (el: JSX.Element, title: string) => <Suspense fallback={<Pending title={title} />}>{el}</Suspense>;

export default function App() {
  return (
    <Routes>
      <Route element={<Shell />}>
        <Route index element={<Landing />} />
        <Route path="app" element={<Build />} />
        <Route path="app/bets" element={lazyPage(<Bets />, 'My bets')} />
        <Route path="markets" element={lazyPage(<Markets />, 'Markets')} />
        <Route path="products" element={lazyPage(<Products />, 'Products')} />
        <Route path="leaderboard" element={lazyPage(<Leaderboard />, 'Leaderboard')} />
        <Route path="proof" element={lazyPage(<Proof />, 'Proof')} />
        <Route path="verify/:signature" element={lazyPage(<Verify />, 'Proof of a call')} />
        <Route path="*" element={<Landing />} />
      </Route>
    </Routes>
  );
}
