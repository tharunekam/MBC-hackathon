import { Route, Routes } from 'react-router-dom';
import Shell from './components/Shell';
import Bets from './pages/Bets';
import Build from './pages/Build';
import Landing from './pages/Landing';
import Leaderboard from './pages/Leaderboard';
import Proof from './pages/Proof';

export default function App() {
  return (
    <Routes>
      <Route element={<Shell />}>
        <Route index element={<Landing />} />
        <Route path="app" element={<Build />} />
        <Route path="app/bets" element={<Bets />} />
        <Route path="leaderboard" element={<Leaderboard />} />
        <Route path="proof" element={<Proof />} />
        <Route path="*" element={<Landing />} />
      </Route>
    </Routes>
  );
}
