import { Link } from 'react-router-dom';
import { PRODUCTS, STATUS_LABEL, TOOLS, type Product } from '../lib/products';
import '../styles/products.css';

const SHARED = [
  { title: 'Two real orders', body: 'Every bet is a pair of real orders on the exchange, placed in your own account.' },
  { title: 'Every call fingerprinted', body: 'A fingerprint of each call is written to Solana when you place it. What it says is revealed only if you choose.' },
  { title: 'The price comes first', body: 'You see the price before you bet, and pairs that are poor value are refused.' },
];

export default function Products() {
  const featured = PRODUCTS.find((p) => p.status === 'live');
  const others = PRODUCTS.filter((p) => p !== featured);

  return (
    <div className="page pr">
      <header className="page-head">
        <div>
          <span className="eyebrow">Products</span>
          <h1 className="h-page">One idea, built up in steps</h1>
          <p className="lede">Given is live. The others are the same mechanic on different shapes of bet, and each is marked with exactly how far along it is.</p>
        </div>
      </header>

      {featured && <Featured p={featured} />}

      <section className="pr-section" aria-labelledby="pr-more">
        <h2 id="pr-more" className="pr-h2">
          Not live yet
        </h2>
        <ul className="pr-grid">
          {others.map((p) => (
            <li key={p.id}>
              <article className="pr-card" aria-labelledby={`pr-${p.id}`}>
                <div className="pr-card-head">
                  <h3 id={`pr-${p.id}`} className="pr-h3">
                    {p.name}
                  </h3>
                  <span className="pr-badge" data-status={p.status}>
                    {STATUS_LABEL[p.status]}
                  </span>
                </div>
                <p className="pr-tagline">{p.tagline}</p>
                <p className="pr-summary">{p.summary}</p>
                <Detail label="The orders">
                  <ul className="pr-orders">
                    {p.orders.map((o) => (
                      <li key={o}>{o}</li>
                    ))}
                  </ul>
                </Detail>
                <Detail label="When it pays">
                  <p>{p.pays}</p>
                </Detail>
                {p.blocker && (
                  <Detail label="What it needs">
                    <p>{p.blocker}</p>
                  </Detail>
                )}
              </article>
            </li>
          ))}
        </ul>
      </section>

      <section className="pr-section" aria-labelledby="pr-shared">
        <h2 id="pr-shared" className="pr-h2">
          What every product shares
        </h2>
        <ul className="pr-shared">
          {SHARED.map((s) => (
            <li key={s.title}>
              <h3 className="pr-h4">{s.title}</h3>
              <p>{s.body}</p>
            </li>
          ))}
        </ul>
      </section>

      <nav className="pr-tools" aria-labelledby="pr-also">
        <h2 id="pr-also" className="eyebrow">
          Also in the app
        </h2>
        <ul>
          {TOOLS.map((t) => (
            <li key={t.id}>
              <Link to={t.to}>
                <span className="pr-tool-name">
                  {t.name} <span aria-hidden="true">→</span>
                </span>
                <span className="pr-tool-line">{t.tagline}</span>
              </Link>
            </li>
          ))}
        </ul>
      </nav>
    </div>
  );
}

function Detail({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="pr-detail">
      <p className="pr-label">{label}</p>
      {children}
    </div>
  );
}

function Featured({ p }: { p: Product }) {
  return (
    <section className="pr-feature" aria-labelledby={`pr-${p.id}`}>
      <div className="pr-feature-main">
        <div className="pr-feature-top">
          <span className="pr-badge" data-status={p.status}>
            {STATUS_LABEL[p.status]}
          </span>
        </div>
        <h2 id={`pr-${p.id}`} className="pr-feature-name">
          {p.name}
        </h2>
        <p className="pr-feature-tag">{p.tagline}</p>
        <p className="pr-summary">{p.summary}</p>
        <Detail label="The orders">
          <ol className="pr-steps">
            {p.orders.map((o) => (
              <li key={o}>{o}</li>
            ))}
          </ol>
        </Detail>
        <Detail label="When it pays">
          <p>{p.pays}</p>
        </Detail>
        {p.to && (
          <Link to={p.to} className="btn btn-primary pr-cta">
            Build a bet
          </Link>
        )}
      </div>

      <figure className="pr-figure">
        <div className="pr-figure-head">
          <span className="pr-label">Result by closing price</span>
          <span className="pr-label pr-illus">Illustrative</span>
        </div>
        <PayoffDiagram />
        <figcaption className="fine">Below the lower price your stake comes back. Between the two you lose it. At or above the higher price you win.</figcaption>
      </figure>
    </section>
  );
}

/** Stake back below the lower price, lose between the two prices, win at or above the higher one. Not to scale, not a real market. */
function PayoffDiagram() {
  // viewBox 320 x 188. Zero line (stake back) at y 94; win level above it, loss level below.
  const x0 = 16;
  const xa = 112;
  const xb = 216;
  const x1 = 304;
  const yWin = 40;
  const yZero = 94;
  const yLose = 148;
  return (
    <svg className="pr-svg" viewBox="0 0 320 188" role="img" aria-label="Illustrative payoff. Below the lower price the result is zero, your stake back. Between the lower and higher price it is a loss of the stake. At or above the higher price it is a win.">
      <line className="pr-axis" x1={x0} x2={x1} y1={yZero} y2={yZero} strokeDasharray="2 4" />
      <line className="pr-guide" x1={xa} x2={xa} y1={yWin - 8} y2={172} />
      <line className="pr-guide" x1={xb} x2={xb} y1={yWin - 8} y2={172} />

      <path className="pr-step pr-step-back" d={`M${x0} ${yZero} H${xa}`} />
      <path className="pr-step pr-step-lose" d={`M${xa} ${yZero} V${yLose} H${xb}`} />
      <path className="pr-step pr-step-win" d={`M${xb} ${yLose} V${yWin} H${x1}`} />

      <text className="pr-t" x={(x0 + xa) / 2} y={yZero - 10} textAnchor="middle">
        Stake back
      </text>
      <text className="pr-t" x={(xa + xb) / 2} y={yLose + 20} textAnchor="middle">
        Lose
      </text>
      <text className="pr-t" x={(xb + x1) / 2} y={yWin - 10} textAnchor="middle">
        Win
      </text>
      <text className="pr-t pr-t-axis" x={xa} y={184} textAnchor="middle">
        Lower price
      </text>
      <text className="pr-t pr-t-axis" x={xb} y={184} textAnchor="middle">
        Higher price
      </text>
    </svg>
  );
}
