import { Fragment, useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api';
import { ApiError } from '../api/client';
import { explorerTx } from '../api/types';
import { kindLabel } from '../lib/betsView';
import { calledWords, edgeTone, resultWord } from '../lib/callWords';
import { cents, dateTime, edgeText, trunc } from '../lib/format';
import { friendly } from '../lib/friendly';
import { useAsync } from '../lib/hooks';
import { readProblem } from '../lib/programBoard';
import { savePng, shareCardSvg } from '../lib/shareCard';
import { keepMode } from '../lib/venue';
import { callQuestion, solanaRpc, verdictLine, verifyOnChain } from '../lib/verify';
import type { Verification } from '../lib/verify';
import '../styles/bets.css';
import '../styles/proof.css';

const RPC: string = import.meta.env.VITE_SOLANA_RPC ?? 'https://api.devnet.solana.com';

/** A revealed call, as a shareable card, with a button that checks it against Solana from the browser. */
export default function Verify() {
  const { signature = '' } = useParams();
  const call = useAsync(() => api.reveal(signature), [signature]);
  const [result, setResult] = useState<Verification | null>(null);
  const [running, setRunning] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [picture, setPicture] = useState<'idle' | 'saved' | 'failed'>('idle');
  // The two "done" messages put themselves away after a moment; leaving the page must not leave a timer behind.
  const timers = useRef<number[]>([]);
  useEffect(() => () => timers.current.forEach((t) => window.clearTimeout(t)), []);
  const later = (fn: () => void, ms: number) => timers.current.push(window.setTimeout(fn, ms));

  const c = call.data;

  async function run() {
    if (!c) return;
    setRunning(true);
    setProblem(null);
    setResult(null);
    try {
      setResult(await verifyOnChain(solanaRpc(RPC), c.signature, c.authority, c.program));
    } catch (e) {
      // The same words as the leaderboard's own read of Solana: a busy node and an unreachable one are each named, and
      // anything else is the app's own sentence, never what the node said.
      setProblem(readProblem(e));
    } finally {
      setRunning(false);
    }
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setCopied(true);
      later(() => setCopied(false), 1800);
    } catch {
      /* clipboard blocked: the address bar still has the link */
    }
  }

  if (call.loading && !c) {
    return (
      // The heading and two blocks the size of the card and the check, so the page does not jump when the call arrives.
      <div className="page narrow" aria-busy="true">
        <header className="page-head">
          <div>
            <h1 className="h-page">Proof of a call</h1>
          </div>
        </header>
        <div className="skeleton pf-skel-card" aria-label="Loading the call" />
        <div className="skeleton pf-skel-check" />
      </div>
    );
  }
  if (!c) {
    const notFound = call.error instanceof ApiError && call.error.status === 404;
    return (
      <div className="page narrow">
        <div className="pf-empty">
          <h1 className="h-card">{notFound ? 'This call is not public' : 'We could not load this call'}</h1>
          <p>{notFound ? 'It may not exist, or its owner has not revealed it yet.' : call.error ? friendly(call.error) : 'Try again in a moment.'}</p>
          <div className="pc-actions">
            {!notFound && (
              <button type="button" className="btn btn-ghost" onClick={() => call.reload()}>
                Try again
              </button>
            )}
            <Link to={keepMode('/leaderboard')} className="btn btn-ghost">
              Back to the leaderboard
            </Link>
          </div>
        </div>
      </div>
    );
  }

  const won = c.outcome === 1;
  // Everything the card says comes from what was committed on Solana: the bet id names the product.
  const q = callQuestion(c);
  const real = c.network === 'devnet';

  const edge = edgeText(c.edge);
  const finish = calledWords(c);

  /** The card above as a picture to post: the same words and numbers, and where to check them. */
  async function savePicture() {
    if (!c) return;
    try {
      const svg = shareCardSvg({
        handle: c.handle,
        won,
        question: q.text,
        fair: cents(c.fairPrice),
        paid: cents(c.entryPrice),
        edge,
        edgeGood: edgeTone(c.edge) !== 'bad',
        // A picture is posted and read later, so its date carries the year.
        when: new Date(c.revealedAt).toLocaleDateString('en-US', { dateStyle: 'medium' }),
        onSolana: real,
        link: `${window.location.host}${window.location.pathname}`,
      });
      await savePng(svg, `given-${c.handle}-${c.signature.slice(0, 8)}.png`);
      setPicture('saved');
    } catch {
      setPicture('failed');
    }
    later(() => setPicture('idle'), 2200);
  }

  return (
    <div className="page narrow">
      <header className="page-head">
        <div>
          <h1 className="h-page">Proof of a call</h1>
          {/* A seal is claimed only where there is a record to check it against. */}
          <p className="lede">{real ? 'Sealed before it was revealed, and checkable on Solana by anyone' : 'Recorded by Stakeback, not on Solana'}</p>
        </div>
      </header>

      <article className="proofcard" data-outcome={won ? 'won' : 'missed'} data-product={q.kind.product} aria-label="The call">
        <div className="pc-top">
          <span className="pc-who">
            <span className="eyebrow">{c.handle}</span>
            <span className="kind-tag">{kindLabel(q.kind)}</span>
          </span>
          {real && <span className="chip chip-quiet">Recorded on Solana</span>}
        </div>
        {/* The result in the two words the rest of the app uses, then one sentence: where the price finished. */}
        <div className="pc-result">
          <p className="pc-verdict">{resultWord(c.outcome)}</p>
          {finish && <p className="pc-called">{finish}</p>}
        </div>
        <h2 className="q-sentence pc-question">
          {q.parts.map((p, i) => (p.em ? <em key={i}>{p.text}</em> : <Fragment key={i}>{p.text}</Fragment>))}
        </h2>
        <dl className="pc-nums">
          <div>
            <dt>Fair price per $1</dt>
            <dd>{cents(c.fairPrice)}</dd>
          </div>
          <div>
            <dt>You paid per $1</dt>
            <dd>{cents(c.entryPrice)}</dd>
          </div>
          <div>
            <dt>Edge per $1</dt>
            <dd className={edgeTone(c.edge)}>{edge}</dd>
          </div>
        </dl>
        <p className="fine pc-edge">Edge is how far a call beat the market’s own price, per $1.</p>
        <div className="pc-foot">
          <span className="fine">Revealed {dateTime(c.revealedAt)}</span>
          <div className="pc-actions">
            <button type="button" className="btn btn-ghost" onClick={savePicture}>
              {picture === 'saved' ? 'Image saved' : picture === 'failed' ? 'Could not save' : 'Save image'}
            </button>
            <button type="button" className="btn btn-ghost" onClick={copy}>
              {copied ? 'Link copied' : 'Copy link'}
            </button>
            {/* The button's own text is not announced; this is, and it is there before it has anything to say. */}
            <span className="sr-only" role="status">
              {copied ? 'Link copied' : picture === 'saved' ? 'Image saved' : picture === 'failed' ? 'Could not save the image' : ''}
            </span>
          </div>
        </div>
      </article>

      {real ? (
        <section className="verify" aria-labelledby="pf-check">
          <h2 id="pf-check" className="h-card">
            Check it on Solana
          </h2>
          <p>Your browser reads both records from Solana, works out the fingerprint itself and compares when each was written.</p>
          <button type="button" className="btn btn-primary" onClick={run} disabled={running}>
            {running ? (
              <>
                <span className="spin" aria-hidden="true" /> Reading Solana
              </>
            ) : result ? (
              'Check again'
            ) : (
              'Verify on Solana'
            )}
          </button>

          <div className="pc-live" aria-live="polite">
            {problem && (
              <p className="note note-bad" role="alert">
                {problem}
              </p>
            )}

            {result && (
              <>
                <ul className="checks">
                  {result.checks.map((k) => (
                    <li key={k.id} data-ok={k.ok} data-optional={k.optional ? 'true' : undefined}>
                      <span className="mark" aria-hidden="true">
                        {k.ok ? '✓' : k.optional ? '–' : '✕'}
                      </span>
                      <div>
                        <b>
                          {/* The mark is drawn for the eye; this says the same to a screen reader. */}
                          <span className="sr-only">{k.ok ? 'Passed: ' : k.optional ? 'Note: ' : 'Failed: '}</span>
                          {k.label}
                        </b>
                        {k.detail && <p>{k.detail}</p>}
                      </div>
                    </li>
                  ))}
                </ul>
                <p className={`note ${result.ok ? 'note-info' : 'note-bad'}`}>
                  {verdictLine(result)}
                </p>
              </>
            )}
          </div>

          <div className="links">
            <a className="mono-chip link" href={explorerTx(c.commitSignature)} target="_blank" rel="noreferrer">
              Sealed record {trunc(c.commitSignature, 6, 4)} ↗<span className="sr-only"> (opens the Solana explorer in a new tab)</span>
            </a>
            <a className="mono-chip link" href={explorerTx(c.signature)} target="_blank" rel="noreferrer">
              Revealed record {trunc(c.signature, 6, 4)} ↗<span className="sr-only"> (opens the Solana explorer in a new tab)</span>
            </a>
            {/* The explorer links go to Solana's test cluster, and the page says so right beside them. */}
            <span className="fine">Solana devnet</span>
          </div>
          <p className="fine">The fingerprint and the two times show that the call was sealed before it was revealed and not changed. They do not show the result: we report that, with the exchange’s order IDs as evidence.</p>
        </section>
      ) : (
        <p className="fine pf-only">There is no Solana record to check. Stakeback reports this result, with the exchange’s order IDs as evidence.</p>
      )}
    </div>
  );
}
