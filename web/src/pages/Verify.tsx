import { Fragment, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api';
import { ApiError } from '../api/client';
import { explorerTx } from '../api/types';
import { kindLabel } from '../lib/betsView';
import { calledWords, resultWord } from '../lib/callWords';
import { cents, trunc } from '../lib/format';
import { friendly } from '../lib/friendly';
import { useAsync } from '../lib/hooks';
import { readProblem } from '../lib/programBoard';
import { savePng, shareCardSvg } from '../lib/shareCard';
import { keepMode } from '../lib/venue';
import { callQuestion, solanaRpc, verifyOnChain } from '../lib/verify';
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

  const c = call.data;

  async function run() {
    if (!c) return;
    setRunning(true);
    setProblem(null);
    setResult(null);
    try {
      setResult(await verifyOnChain(solanaRpc(RPC), c.signature, c.authority, c.program));
    } catch (e) {
      // The same words as the leaderboard's own read of Solana: a busy node and an unreachable one are each named.
      setProblem(readProblem(e));
    } finally {
      setRunning(false);
    }
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      /* clipboard blocked: the address bar still has the link */
    }
  }

  if (call.loading && !c) {
    return (
      <div className="page narrow" aria-busy="true">
        <h1 className="sr-only">Proof of a call</h1>
        <div className="skeleton row-skel" />
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

  const edgeText = `${c.edge > 0 ? '+' : c.edge < 0 ? '−' : ''}${Math.abs(c.edge).toFixed(2)}`;
  const revealedOn = new Date(c.revealedAt);

  /** The card above as a picture to post: the same words and numbers, and where to check them. */
  async function savePicture() {
    if (!c) return;
    try {
      const svg = shareCardSvg({
        handle: c.handle,
        won,
        question: q.text,
        result: q.result,
        fair: cents(c.fairPrice),
        paid: cents(c.entryPrice),
        edge: edgeText,
        edgeGood: c.edge >= 0,
        when: revealedOn.toLocaleDateString('en-US', { dateStyle: 'medium' }),
        network: real ? 'Solana devnet' : 'Test chain',
        link: `${window.location.host}${window.location.pathname}`,
      });
      await savePng(svg, `given-${c.handle}-${c.signature.slice(0, 8)}.png`);
      setPicture('saved');
    } catch {
      setPicture('failed');
    }
    window.setTimeout(() => setPicture('idle'), 2200);
  }

  return (
    <div className="page narrow">
      <header className="page-head">
        <div>
          <span className="eyebrow">Check a call</span>
          <h1 className="h-page">Proof of a call</h1>
          <p className="lede">{real ? 'Made before the result, and checkable on Solana by anyone.' : 'Made before the result. This one is on a test chain; on Solana devnet anyone can check a call from their own browser.'}</p>
        </div>
      </header>

      <article className="proofcard" data-outcome={won ? 'won' : 'missed'} data-product={q.kind.product} aria-label="The call">
        <div className="pc-top">
          <span className="pc-who">
            <span className="eyebrow">{c.handle}</span>
            <span className="kind-tag">{kindLabel(q.kind)}</span>
          </span>
          <span className="chip chip-quiet">{real ? 'Solana devnet' : 'Test chain'}</span>
        </div>
        {/* The result in the two words the rest of the app uses, then the proof page's own: where the price finished. */}
        <div className="pc-result">
          <p className="pc-verdict">{resultWord(c.outcome)}</p>
          <p className="pc-called">{calledWords(c)}</p>
        </div>
        <h2 className="q-sentence pc-question">
          {q.parts.map((p, i) => (p.em ? <em key={i}>{p.text}</em> : <Fragment key={i}>{p.text}</Fragment>))}
        </h2>
        <dl className="pc-nums">
          <div>
            <dt>Fair price at the time</dt>
            <dd>{cents(c.fairPrice)}</dd>
          </div>
          <div>
            <dt>Paid</dt>
            <dd>{cents(c.entryPrice)}</dd>
          </div>
          <div>
            <dt>Result</dt>
            <dd className={won ? 'good' : 'bad'}>{q.result}</dd>
          </div>
          <div>
            <dt title="The result, 1 for a hit and 0 for a miss, minus the fair price">Edge per $1</dt>
            <dd className={c.edge >= 0 ? 'good' : 'bad'}>{edgeText}</dd>
          </div>
        </dl>
        <div className="pc-foot">
          <span className="fine">Revealed {revealedOn.toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })}</span>
          <div className="pc-actions">
            <button type="button" className="btn btn-ghost" onClick={savePicture}>
              {picture === 'saved' ? 'Image saved' : picture === 'failed' ? 'Could not save' : 'Save image'}
            </button>
            <button type="button" className="btn btn-ghost" onClick={copy}>
              {copied ? 'Link copied' : 'Copy link'}
            </button>
          </div>
        </div>
      </article>

      <section className="verify" aria-labelledby="pf-check">
        <span className="eyebrow">Independent check</span>
        <h2 id="pf-check" className="h-card">
          Check it on Solana
        </h2>
        {real ? (
          <>
            <p>
              Your browser will read both records straight from a Solana node, then recompute the fingerprint from the call above. Nothing here asks our server whether the call is genuine.
            </p>
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
          </>
        ) : (
          <p>This call is on a test chain, so there is no Solana transaction to check. On devnet, your browser reads both records from Solana and recomputes the fingerprint itself.</p>
        )}

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
                {result.ok ? 'Verified. The call was fixed on Solana before the result was known and was not changed afterwards.' : 'This call did not verify. Treat it as unproven.'}
              </p>
            </>
          )}
        </div>

        {real && (
          <div className="links">
            <a className="mono-chip link" href={explorerTx(c.commitSignature)} target="_blank" rel="noreferrer">
              Commit {trunc(c.commitSignature, 6, 4)} ↗<span className="sr-only"> (opens the Solana explorer in a new tab)</span>
            </a>
            <a className="mono-chip link" href={explorerTx(c.signature)} target="_blank" rel="noreferrer">
              Reveal {trunc(c.signature, 6, 4)} ↗<span className="sr-only"> (opens the Solana explorer in a new tab)</span>
            </a>
          </div>
        )}
        <p className="fine">
          This proves the call was committed before the result. The result itself, won or lost, is reported by our signing key, with the exchange’s order IDs as the evidence.
        </p>
      </section>
    </div>
  );
}
