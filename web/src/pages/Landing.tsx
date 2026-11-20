import { useEffect, useRef, useState, type PointerEvent, type ReactNode } from 'react';
import { Link, useOutletContext } from 'react-router-dom';
import ProbBar from '../components/ProbBar';
import ProductShowcase from '../components/ProductShowcase';
import Reveal from '../components/Reveal';
import { MY_BETS, PRODUCTS } from '../lib/nav';
import { keepMode, type VenueNote } from '../lib/venue';
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
  question: ReactNode;
  zones: readonly Zone[];
  cost: string;
}

/** The same two prices as two different bets. The figures are worked from one set of example odds, and labelled as an example. */
const EXAMPLES: readonly Example[] = [
  {
    id: 'parlay',
    name: 'Return Parlay',
    question: (
      <>
        Given <em>{dollars(FIRST)}</em> or above, will Bitcoin reach <em>{dollars(SECOND)}</em>?
      </>
    ),
    zones: [
      { kind: 'back', from: LOW, to: FIRST, amount: 'Stake back', when: `Below ${dollars(FIRST)}`, say: 'you get your $10 back', why: 'The first half failed, so your stake comes back.' },
      { kind: 'lose', from: FIRST, to: SECOND, amount: '−$10.00', when: `${dollars(FIRST)} to ${dollars(SECOND)}`, say: 'you lose $10.00', why: 'The first half held and the second didn’t. This is the only way you lose.' },
      { kind: 'win', from: SECOND, to: HIGH, amount: '+$9.61', when: `${dollars(SECOND)} and up`, say: 'you win $9.61', why: 'Both halves happened, so the bet pays.' },
    ],
    cost: 'You pay 51¢ per $1 of payout; the fair price is 45¢ and the rest is spread and fees.',
  },
  {
    id: 'range',
    name: 'Range',
    question: (
      <>
        Will Bitcoin finish between <em>{dollars(FIRST)}</em> and <em>{dollars(SECOND)}</em>?
      </>
    ),
    zones: [
      { kind: 'lose', from: LOW, to: FIRST, amount: '−$3.42', when: `Below ${dollars(FIRST)}`, say: 'you lose $3.42', why: 'It finished under the range. $6.58 of your $10 still comes back.' },
      { kind: 'win', from: FIRST, to: SECOND, amount: '+$3.16', when: `${dollars(FIRST)} to ${dollars(SECOND)}`, say: 'you win $3.16', why: 'It finished inside the range, so the bet pays.' },
      { kind: 'lose', from: SECOND, to: HIGH, amount: '−$3.42', when: `${dollars(SECOND)} and up`, say: 'you lose $3.42', why: 'It finished over the range. $6.58 of your $10 still comes back.' },
    ],
    cost: 'At least one of its two orders pays at settlement, so $6.58 of your $10 comes back either way. You pay $1.52 for a pair that is fairly worth $1.48.',
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
function PriceLine() {
  const [which, setWhich] = useState<Example['id']>('parlay');
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

  return (
    <div className="line" data-zone={now.kind}>
      <div className="line-head">
        <p className="line-q">{ex.question}</p>
        <div className="line-pick" role="radiogroup" aria-label="Which bet to draw">
          {EXAMPLES.map((e) => (
            <button
              key={e.id}
              type="button"
              role="radio"
              aria-checked={e.id === which}
              className={e.id === which ? 'is-on' : undefined}
              onClick={() => {
                touched.current = true;
                setWhich(e.id);
              }}
            >
              {e.name}
            </button>
          ))}
        </div>
      </div>

      <div className="line-track" ref={track} onPointerMove={follow}>
        <ol className="line-zones" aria-hidden="true">
          {ex.zones.map((z, i) => (
            <li key={`${ex.id}-${i}`} data-kind={z.kind} data-on={i === index ? '' : undefined} style={{ flexGrow: z.to - z.from }}>
              <b>{z.amount}</b>
              <span>{z.when}</span>
            </li>
          ))}
        </ol>
        <div className="line-marker" style={{ left: at(price) }} aria-hidden="true">
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

      <div className="line-foot">
        {/* Not a live region: the slider already speaks the price and the result as it moves, and the opening tour would say
            it over and over. */}
        <p className="line-result">
          Bitcoin finishes at {dollars(price)}: <b>{now.say}</b>. <span>{now.why}</span>
        </p>
        <p className="fine">An example with a $10 stake. {ex.cost}</p>
      </div>
    </div>
  );
}

/**
 * A stage: the dotted panel a piece of the product is shown on. The dots under the pointer light up, a little way out, so the
 * panel answers the hand without anything on it moving.
 */
function Stage({ children, className }: { children: ReactNode; className?: string }) {
  const light = (e: PointerEvent<HTMLDivElement>) => {
    if (e.pointerType !== 'mouse') return;
    const box = e.currentTarget.getBoundingClientRect();
    e.currentTarget.style.setProperty('--mx', `${e.clientX - box.left}px`);
    e.currentTarget.style.setProperty('--my', `${e.clientY - box.top}px`);
  };
  return (
    <div className={['stage', className].filter(Boolean).join(' ')} onPointerMove={light}>
      {children}
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
          <b>Buy YES at {dollars(SECOND)}</b>
          <p>The bet itself. It pays if BTC finishes at or above {dollars(SECOND)}.</p>
        </li>
        <li>
          <span className="order-n">Order 2</span>
          <b>Buy NO at {dollars(FIRST)}</b>
          <p>The refund. It’s sized to pay your stake back if BTC finishes below {dollars(FIRST)}.</p>
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
      <div role="img" aria-label="Bars show the market’s chance of finishing in each price band. A line over them shows a view that the price finishes higher than the market thinks, and is surer of it.">
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

export default function Landing() {
  // What this copy of the app is really talking to, from the shell. The first screen says it in so many words.
  const venue = useOutletContext<VenueNote | undefined>();
  return (
    <div className="landing">
      {/* The first screen is the idea itself: the sentence, and the bet drawn so you can try it. The way into the app is in
          the bar above and at the foot of the page, after the idea has been explained. */}
      <section className="hero">
        <div className="wrap">
          <h1 className="hero-title" style={{ ['--i' as string]: 0 }}>
            Bet on the second half of your hunch. <span className="dim">If the first half doesn’t happen, you get your stake back.</span>
          </h1>
          <div className="hero-stage" style={{ ['--i' as string]: 1 }}>
            <Stage>
              <div className="stage-panel">
                <PriceLine />
              </div>
            </Stage>
          </div>
          <p className="fine hero-note" style={{ ['--i' as string]: 2 }}>
            {venue?.about} Not affiliated with Gemini.
          </p>
        </div>
      </section>

      <section className="band" id="how">
        <div className="wrap split">
          <Reveal>
            <span className="step-n">01</span>
            <h2 className="h-section">
              Two prices, three outcomes. <span className="dim">One order is the bet. The other pays your stake back if the first half fails.</span>
            </h2>
            <ul className="ticks">
              <li>You only lose when the first half holds and the second half doesn’t</li>
              <li>It works for a fall as well as a rise</li>
              <li>Both are ordinary orders, sent through Gemini’s API. We pool nothing and never hold your money</li>
              <li>If the second order can’t be placed, the first is sold straight back</li>
            </ul>
          </Reveal>
          <Reveal delay={120}>
            <Stage>
              <Orders />
            </Stage>
          </Reveal>
        </div>
      </section>

      <section className="band" id="cost">
        <div className="wrap split flip">
          <Reveal>
            <span className="step-n">02</span>
            <h2 className="h-section">
              You see the cost before you bet. <span className="dim">Two orders cost a little more than the fair price, and every quote shows the gap.</span>
            </h2>
            <ul className="ticks">
              <li>The market’s chance that both halves happen</li>
              <li>The fair price, with no spread and no fees</li>
              <li>What you pay, with spread and fees included</li>
              <li>What you’d get back if you sold right away</li>
            </ul>
            <p className="fine band-note">If a pair is poor value, we don’t offer it.</p>
            <p className="fine band-note">
              That last number is a real way out. You can cash out an open bet from <Link to={keepMode(MY_BETS.to)}>{MY_BETS.name}</Link> before the market settles, for what the market pays at that
              moment. It can be less than you put in.
            </p>
          </Reveal>
          <Reveal delay={120}>
            <Stage>
              <div className="card quad" role="group" aria-label="The four numbers on every quote">
                <span className="ticket-kicker">The four numbers on every quote</span>
                <dl className="nums">
                  <div>
                    <dt>Chance both happen</dt>
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
                    <dt>Sell back now, per $100</dt>
                    <dd>$91</dd>
                  </div>
                </dl>
                <p className="fine">Example quote, the same bet as above.</p>
              </div>
            </Stage>
          </Reveal>
        </div>
      </section>

      <section className="band" id="proof">
        <div className="wrap split">
          <Reveal>
            <span className="step-n">03</span>
            <h2 className="h-section">
              Your call is on the record before the result. <span className="dim">Sealed on Solana when you bet, revealed when you choose.</span>
            </h2>
            <p className="lede">It shows nothing about the bet until you reveal it, and nobody can add a call after the fact.</p>
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
                <b>Sealed when you bet</b>
                <span>A hash of your call goes on Solana. Nobody can read the bet from it.</span>
              </li>
              <li>
                <b>Revealed when you choose</b>
                <span>After the result, show the call. The leaderboard ranks revealed calls by their edge over the market’s own odds.</span>
              </li>
              <li>
                <b>Counted both ways</b>
                <span>The board shows how many calls each player sealed beside how many they revealed, so a record can’t be built by revealing only the winners.</span>
              </li>
              <li>
                <b>Read from Solana</b>
                <span>Your own browser can re-read the board straight from the Solana program, without asking our server.</span>
              </li>
              <li>
                <b>Checked against the exchange</b>
                <span>Our records are compared with the exchange’s orders and cash, to the cent.</span>
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
            <h2 className="h-section">
              Or start from what you think. <span className="dim">Say where the price finishes and how sure you are.</span>
            </h2>
            <p className="lede">Hunch lists the bets on offer that pay best if you’re right, with what each one costs. Agree with the market and it lists nothing.</p>
            <div className="row-actions">
              <Link to={keepMode('/hunch')} className="btn btn-ghost btn-split">
                Try a hunch
                <Arrow />
              </Link>
            </div>
          </Reveal>
          <Reveal delay={120}>
            <Stage>
              <HunchFigure />
            </Stage>
          </Reveal>
        </div>
      </section>

      <section className="closing">
        <Reveal className="wrap">
          <div className="closing-in">
            <h2 className="closing-title">
              Bet on the half you believe in. <span className="dim">Pick two prices, see what it costs, and place it.</span>
            </h2>
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
