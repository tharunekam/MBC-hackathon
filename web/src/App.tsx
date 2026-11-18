import { Suspense, lazy } from 'react';
import { Route, Routes } from 'react-router-dom';
import Shell from './components/Shell';
import Build from './pages/Build';
import Landing from './pages/Landing';

// The first screens load at once; the rest are fetched when first visited, so the opening download stays small.
const Bets = lazy(() => import('./pages/Bets'));
const Leaderboard = lazy(() => import('./pages/Leaderboard'));
const Proof = lazy(() => import('./pages/Proof'));
const Verify = lazy(() => import('./pages/Verify'));

const Pending = () => (
  <div className="page narrow" aria-busy="true">
    <div className="skeleton row-skel" />
  </div>
);
const lazyPage = (el: JSX.Element) => <Suspense fallback={<Pending />}>{el}</Suspense>;

export default function App() {
  return (
    <Routes>
      <Route element={<Shell />}>
        <Route index element={<Landing />} />
        <Route path="app" element={<Build />} />
        <Route path="app/bets" element={lazyPage(<Bets />)} />
        <Route path="leaderboard" element={lazyPage(<Leaderboard />)} />
        <Route path="proof" element={lazyPage(<Proof />)} />
        <Route path="verify/:signature" element={lazyPage(<Verify />)} />
        <Route path="*" element={<Landing />} />
      </Route>
    </Routes>
  );
}
