import { Link } from 'react-router-dom';
import ProbBar from '../components/ProbBar';

/** A fixed, labelled example: it explains the product without needing a live market. */
function Example() {
  return (
    <div className="card example" aria-label="Example bet">
      <span className="eyebrow">Example</span>
      <h2 className="q-sentence">
        Given <em>$62,500</em> or above, will BTC reach <em>$64,000</em>?
      </h2>
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
      <p className="fine">A $10 stake at 51¢ per $1. The odds are the market’s own.</p>
    </div>
  );
}

export default function Landing() {
  return (
    <>
      <section className="hero">
        <div className="wrap hero-in">
          <div className="hero-copy">
            <span className="eyebrow">Prediction markets, with a safety net</span>
            <h1 className="h-hero">Bet on the second half of your hunch</h1>
            <p className="lede lede-lg">If the first half doesn’t happen, you get your money back. You only lose when the first half is right and the second half isn’t.</p>
            <div className="row-actions">
              <Link to="/app" className="btn btn-primary btn-lg">
                Build a bet
              </Link>
              <a href="#how" className="btn btn-ghost btn-lg">
                How it works
              </a>
            </div>
          </div>
          <Example />
        </div>
      </section>

      <section className="band band-dark" id="how">
        <div className="wrap">
          <h2 className="h-section">Two prices, three outcomes</h2>
          <p className="lede">Every bet is built from two real orders on Gemini, in your own account. Nothing is held anywhere else.</p>
          <div className="trio">
            <article>
              <span className="num">1</span>
              <h3>Choose the first half</h3>
              <p>Pick a price that has to hold, like Bitcoin finishing the hour at $62,500 or above.</p>
            </article>
            <article>
              <span className="num">2</span>
              <h3>Choose the second half</h3>
              <p>Pick the higher price you are betting on. We show the odds, the fair price and what you actually pay.</p>
            </article>
            <article>
              <span className="num">3</span>
              <h3>Win, get it back, or lose</h3>
              <p>Reach the second price and you win. Miss the first and your stake comes back. Hold the first but fall short and you lose it.</p>
            </article>
          </div>
        </div>
      </section>

      <section className="band">
        <div className="wrap split">
          <div>
            <h2 className="h-section">We show you the cost</h2>
            <p className="lede">Two orders cost a little more than the fair price, and we say so before you bet. If a pair is poor value, we won’t offer it.</p>
            <ul className="ticks">
              <li>The market’s chance that both happen</li>
              <li>The fair price, with no spread and no fees</li>
              <li>What you pay, spread and fees included</li>
              <li>What you would get if you sold right away</li>
            </ul>
          </div>
          <div className="card quad" aria-label="The four numbers on every quote">
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
            <p className="fine">Example quote.</p>
          </div>
        </div>
      </section>

      <section className="band band-dark">
        <div className="wrap split">
          <div>
            <h2 className="h-section">Proof, not promises</h2>
            <p className="lede">Each call is fingerprinted on Solana the moment you bet, so nobody can claim afterwards that they saw it coming. You choose whether to reveal it.</p>
            <Link to="/proof" className="btn btn-accent-line">
              See the proof page
            </Link>
          </div>
          <ul className="proof-list">
            <li>
              <b>Committed</b>
              <span>A hash goes on chain when you bet. It shows nothing about the bet.</span>
            </li>
            <li>
              <b>Revealed</b>
              <span>After the result, show the call and it counts on the leaderboard.</span>
            </li>
            <li>
              <b>Reconciled</b>
              <span>Our records are checked against Gemini’s orders and cash, to the cent.</span>
            </li>
          </ul>
        </div>
      </section>
    </>
  );
}
