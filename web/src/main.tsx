import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import './styles/tokens.css';
import './styles/app.css';

// `?theme=dark` or `?theme=light` forces a theme (used for screenshots and review).
try {
  const forced = new URLSearchParams(window.location.search).get('theme');
  if (forced === 'light' || forced === 'dark') document.documentElement.dataset.theme = forced;
  // `?still` turns animation off, so screenshots and accessibility audits see the settled page.
  if (new URLSearchParams(window.location.search).has('still')) document.documentElement.dataset.still = '1';
} catch {
  /* ignore */
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
);
