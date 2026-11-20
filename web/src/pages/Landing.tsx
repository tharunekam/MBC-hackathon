import { useMemo, useState } from 'react';
import { Link, useOutletContext } from 'react-router-dom';
import ProbBar from '../components/ProbBar';
import ProductShowcase from '../components/ProductShowcase';
import Reveal from '../components/Reveal';
import { MY_BETS, PRODUCTS } from '../lib/nav';
import { keepMode, type VenueNote } from '../lib/venue';
import '../styles/landing.css';

/** The product the page goes on to explain in detail; all four shapes are introduced together just under the opening. */
const PARLAY = PRODUCTS[0]!;

/** A fixed, labelled example: it explains the product without needing a live market. */
function Example() {
  return (
    <div className="card example" role="group" aria-label="Example bet">
      <span className="eyebrow">Example</span>
      <h3 className="q-sentence">
        Given <em>$62,500</em> or above, will BTC reach <em>$64,000</em>?
      </h3>
      <ProbBar chanceCondition={0.88} chanceBoth={0.4} />
      <ul className="outcomes">
        <li data-kind="win">
          <span>Reaches $64,000</span>
          <b>+$9.61</b>
        </li>
        <li data-kind="back">
          <span>Falls below $62,500</span>
          <b>Stake back</b>
        </li>
        <li data-kind="lose">
          <span>Holds it, stops short</span>
          <b>−$10.00</b>
        </li>
      </ul>
      <p className="fine">Illustrative: a $10 stake at 51¢ per $1. In the app the odds are the market’s own.</p>
    </div>
  );
}

// The same numbers as the example card above: a $10 stake, first half $62,500, second half $64,000.
const LOW = 61500;
const HIGH = 65000;
const FIRST = 62500;
const SECOND = 64000;
const span = HIGH - LOW;
const at = (v: number) => `${(((v - LOW) / span) * 100).toFixed(2)}%`;
const dollars = (v: number) => `$${v.toLocaleString('en-US')}`;

/** Drag the finishing price and see which of the three outcomes it lands in. Illustrative, and labelled so. */
function Outcomes() {
  const [price, setPrice] = useState(63100);
  const zone = price < FIRST ? 'back' : price < SECOND ? 'lose' : 'win';
  const result = {
    back: { label: 'Stake back', amount: '$0.00 lost', why: `BTC finished below ${dollars(FIRST)}, so the first half failed and your $10 comes back.` },
    lose: { label: 'You lose', amount: '−$10.00', why: `BTC held ${dollars(FIRST)} but stopped short of ${dollars(SECOND)}.` },
    win: { label: 'You win', amount: '+$9.61', why: `BTC held ${dollars(FIRST)} and reached ${dollars(SECOND)}.` },
  }[zone];
  return (
    <div className="card outcomes-demo" role="group" aria-label="Where the bet lands">
      <span className="eyebrow">Where does BTC finish the hour?</span>
      <output className="od-price" htmlFor="od-range">
        {dollars(price)}
      </output>
      <div className="od-track" data-zone={zone}>
        <div className="od-zones" aria-hidden="true">
          <span data-kind="back" style={{ width: at(FIRST) }} />
          <span data-kind="lose" style={{ width: `calc(${at(SECOND)} - ${at(FIRST)})` }} />
          <span data-kind="win" style={{ flex: 1 }} />
        </div>
        <input
          id="od-range"
          type="range"
          min={LOW}
          max={HIGH}
          step={50}
          value={price}
          onChange={(e) => setPrice(Number(e.target.value))}
          aria-label="Where Bitcoin finishes the hour"
          aria-valuetext={`${dollars(price)}: ${result.label}`}
        />
        <div className="od-ticks" aria-hidden="true">
          <span style={{ left: at(FIRST) }}>{dollars(FIRST)}</span>
          <span style={{ left: at(SECOND) }}>{dollars(SECOND)}</span>
        </div>
      </div>
      {/* Not a live region: the slider already speaks the price and the result as it moves, and saying both twice is noise. */}
      <div className="od-result" data-kind={zone}>
        <b>{result.label}</b>
        <span className="od-amount">{result.amount}</span>
        <p>{result.why}</p>
      </div>
      <p className="fine">Illustrative: a $10 stake at 51¢ per $1, the same bet as the example above.</p>
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
    <div className="card hunch-demo">
      <span className="eyebrow">Your view against the market’s</span>
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
      <p className="fine">Illustrative. On the Hunch page the bars come from the market’s own prices and the line follows your two dials.</p>
    </div>
  );
}

/** A few of the curves this app is built on: each line is a market's chance of finishing at or above a price. Decorative only. */
function Ladder() {
  const lines = useMemo(() => {
    const W = 1200;
    const H = 700;
    const N = 22;
    return Array.from({ length: N }, (_, i) => {
      const t = i / (N - 1);
      const centre = 0.22 + t * 0.58;
      const steep = 0.06 + 0.05 * Math.sin(t * Math.PI);
      const pts: string[] = [];
      for (let k = 0; k <= 72; k++) {
        const x = k / 72;
        const y = 1 / (1 + Math.exp((x - centre) / steep));
        pts.push(`${(x * W).toFixed(1)},${(150 + (1 - y) * (H - 280) * (0.8 + 0.2 * t)).toFixed(1)}`);
      }
      const key = i === 7 || i === 15;
      return { d: `M${pts.join('L')}`, key, o: key ? 0.75 : 0.12 + 0.2 * Math.sin(t * Math.PI), delay: 300 + i * 70 };
    });
  }, []);
  return (
    <svg className="ladder" viewBox="0 0 1200 700" preserveAspectRatio="xMidYMid slice" aria-hidden="true" focusable="false">
      <g className="ladder-lines">
        {lines.map((l, i) => (
          <path key={i} d={l.d} pathLength={1} data-key={l.key ? '' : undefined} style={{ opacity: l.o, animationDelay: `${l.delay}ms` }} />
        ))}
      </g>
    </svg>
  );
}

export default function Landing() {
  // What this copy of the app is really talking to, from the shell. The opening says it in so many words.
  const venue = useOutletContext<VenueNote | undefined>();
  return (
    <>
      <section className="hero band-dark">
        <Ladder />
        <div className="hero-body">
          <h1 className="hero-title">
            <span className="hero-mark">Given</span> <span className="hero-tag">Bet on the second half of your hunch</span>
          </h1>
          <p className="hero-sub">
            If the first half doesn’t happen, <b>you get your money back</b>. You see the cost first. Every call is sealed on Solana.
          </p>
          <div className="row-actions">
            <Link to={keepMode(PARLAY.to)} className="btn btn-primary btn-lg">
              Build a bet
            </Link>
            <a href="#story" className="btn btn-ghost btn-lg">
              How it works
            </a>
          </div>
          <p className="hero-note">{venue?.about} Not affiliated with Gemini.</p>
        </div>
        <a href="#products" className="hero-scroll" aria-label="Scroll to the four bets">
          <span>Scroll</span>
          <i aria-hidden="true" />
        </a>
      </section>

      <section className="band" id="products">
        <ProductShowcase />
      </section>

      <section className="band band-follows" id="hunch">
        <div className="wrap split flip">
          <Reveal>
            <span className="eyebrow">Hunch</span>
            <h2 className="h-section">Start from what you think</h2>
            <p className="lede">Not sure which shape fits? Say where you think the price finishes and how sure you are. Hunch lists the bets on offer that pay best if you are right, with what each one costs. Agree with the market and it lists nothing.</p>
            <Link to={keepMode('/hunch')} className="btn btn-ghost">
              Try a hunch
            </Link>
          </Reveal>
          <Reveal delay={120}>
            <HunchFigure />
          </Reveal>
        </div>
      </section>

      <section className="band band-dark" id="story">
        <div className="wrap split">
          <Reveal className="hero-copy">
            <span className="eyebrow">{PARLAY.name}</span>
            <h2 className="h-section">Your stake comes back if the first half fails</h2>
            <p className="lede">A bet has two halves: something that has to hold first, then the thing you are really betting on. You only lose when the first half is right and the second half isn’t. It works for a fall as well as a rise.</p>
            <div className="row-actions">
              <Link to={keepMode(PARLAY.to)} className="btn btn-primary">
                Build a bet
              </Link>
            </div>
          </Reveal>
          <Reveal delay={120}>
            <Example />
          </Reveal>
        </div>
      </section>

      <section className="band" id="how">
        <div className="wrap split flip">
          <Reveal>
            <span className="eyebrow">How it works</span>
            <h2 className="h-section">Two prices, three outcomes</h2>
            <p className="lede">A bet is nothing more than two ordinary orders on a prediction market, sent through Gemini’s API. We pool nothing and issue nothing.</p>
            <ol className="orders-list">
              <li>
                <span>Order 1</span>
                <b>Buy YES at the higher price</b>
                <p>This is the bet itself. If the second half happens, it pays.</p>
              </li>
              <li>
                <span>Order 2</span>
                <b>Buy NO at the lower price</b>
                <p>This is the refund. It is sized so that if the first half fails, it pays your stake back.</p>
              </li>
            </ol>
          </Reveal>
          <Reveal delay={120}>
            <Outcomes />
          </Reveal>
        </div>
      </section>

      <section className="band band-dark" id="cost">
        <div className="wrap split">
          <Reveal>
            <span className="eyebrow">The price</span>
            <h2 className="h-section">We show you the cost</h2>
            <p className="lede">Two orders cost a little more than the fair price, and we say so before you bet. If a pair is poor value, we won’t offer it.</p>
            <ul className="ticks">
              <li>The market’s chance that both happen</li>
              <li>The fair price, with no spread and no fees</li>
              <li>What you pay, spread and fees included</li>
              <li>What you would get if you sold right away</li>
            </ul>
            <p className="band-note">
              That last number is a real way out. You can cash out an open bet from <Link to={keepMode(MY_BETS.to)}>{MY_BETS.name}</Link> before the market settles, for what the market pays at that moment. It can be less than you put in.
            </p>
          </Reveal>
          <Reveal delay={120}>
            <div className="card quad" role="group" aria-label="The four numbers on every quote">
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
              <p className="fine">Illustrative: an example quote for the bet above.</p>
            </div>
          </Reveal>
        </div>
      </section>

      <section className="band" id="proof">
        <div className="wrap split flip">
          <Reveal>
            <span className="eyebrow">The record</span>
            <h2 className="h-section">Every call is on the record</h2>
            <p className="lede">Each call is sealed on Solana the moment you bet, before the result is known, so nobody can claim afterwards that they saw it coming. You choose whether to reveal it.</p>
            <div className="row-actions">
              <Link to={keepMode('/leaderboard')} className="btn btn-ghost">
                See the leaderboard
              </Link>
              <Link to={keepMode('/proof')} className="btn btn-ghost">
                Open Proof
              </Link>
            </div>
          </Reveal>
          <Reveal delay={120}>
            <ul className="proof-list">
              <li>
                <b>Sealed</b>
                <span>A hash goes on chain when you bet. It shows nothing about the bet.</span>
              </li>
              <li>
                <b>Revealed</b>
                <span>After the result, show the call. The leaderboard ranks revealed calls by their edge over the market’s own odds.</span>
              </li>
              <li>
                <b>Counted both ways</b>
                <span>The board shows how many calls each player sealed beside how many they revealed, so a record cannot be built by revealing only the winners.</span>
              </li>
              <li>
                <b>Read from Solana</b>
                <span>Your own browser can re-read the board straight from the Solana program, without asking our server.</span>
              </li>
              <li>
                <b>Reconciled</b>
                <span>Our records are checked against the exchange’s orders and cash, to the cent.</span>
              </li>
            </ul>
          </Reveal>
        </div>
      </section>

      <section className="band band-dark closing">
        <Reveal className="wrap closing-in">
          <h2 className="closing-title">Bet on the half you believe in</h2>
          <p className="lede">Pick a shape and two prices, see every result and what it costs, then place it. On a {PARLAY.name}, your stake comes back if the first half fails.</p>
          <div className="row-actions">
            <Link to={keepMode(PARLAY.to)} className="btn btn-primary btn-lg">
              Build a bet
            </Link>
            <Link to={keepMode('/hunch')} className="btn btn-ghost btn-lg">
              Start from a hunch
            </Link>
          </div>
        </Reveal>
      </section>
    </>
  );
}
