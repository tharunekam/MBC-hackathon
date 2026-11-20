import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { Link } from 'react-router-dom';
import ProbBar from '../components/ProbBar';
import ProductShowcase from '../components/ProductShowcase';
import Reveal from '../components/Reveal';
import { MY_BETS, PRODUCTS } from '../lib/nav';
import { keepMode, useVenue } from '../lib/venue';
import '../styles/landing.css';

/** The product the page explains in detail; all four shapes are introduced once the idea has been. */
const PARLAY = PRODUCTS[0]!;

// One example runs through the whole page: a $10 stake on Bitcoin, with $62,500 and $64,000 as its two prices.
const LOW = 61500;
const HIGH = 65000;
const FIRST = 62500;
const SECOND = 64000;
const span = HIGH - LOW;
const at = (v: number) => `${(((v - LOW) / span) * 100).toFixed(2)}%`;
const dollars = (v: number) => `$${v.toLocaleString('en-US')}`;

type Kind = 'back' | 'lose' | 'win';
interface Zone {
  kind: Kind;
  from: number;
  to: number;
  amount: string;
  when: string;
  say: string;
  why: string;
}
interface Example {
  id: 'parlay' | 'range';
  name: string;
  /** The line under the headline; it says what the chosen bet does, so the page never promises a stake back the picture does not show. */
  sub: string;
  zones: readonly Zone[];
}

/** The same two prices as two different bets. The figures are worked from one set of example odds, and labelled as an example. */
const EXAMPLES: readonly Example[] = [
  {
    id: 'parlay',
    name: 'Stake Back',
    sub: 'If the first half doesn’t happen, you get your stake back',
    zones: [
      { kind: 'back', from: LOW, to: FIRST, amount: 'Stake back', when: `Below ${dollars(FIRST)}`, say: 'you get your $10 back', why: 'The first level failed, so your stake comes back.' },
      { kind: 'lose', from: FIRST, to: SECOND, amount: '−$10.00', when: `${dollars(FIRST)} to ${dollars(SECOND)}`, say: 'you lose $10.00', why: 'The first level held and the target was missed. This is the only way you lose.' },
      { kind: 'win', from: SECOND, to: HIGH, amount: '+$9.61', when: `${dollars(SECOND)} and up`, say: 'you win $9.61', why: 'The target was reached, so the bet pays.' },
    ],
  },
  {
    id: 'range',
    name: 'Range',
    sub: 'Win if the price finishes between two levels',
    zones: [
      { kind: 'lose', from: LOW, to: FIRST, amount: '−$3.42', when: `Below ${dollars(FIRST)}`, say: 'you lose $3.42', why: 'It finished under the range. $6.58 of your $10 still comes back.' },
      { kind: 'win', from: FIRST, to: SECOND, amount: '+$3.16', when: `${dollars(FIRST)} to ${dollars(SECOND)}`, say: 'you win $3.16', why: 'It finished inside the range, so the bet pays.' },
      { kind: 'lose', from: SECOND, to: HIGH, amount: '−$3.42', when: `${dollars(SECOND)} and up`, say: 'you lose $3.42', why: 'It finished over the range. $6.58 of your $10 still comes back.' },
    ],
  },
];

/** True when the page may move on its own: not for a reader who asked for less motion, and not in the settled `?still` view. */
const mayAnimate = () =>
  typeof window !== 'undefined' && !document.documentElement.dataset.still && !window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// Where the marker travels when the page opens: out through each outcome and back to the one this product is named for.
const TOUR = [62300, 63250, 64450, 62300];
const TOUR_MS = 3200;
const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

/**
 * The first screen's instrument: a bet drawn on one price line. The line is cut at the bet's two prices into its outcomes, and
 * the marker shows which one the finishing price lands in. It follows the pointer, takes a drag on a phone and the arrow keys
 * on a keyboard, and when the page opens it runs through the outcomes once by itself. Example numbers, and labelled so.
 */
function PriceLine({ which, setWhich }: { which: Example['id']; setWhich: (id: Example['id']) => void }) {
  const [price, setPrice] = useState(TOUR[0]!);
  const touched = useRef(false);
  const track = useRef<HTMLDivElement>(null);
  const ex = EXAMPLES.find((e) => e.id === which)!;
  const index = ex.zones.findIndex((z, i) => price >= z.from && (price < z.to || i === ex.zones.length - 1));
  const now = ex.zones[index]!;

  // The opening tour. Any touch of the line ends it for good.
  useEffect(() => {
    if (!mayAnimate()) return;
    let raf = 0;
    const t0 = performance.now() + 900;
    const legs = TOUR.length - 1;
    const step = (t: number) => {
      if (touched.current) return;
      const p = Math.min(1, Math.max(0, (t - t0) / TOUR_MS));
      const leg = Math.min(legs - 1, Math.floor(p * legs));
      const k = ease(p * legs - leg);
      const v = TOUR[leg]! + (TOUR[leg + 1]! - TOUR[leg]!) * k;
      setPrice(Math.round(v / 50) * 50);
      if (p < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, []);

  const take = (v: number) => {
    touched.current = true;
    setPrice(Math.min(HIGH, Math.max(LOW, Math.round(v / 50) * 50)));
  };
  // With a mouse the marker simply follows the pointer along the line; no press needed.
  const follow = (e: PointerEvent<HTMLDivElement>) => {
    if (e.pointerType !== 'mouse' || !track.current) return;
    const box = track.current.getBoundingClientRect();
    take(LOW + ((e.clientX - box.left) / box.width) * span);
  };

  const choose = (id: Example['id']) => {
    touched.current = true;
    setWhich(id);
  };
  // A radio group is one Tab stop; the arrow keys move the choice and the focus together, Home and End jump to the ends.
  const pickKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const cur = EXAMPLES.findIndex((x) => x.id === which);
    const to = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? cur + 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? cur - 1 : e.key === 'Home' ? 0 : e.key === 'End' ? EXAMPLES.length - 1 : null;
    if (to === null) return;
    e.preventDefault();
    const next = EXAMPLES[(to + EXAMPLES.length) % EXAMPLES.length]!;
    choose(next.id);
    e.currentTarget.querySelectorAll<HTMLButtonElement>('button')[EXAMPLES.indexOf(next)]?.focus();
  };

  // Near either end the price label leans away from the handle, so it stays on the line instead of running off the screen.
  const frac = (price - LOW) / span;
  const lean = frac < 0.12 ? (frac / 0.12) * 50 : frac > 0.88 ? 100 - ((1 - frac) / 0.12) * 50 : 50;

  return (
    <div className="line" data-zone={now.kind}>
      <div className="line-head">
        <div className="line-pick" role="radiogroup" aria-label="Which bet to draw" onKeyDown={pickKey}>
          {EXAMPLES.map((e) => (
            <button
              key={e.id}
              type="button"
              role="radio"
              aria-checked={e.id === which}
              tabIndex={e.id === which ? 0 : -1}
              className={e.id === which ? 'is-on' : undefined}
              onClick={() => choose(e.id)}
            >
              {e.name}
            </button>
          ))}
        </div>
        <p className="line-eg">Example: $10 on Bitcoin, drag to move where it finishes</p>
      </div>

      {/* The line itself: three thin segments and a handle. What each segment pays is written under it. */}
      <div className="line-body" ref={track} onPointerMove={follow}>
        <div className="line-track">
          <div className="line-segs" aria-hidden="true">
            {ex.zones.map((z, i) => (
              <i key={`${ex.id}-${i}`} data-kind={z.kind} data-on={i === index ? '' : undefined} style={{ flexGrow: z.to - z.from }} />
            ))}
          </div>
          <div className="line-marker" style={{ left: at(price), ['--lean' as string]: `${lean.toFixed(1)}%` }} aria-hidden="true">
            <output>{dollars(price)}</output>
          </div>
          <input
            id="line-range"
            type="range"
            min={LOW}
            max={HIGH}
            step={50}
            value={price}
            onChange={(e) => take(Number(e.target.value))}
            aria-label="Where Bitcoin finishes"
            aria-valuetext={`${dollars(price)}: ${now.say}`}
          />
        </div>
        <ol className="line-zones" aria-hidden="true">
          {ex.zones.map((z, i) => (
            <li key={`${ex.id}-${i}`} data-kind={z.kind} data-on={i === index ? '' : undefined} style={{ flexGrow: z.to - z.from }}>
              <b>{z.amount}</b>
              <span>{z.when}</span>
            </li>
          ))}
        </ol>
      </div>

      {/* The outcome is read off the line itself; the sentence is kept for screen readers. Not a live region: the slider
          already speaks the price and the result as it moves. */}
      <p className="sr-only">
        Bitcoin finishes at {dollars(price)}: {now.say}. {now.why}
      </p>
    </div>
  );
}

/** The two orders behind the example, and how the market's own odds split the three outcomes. */
function Orders() {
  return (
    <div className="card orders" role="group" aria-label="The two orders in the example bet">
      <ol className="order-slips">
        <li>
          <span className="order-n">Order 1</span>
          <b>Bet that it reaches {dollars(SECOND)}</b>
          <p>The bet itself. It pays if Bitcoin finishes at or above {dollars(SECOND)}.</p>
        </li>
        <li>
          <span className="order-n">Order 2</span>
          <b>Stake back if it stays below {dollars(FIRST)}</b>
          <p>Sized to pay your stake back if Bitcoin finishes below {dollars(FIRST)}.</p>
        </li>
      </ol>
      <div className="orders-odds">
        <span className="ticket-kicker">How the market’s odds split the three outcomes</span>
        <ProbBar chanceCondition={0.88} chanceBoth={0.4} />
      </div>
    </div>
  );
}

// A made-up market and a made-up view of it, each adding to 100%. The view sits higher than the market and is surer of itself.
const MARKET = [0.02, 0.05, 0.11, 0.19, 0.24, 0.19, 0.11, 0.06, 0.03];
const VIEW = [0, 0.01, 0.03, 0.09, 0.2, 0.31, 0.23, 0.1, 0.03];

/** Hunch in one picture, drawn the way the Hunch page draws it: bars for the market, a stepped line for your view. */
function HunchFigure() {
  const W = 360;
  const left = 4;
  const top = 10;
  const base = 126;
  const slot = (W - left * 2) / MARKET.length;
  const yOf = (p: number) => base - (p / 0.34) * (base - top);
  const xOf = (i: number) => left + i * slot;
  const view = VIEW.map((p, i) => `${i === 0 ? 'M' : 'L'}${xOf(i).toFixed(1)},${yOf(p).toFixed(1)}H${xOf(i + 1).toFixed(1)}`).join('');
  return (
    <div className="card hunch-demo" role="group" aria-label="Your view against the market’s">
      <span className="ticket-kicker">Your view against the market’s</span>
      <div role="img" aria-label="Bars show the market’s chance of finishing in each price band. A line over them shows a view that the price finishes higher, and with more certainty.">
        <svg className="hunch-fig" viewBox={`0 0 ${W} 132`} aria-hidden="true" focusable="false">
          {MARKET.map((p, i) => (
            <rect key={i} className="hf-bar" x={xOf(i) + 2} y={yOf(p)} width={slot - 4} height={base - yOf(p)} rx={2} />
          ))}
          <line className="hf-base" x1={left} x2={W - left} y1={base + 0.5} y2={base + 0.5} />
          <path className="hf-view" pathLength={1} d={view} />
        </svg>
        <div className="hf-axis">
          <span>Lower</span>
          <span>Where the price finishes</span>
          <span>Higher</span>
        </div>
      </div>
      <div className="hf-keys">
        <span>
          <i /> The market
        </span>
        <span data-kind="view">
          <i /> Your view
        </span>
      </div>
      <p className="fine">An illustration. On the Hunch page the bars come from the market’s own prices and the line follows your two dials.</p>
    </div>
  );
}

const Arrow = () => (
  <span className="btn-arrow" aria-hidden="true">
    <span>→</span>
  </span>
);

/** The first screen: the sentence, a way in, and the bet drawn so you can try it. The sentence follows the bet that is drawn. */
function Hero() {
  const [which, setWhich] = useState<Example['id']>('parlay');
  const ex = EXAMPLES.find((e) => e.id === which)!;
  return (
    <section className="hero">
      <div className="wrap">
        <h1 className="hero-title" style={{ ['--i' as string]: 0 }}>
          Bet the second half
        </h1>
        <p className="hero-sub" style={{ ['--i' as string]: 0 }}>
          {ex.sub}
        </p>
        <div className="hero-cta" style={{ ['--i' as string]: 1 }}>
          <Link to={keepMode(PARLAY.to)} className="btn btn-accent btn-lg btn-split">
            Build a bet
            <Arrow />
          </Link>
        </div>
        <div className="hero-line" style={{ ['--i' as string]: 2 }}>
          <PriceLine which={which} setWhich={setWhich} />
        </div>
      </div>
    </section>
  );
}

export default function Landing() {
  // Only for the one sentence that names Gemini: on the local test exchange it would not be true.
  const venue = useVenue();
  return (
    <div className="landing">
      <Hero />

      <section className="band" id="how">
        <div className="wrap split">
          <Reveal>
            <span className="step-n">01</span>
            <h2 className="h-section">Two levels, three outcomes</h2>
            <p className="h-sub">One order is the bet. The other pays your stake back if the first level fails</p>
            {/* The one place the hero's halves are tied to the words the rest of the app uses. */}
            <p className="lede">The first half is a first level the price must hold. The second half is the target it must reach.</p>
            <ul className="ticks">
              <li>You only lose when the first level holds and the target is missed</li>
              <li>You can bet on a rise or on a fall</li>
              <li>{venue.standIn ? 'Both are ordinary orders, placed here on a local test exchange that stands in for Gemini' : 'Both are ordinary orders placed through Gemini’s API, in your own account'}</li>
              <li>If the second order can’t be placed, the first is sold back right away</li>
            </ul>
          </Reveal>
          <Reveal delay={120}>
            <Orders />
          </Reveal>
        </div>
      </section>

      <section className="band" id="cost">
        <div className="wrap split flip">
          <Reveal>
            <span className="step-n">02</span>
            <h2 className="h-section">You see the cost before you bet</h2>
            <p className="h-sub">Two orders cost a little more than the fair price, and every quote shows the gap</p>
            <ul className="ticks">
              <li>
                <b>Chance of winning</b>: the market’s chance that you win
              </li>
              <li>
                <b>Fair price per $1</b>: the market’s price before any extra cost
              </li>
              <li>
                <b>You pay per $1</b>: that price plus fees and the gap between buy and sell
              </li>
              <li>
                <b>Sell back now per $100</b>: what you’d get if you sold right away
              </li>
            </ul>
            <p className="fine band-note">A bet priced far above its fair price is not offered.</p>
            <p className="fine band-note">
              You can cash out an open bet from <Link to={keepMode(MY_BETS.to)}>{MY_BETS.name}</Link> before the market closes, for what the market pays at
              that moment. It can be less than you put in.
            </p>
          </Reveal>
          <Reveal delay={120}>
            <div className="card quad" role="group" aria-label="The four numbers on every quote">
              <span className="ticket-kicker">The four numbers on every quote</span>
              <dl className="nums">
                <div>
                  <dt>Chance of winning</dt>
                  <dd>40%</dd>
                </div>
                <div>
                  <dt>Fair price per $1</dt>
                  <dd>45¢</dd>
                </div>
                <div>
                  <dt>You pay per $1</dt>
                  <dd>51¢</dd>
                </div>
                <div>
                  <dt>Sell back now per $100</dt>
                  <dd>$91</dd>
                </div>
              </dl>
              <p className="fine">Example quote, the same bet as above</p>
            </div>
          </Reveal>
        </div>
      </section>

      <section className="band" id="proof">
        <div className="wrap split">
          <Reveal>
            <span className="step-n">03</span>
            <h2 className="h-section">Your call is on the record before the result</h2>
            <p className="h-sub">Nobody can add a call after the fact</p>
            <div className="row-actions">
              <Link to={keepMode('/leaderboard')} className="btn btn-ghost">
                See the leaderboard
              </Link>
              <Link to={keepMode('/proof')} className="btn btn-ghost btn-split">
                Open Proof
                <Arrow />
              </Link>
            </div>
          </Reveal>
          <Reveal delay={120}>
            <ol className="proof-list">
              <li>
                <b>You seal your call when you bet</b>
                <span>A sealed code of your call goes on Solana. Nobody can read the bet from it.</span>
              </li>
              <li>
                <b>You reveal it after the result</b>
                <span>Show the call and it joins the leaderboard, ranked by edge. Edge is how far a call beat the market’s own price, per $1.</span>
              </li>
              <li>
                <b>Anyone can check it on Solana</b>
                <span>The leaderboard counts sealed calls beside revealed ones, so a player who reveals only some of their calls shows it. The Proof page also compares our records with the exchange.</span>
              </li>
            </ol>
          </Reveal>
        </div>
      </section>

      <section className="band" id="products">
        <ProductShowcase />
      </section>

      <section className="band" id="hunch">
        <div className="wrap split flip">
          <Reveal>
            <h2 className="h-section">Start from what you think</h2>
            <p className="h-sub">Say where the price finishes and how sure you are</p>
            <p className="lede">Hunch lists the bets on offer that cost less than your view says they are worth, with what each one costs. Agree with the market and it lists nothing.</p>
            <div className="row-actions">
              <Link to={keepMode('/hunch')} className="btn btn-ghost btn-split">
                Try a hunch
                <Arrow />
              </Link>
            </div>
          </Reveal>
          <Reveal delay={120}>
            <HunchFigure />
          </Reveal>
        </div>
      </section>

      <section className="closing">
        <Reveal className="wrap">
          <div className="closing-in">
            <div className="closing-text">
              <h2 className="closing-title">Bet on the price you believe in</h2>
              <p className="closing-sub">Pick two levels, see what it costs, and place it</p>
            </div>
            <div className="row-actions">
              <Link to={keepMode(PARLAY.to)} className="btn btn-accent btn-lg btn-split">
                Build a bet
                <Arrow />
              </Link>
              <Link to={keepMode('/hunch')} className="btn btn-ghost btn-lg">
                Start from a hunch
              </Link>
            </div>
          </div>
        </Reveal>
      </section>
    </div>
  );
}
