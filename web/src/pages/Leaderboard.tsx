import { Fragment, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import type { LeaderboardResponse, LeaderboardRow } from '../api/types';
import { kindOfBetId } from '../lib/betKind';
import { kindLabel } from '../lib/betsView';
import { resultWord } from '../lib/callWords';
import { ago, pct, trunc } from '../lib/format';
import { useNow, useResource } from '../lib/hooks';
import { chainLive } from '../lib/liveClients';
import { MY_BETS, PRODUCTS } from '../lib/nav';
import { compareBoards, comparisonLine, explorerAddress, readProblem, readProgramBoard } from '../lib/programBoard';
import type { ProgramRow } from '../lib/programBoard';
import { sealedSpoken, sealedWords } from '../lib/sealed';
import type { SealedCounts } from '../lib/sealed';
import { keepMode } from '../lib/venue';
import { callQuestion, solanaRpc } from '../lib/verify';
import '../styles/leaderboard.css';
import '../styles/bets.css';

/** The same node the proof page reads from. */
const RPC: string = import.meta.env.VITE_SOLANA_RPC ?? 'https://api.devnet.solana.com';

const edgeText = (e: number) => `${e > 0 ? '+' : e < 0 ? '−' : ''}${Math.abs(e).toFixed(2)}`;
const tone = (e: number) => (e > 0 ? 'good' : e < 0 ? 'bad' : '');

/** What the Edge column counts, said once where the column is named and once under the board. */
const EDGE_UNIT = 'Per $1 of payout, summed over a player’s revealed calls';

/**
 * The quiet line under a player's number of revealed calls: how many calls they sealed. It is a row of its own, not a
 * second line in the cell above, so that cell stays a plain number (the browser checks read it as one) and the words can
 * run wider than their column. It spans the columns up to and including that number, and ends under it; `rest` are the
 * columns to its right, each optional or not as in the rows above, so every row of the table has the same columns.
 */
function SealedRow({ counts, span, rest, you }: { counts: SealedCounts; span: number; rest: boolean[]; you?: boolean }) {
  const words = sealedWords(counts);
  if (!words) return null;
  return (
    <tr className={`lb-sub${you ? ' is-you' : ''}`}>
      <td colSpan={span} className="lb-sealed">
        <span aria-hidden="true">{words}</span>
        <span className="sr-only">{sealedSpoken(counts)}</span>
      </td>
      {rest.map((optional, i) => (
        <td key={i} className={optional ? 'lb-opt' : undefined} />
      ))}
    </tr>
  );
}

/** The figures above the table, read from the rows themselves. */
function Summary({ rows }: { rows: LeaderboardRow[] }) {
  const best = rows.length ? Math.max(...rows.map((r) => r.edge)) : null;
  // Only when every row says how many it sealed: a total over some of the players would read as the whole board's.
  const counted = rows.length > 0 && rows.every((r) => r.sealed !== undefined);
  const sealed = rows.reduce((n, r) => n + Math.max(r.sealed ?? 0, r.calls), 0);
  const refunded = rows.reduce((n, r) => n + (r.refunded ?? 0), 0);
  return (
    <dl className="lb-sum" data-n={counted ? 4 : 3} aria-label="Summary">
      <div>
        <dt>Players</dt>
        <dd>{rows.length.toLocaleString('en-US')}</dd>
      </div>
      {counted && (
        <div>
          <dt>Sealed calls</dt>
          <dd>
            {sealed.toLocaleString('en-US')}
            {refunded > 0 && <small>{refunded.toLocaleString('en-US')} refunded</small>}
          </dd>
        </div>
      )}
      <div>
        <dt>Revealed calls</dt>
        <dd>{rows.reduce((n, r) => n + r.calls, 0).toLocaleString('en-US')}</dd>
      </div>
      <div>
        <dt>Best edge</dt>
        <dd className={best === null ? '' : tone(best)}>{best === null ? '–' : edgeText(best)}</dd>
      </div>
    </dl>
  );
}

/**
 * The same board, read by the browser from the program's own accounts on Solana and set beside the server's table.
 *
 * It runs on a click, like the check on the proof page, and never by itself: the page above refreshes every few
 * seconds, and public Solana nodes turn away repeated account scans.
 */
function ProgramBoard({ board }: { board: LeaderboardResponse }) {
  const [rows, setRows] = useState<ProgramRow[] | null>(null);
  const [reading, setReading] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const program = board.program ?? null;
  const authorities = board.authorities ?? [];
  const demo = api.mode === 'mock';
  // Demo rows and the in-memory test chain have no accounts anywhere, and without a program there are only Memos.
  const nothingToRead =
    demo || board.network === 'fake'
      ? `${demo ? 'This is demo data' : 'This board is on a test chain'}, so there are no accounts on Solana to read. On devnet, your browser reads each player’s totals from the program itself.`
      : !program || authorities.length === 0
        ? 'No program is set up on this server, so calls are recorded as Memos only and there are no accounts to read.'
        : null;

  async function read() {
    if (!program) return;
    setReading(true);
    setProblem(null);
    try {
      setRows(await readProgramBoard(solanaRpc(RPC), program, authorities, board.minCalls));
    } catch (e) {
      setProblem(readProblem(e));
    } finally {
      setReading(false);
    }
  }

  /** The section's title and its one paragraph, with the button beside them when there is something to read. */
  const head = (lead: string, action?: ReactNode) => (
    <div className="lb-chain-head">
      <div>
        <span className="eyebrow">Independent check</span>
        <h2 id="lb-chain-h" className="h-card">
          Read from the program
        </h2>
        <p>{lead}</p>
      </div>
      {action}
    </div>
  );

  if (nothingToRead || !program) {
    return (
      <section className="lb-chain" aria-labelledby="lb-chain-h">
        {head(nothingToRead ?? '')}
      </section>
    );
  }

  // Against the rows on screen now, so the line stays true when the table above updates itself.
  const match = rows && (rows.length > 0 || board.rows.length > 0) ? comparisonLine(compareBoards(rows, board.rows)) : null;
  // The second read, of the calls themselves, can be turned away by a busy node. Then the scores show without it.
  const sealedRead = rows !== null && rows.some((r) => r.sealed !== undefined);

  return (
    <section className="lb-chain" aria-labelledby="lb-chain-h">
      {head(
        'These rows are read by your browser from the program’s own accounts on Solana. Our server is not asked.',
        <button type="button" className="btn btn-ghost" onClick={read} disabled={reading}>
          {reading ? (
            <>
              <span className="spin" aria-hidden="true" /> Reading Solana
            </>
          ) : problem ? (
            'Try again'
          ) : rows ? (
            'Read again'
          ) : (
            'Read from Solana'
          )}
        </button>,
      )}

      <div aria-live="polite">
        {problem && (
          <p className="note note-bad" role="alert">
            {problem}
          </p>
        )}
        {rows && rows.length === 0 && <p className="note note-info">The program has no player totals to show yet. A player appears here once a reveal of theirs has gone through the program.</p>}
        {rows && rows.length > 0 && (
          // This table comes after the server's board in the page, so "the first table" is still that board.
          <div className="lb-wrap">
            <table className="lb lb-onchain">
              <caption className="sr-only">Players as the program’s accounts on Solana record them</caption>
              <thead>
                <tr>
                  <th scope="col">Player</th>
                  <th scope="col" className="n">
                    Revealed
                  </th>
                  <th scope="col" className="n">
                    Hit rate
                  </th>
                  <th scope="col" className="n" title={EDGE_UNIT}>
                    Edge
                  </th>
                  <th scope="col" className="n lb-opt">
                    Last call
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  // The chain cannot tell a refunded call from one kept sealed, so there is no refunded count here.
                  const counts = { calls: r.calls, sealed: r.sealed };
                  return (
                    <Fragment key={r.handle}>
                      <tr className={sealedWords(counts) ? 'has-sub' : undefined}>
                        <td className="lb-who">{r.handle}</td>
                        <td className="n">{r.calls}</td>
                        <td className="n">{pct(r.hitRate)}</td>
                        <td className={`n lb-edge ${tone(r.edge)}`}>{edgeText(r.edge)}</td>
                        <td className="n lb-opt lb-when">{ago(r.lastRevealedAt)}</td>
                      </tr>
                      <SealedRow counts={counts} span={2} rest={[false, false, true]} />
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {match && <p className="lb-chain-match">{match}</p>}
      </div>

      <div className="lb-chain-links">
        <a className="mono-chip link" href={explorerAddress(program)} target="_blank" rel="noreferrer">
          Program {trunc(program, 6, 4)} ↗
        </a>
        {authorities.map((a) => (
          <a key={a} className="mono-chip link" href={explorerAddress(a)} target="_blank" rel="noreferrer">
            Signing key {trunc(a, 6, 4)} ↗
          </a>
        ))}
      </div>
      <p className="fine">
        This counts only reveals that went through the program, and shows each player’s totals, not their individual calls.
        {sealedRead && ' The program holds every call from the moment it is sealed, so the sealed count does not depend on our server either. It cannot tell a refunded call from one kept sealed, so refunds are not counted apart here.'}
      </p>
    </section>
  );
}

export default function Leaderboard() {
  const lb = useResource('leaderboard', () => api.leaderboard(), { live: [[chainLive, 'leaderboard']], pollMs: 10000 });
  // This visitor's own calls, for one thing only: each carries their handle, so their row can be marked. The same cached
  // answer My bets uses.
  const calls = useResource('calls', () => api.calls(), { live: [[chainLive, 'calls']], pollMs: 30000 });
  const rows = lb.data?.rows ?? [];
  const minCalls = lb.data?.minCalls ?? 1;
  const [open, setOpen] = useState<string | null>(null);
  useNow(60_000); // keeps "2 h ago" current

  const mine = useMemo(() => new Set((calls.data?.calls ?? []).map((c) => c.handle)), [calls.data]);
  const myHandle = calls.data?.calls[0]?.handle ?? null;
  const onBoard = rows.some((r) => mine.has(r.handle));
  const reportsSealed = rows.some((r) => r.sealed !== undefined);

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1 className="h-page">Leaderboard</h1>
          <p className="lede">Ranked by how much better your calls did than the market’s own odds, not by profit or by how much you bet.</p>
        </div>
        {lb.data && <span className="chip chip-quiet">{api.mode === 'mock' ? 'Demo data' : lb.data.network === 'fake' ? 'Test chain' : lb.data.source === 'quicknode-stream' ? 'Live from Solana' : 'Read from Solana'}</span>}
      </header>

      {lb.loading && !lb.data ? (
        <div className="stack" aria-busy="true" aria-label="Loading the leaderboard">
          <div className="skeleton lb-skel-sum" />
          <div className="skeleton lb-skel-table" />
        </div>
      ) : !lb.data ? (
        // No answer at all is not an empty board, and must not read as one.
        <div className="lb-empty" role="alert">
          <h2 className="h-card">We could not load the leaderboard</h2>
          <p>{lb.error?.message ?? 'The service did not answer.'} Calls that were already revealed are not affected.</p>
          <button type="button" className="btn btn-ghost" onClick={() => lb.reload()}>
            Try again
          </button>
        </div>
      ) : (
        <>
          <Summary rows={rows} />
          {rows.length === 0 ? (
            <div className="lb-empty">
              <h2 className="h-card">No revealed calls yet</h2>
              <p>The board is built from calls revealed on Solana. Three steps put you on it:</p>
              <ol>
                <li>
                  <Link to={keepMode(PRODUCTS[0]!.to)}>Place a bet</Link>. Your call is sealed on Solana the moment you do.
                </li>
                <li>Wait for the market to settle.</li>
                <li>
                  Reveal the call from <Link to={keepMode(MY_BETS.to)}>{MY_BETS.name}</Link>. {minCalls > 1 ? `A player is ranked from ${minCalls} revealed calls.` : 'It counts here at once.'}
                </li>
              </ol>
            </div>
          ) : (
            <div className="lb-wrap">
              <table className="lb">
                <caption className="sr-only">Players ranked by edge</caption>
                <thead>
                  <tr>
                    <th scope="col" className="lb-rank">
                      Rank
                    </th>
                    <th scope="col">Player</th>
                    <th scope="col" className="n">
                      Revealed
                    </th>
                    <th scope="col" className="n lb-opt">
                      Hit rate
                    </th>
                    <th scope="col" className="n" title={EDGE_UNIT}>
                      Edge
                    </th>
                    <th scope="col" className="n lb-opt">
                      Last call
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => {
                    // Demo data's own row is the handle "you", which already reads as the visitor.
                    const name = r.handle === 'you' ? 'You' : r.handle;
                    const isYou = mine.has(r.handle) || r.handle === 'you';
                    const isOpen = open === r.handle;
                    const callsId = `lb-calls-${r.handle}`;
                    const hasSub = sealedWords(r) !== null;
                    const opens = r.recent !== undefined && r.recent.length > 0;
                    return (
                      <Fragment key={r.handle}>
                        <tr className={[isYou ? 'is-you' : '', hasSub ? 'has-sub' : ''].filter(Boolean).join(' ') || undefined}>
                          <td className="lb-rank">{r.rank}</td>
                          {/* "You" is drawn from the attribute by the stylesheet, so the cell's own text is the handle and nothing else. */}
                          <td className={opens ? 'lb-who lb-who-opens' : 'lb-who'} data-tag={isYou && r.handle !== 'you' ? 'You' : undefined}>
                            {opens ? (
                              <button type="button" className="lb-toggle" aria-expanded={isOpen} aria-controls={isOpen ? callsId : undefined} onClick={() => setOpen(isOpen ? null : r.handle)}>
                                <span className="lb-caret" aria-hidden="true" />
                                {name}
                              </button>
                            ) : (
                              name
                            )}
                          </td>
                          <td className="n">{r.calls}</td>
                          <td className="n lb-opt">{pct(r.hitRate)}</td>
                          <td className={`n lb-edge ${tone(r.edge)}`}>{edgeText(r.edge)}</td>
                          <td className="n lb-opt lb-when">{ago(r.lastRevealedAt)}</td>
                        </tr>
                        <SealedRow counts={r} span={3} rest={[true, false, true]} you={isYou} />
                        {isOpen && r.recent && (
                          <tr className="lb-calls" id={callsId}>
                            <td colSpan={6}>
                              <ul aria-label={`${name}'s revealed calls`}>
                                {r.recent.map((c) => {
                                  // What the call was, from what its reveal published. An older service sends only the bet id, which still names the product.
                                  const asked = c.event && c.condition && c.target ? callQuestion({ betId: c.betId, event: c.event, condition: c.condition, target: c.target, outcome: c.outcome }).text : null;
                                  return (
                                    <li key={c.signature}>
                                      <span className="status" data-outcome={c.outcome === 1 ? 'won' : 'lost'}>
                                        {resultWord(c.outcome)}
                                      </span>
                                      <span className="lb-call">
                                        <span className="kind-tag">{kindLabel(kindOfBetId(c.betId))}</span>
                                        {asked}
                                      </span>
                                      <span className={`lb-edge ${tone(c.edge)}`}>{edgeText(c.edge)}</span>
                                      <span className="lb-when">{ago(c.revealedAt)}</span>
                                      {/* The proof page says what can be checked on which chain, so the link does not promise Solana. */}
                                      <Link to={keepMode(`/verify/${c.signature}`)}>
                                        Open proof<span className="sr-only">{asked ? `: ${asked}` : ` of the call revealed ${ago(c.revealedAt)}`}</span>
                                      </Link>
                                    </li>
                                  );
                                })}
                              </ul>
                              {r.calls > r.recent.length && (
                                <p className="fine">
                                  The newest {r.recent.length} of {r.calls} revealed calls.
                                </p>
                              )}
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          {rows.length > 0 && (
            <div className="lb-notes">
              <p className="fine">Edge is counted per $1 of payout and summed over a player’s revealed calls: one call that comes off at a fair price of 41¢ adds +0.59.</p>
              {myHandle && myHandle !== 'you' && !onBoard && (
                <p className="fine">
                  Your handle is <b>{myHandle}</b>. It appears here once you have revealed {minCalls > 1 ? `${minCalls} settled calls` : 'a settled call'} from <Link to={keepMode(MY_BETS.to)}>{MY_BETS.name}</Link>.
                </p>
              )}
            </div>
          )}
        </>
      )}

      {lb.data && <ProgramBoard board={lb.data} />}

      <section className="lb-explain" aria-labelledby="lb-how">
        <div>
          <h2 id="lb-how" className="h-card">
            How edge works
          </h2>
          <p>Every call has a fair price when you make it: the market’s own chance that it comes off. A hit scores one minus that price, a miss scores minus that price, and a player’s edge is the sum, counted per $1 of payout.</p>
          <p>Beating the odds again and again moves you up; a lucky call or two washes out. A refunded call, where the first half failed, is not scored.</p>
          {reportsSealed ? (
            <p>
              Players are anonymous handles. Revealing a call is the player’s choice, but making one is not hidden: each call is sealed on Solana under the handle before the result. So the board shows how many calls each player sealed beside how many
              they revealed. Refunded calls are counted apart, because they can never be revealed.
            </p>
          ) : (
            <p>Players are anonymous handles. Revealing a call is the player’s choice, so only revealed calls appear here.</p>
          )}
        </div>
        {/* A list rather than a table, so the only tables on the page are boards. */}
        <figure className="lb-example">
          <figcaption>One call made at a fair price of 41¢</figcaption>
          <dl>
            <div>
              <dt>The second half happens</dt>
              <dd className="good">+0.59</dd>
            </div>
            <div>
              <dt>The first half holds, the second does not</dt>
              <dd className="bad">−0.41</dd>
            </div>
            <div>
              <dt>The first half fails, stake refunded</dt>
              <dd className="lb-none">Not scored</dd>
            </div>
          </dl>
          <p className="fine">A range or a breakout call has no refund. A range scores a hit for finishing inside its two levels, a breakout for finishing outside them.</p>
        </figure>
      </section>
    </div>
  );
}
