import { Fragment, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import type { LeaderboardResponse, LeaderboardRow } from '../api/types';
import { kindOfBetId } from '../lib/betKind';
import { kindLabel } from '../lib/betsView';
import { countText, edgeTone as tone, resultWord } from '../lib/callWords';
import { ago, edgeText, pct, trunc } from '../lib/format';
import { friendly } from '../lib/friendly';
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

/**
 * The place shown for a row. Players with exactly the same score share a place, shown "=2" for each, instead of the second
 * looking one behind the first.
 */
function placeOf(rows: LeaderboardRow[], i: number): string {
  const key = (r: LeaderboardRow) => `${r.edge}|${r.hitRate}|${r.calls}`;
  const group = rows.filter((r) => key(r) === key(rows[i]!));
  return group.length > 1 ? `=${group[0]!.rank}` : String(rows[i]!.rank);
}

/**
 * The quiet line under a player's number of revealed calls: how many calls they sealed. It is a row of its own, not a
 * second line in the cell above, so that cell stays a plain number (the browser checks read it as one) and the words can
 * run wider than their column. It spans the columns up to and including that number, and ends under it; `rest` are the
 * columns to its right, each optional or not as in the rows above, so every row of the table has the same columns.
 *
 * Assistive technology skips it as a row (it would read as an empty row between every two players): its sentence is the
 * description of the number above it instead, and that cell points at `id`.
 */
function SealedRow({ counts, span, rest, you, id }: { counts: SealedCounts; span: number; rest: boolean[]; you?: boolean; id: string }) {
  const words = sealedWords(counts);
  if (!words) return null;
  return (
    <tr className={`lb-sub${you ? ' is-you' : ''}`} aria-hidden="true">
      <td colSpan={span} className="lb-sealed">
        <span>{words}</span>
        <span id={id} className="sr-only">
          {sealedSpoken(counts)}
        </span>
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
    <dl className="lb-sum" data-n={counted ? 4 : 3} role="group" aria-label="Summary">
      <div>
        <dt>Players</dt>
        <dd>{countText(rows.length)}</dd>
      </div>
      {counted && (
        <div>
          <dt>Sealed calls</dt>
          <dd>
            {countText(sealed)}
            {/* Text between the two numbers, so a screen reader does not hear them as one: "54" and "2" are not "542". */}
            {refunded > 0 && (
              <>
                <span className="sr-only">, </span>
                <small>{countText(refunded)} stake back</small>
              </>
            )}
          </dd>
        </div>
      )}
      <div>
        <dt>Revealed calls</dt>
        <dd>{countText(rows.reduce((n, r) => n + r.calls, 0))}</dd>
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
  // Demo rows and the in-memory chain have no accounts anywhere, and without a program there are only Memos.
  const nothingToRead = demo || board.network === 'fake' || !program || authorities.length === 0;

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

  /** The section's title and its one paragraph, with the button beside them. */
  const head = (lead: string, action?: ReactNode) => (
    <div className="lb-chain-head">
      <div>
        <h2 id="lb-chain-h" className="h-card">
          Read it from Solana
        </h2>
        <p>{lead}</p>
      </div>
      {action}
    </div>
  );

  // With no program on Solana there is nothing to read, so the section is left out rather than explaining its absence.
  if (nothingToRead || !program) return null;

  // Against the rows on screen now, so the line stays true when the table above updates itself.
  const match = rows && (rows.length > 0 || board.rows.length > 0) ? comparisonLine(compareBoards(rows, board.rows)) : null;
  // The second read, of the calls themselves, can be turned away by a busy node. Then the scores show without it.
  const sealedRead = rows !== null && rows.some((r) => r.sealed !== undefined);

  return (
    <section className="lb-chain" aria-labelledby="lb-chain-h">
      {head(
        'Your browser reads each player’s totals from the program on Solana, without asking our server. The program and keys are listed on the Proof page.',
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
        {rows && rows.length === 0 && <p className="note note-info">The program has no player totals yet. A player appears once one of their reveals goes through it.</p>}
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
                    Win rate
                  </th>
                  <th scope="col" className="n">
                    Edge per $1
                  </th>
                  <th scope="col" className="n lb-opt">
                    Last call
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  // The chain cannot tell a call whose stake came back from one kept sealed, so there is no such count here.
                  const counts = { calls: r.calls, sealed: r.sealed };
                  return (
                    <Fragment key={r.handle}>
                      <tr className={sealedWords(counts) ? 'has-sub' : undefined}>
                        <td className="lb-who">{r.handle}</td>
                        <td className="n" aria-describedby={sealedWords(counts) ? `lb-p-${r.handle}` : undefined}>
                          {countText(r.calls)}
                        </td>
                        <td className="n">{pct(r.hitRate)}</td>
                        <td className={`n lb-edge ${tone(r.edge)}`}>{edgeText(r.edge)}</td>
                        <td className="n lb-opt lb-when">{ago(r.lastRevealedAt)}</td>
                      </tr>
                      <SealedRow counts={counts} span={2} rest={[false, false, true]} id={`lb-p-${r.handle}`} />
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
        It counts only reveals that went through the program, as totals per player.
        {sealedRead && ' The sealed count is read from the program too, which cannot tell a stake back from a call kept sealed.'}
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

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <div className="lb-title">
            <h1 className="h-page">Leaderboard</h1>
            {/* Said only when the board really was read from Solana, and beside the title at every width. */}
            {lb.data && api.mode !== 'mock' && lb.data.network !== 'fake' && <span className="chip chip-quiet">{lb.data.source === 'quicknode-stream' ? 'Live from Solana' : 'Read from Solana'}</span>}
          </div>
          {/* The one place the score is defined: the column below carries its unit, and the section at the foot shows the arithmetic. */}
          <p className="lede">Edge is how far a call beat the market’s own price, per $1. Players are ranked by it, not by profit or by the size of their bets.</p>
        </div>
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
          <p>{lb.error ? friendly(lb.error) : 'The service did not answer.'} Calls that were already revealed are not affected.</p>
          <button type="button" className="btn btn-ghost" onClick={() => lb.reload()}>
            Try again
          </button>
        </div>
      ) : (
        <>
          {/* The strip restates the table: with one or two players it is the table again, so it waits for a third. */}
          {rows.length >= 3 && <Summary rows={rows} />}
          {rows.length === 0 ? (
            <div className="lb-empty">
              <h2 className="h-card">No revealed calls yet</h2>
              <p>The board is built from revealed calls. Three steps put you on it:</p>
              <ol>
                <li>
                  <Link to={keepMode(PRODUCTS[0]!.to)}>Place a bet</Link> and its call is sealed
                </li>
                <li>Wait for the result</li>
                <li>
                  Reveal the call from <Link to={keepMode(MY_BETS.to)}>{MY_BETS.name}</Link>
                  {minCalls > 1 ? ` and it counts once you have ${minCalls} revealed` : ' and it counts here'}
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
                      Win rate
                    </th>
                    <th scope="col" className="n">
                      Edge per $1
                    </th>
                    <th scope="col" className="n lb-opt">
                      Last call
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r, i) => {
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
                          <td className="lb-rank">{placeOf(rows, i)}</td>
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
                          <td className="n" aria-describedby={hasSub ? `lb-s-${r.handle}` : undefined}>
                            {countText(r.calls)}
                          </td>
                          <td className="n lb-opt">{pct(r.hitRate)}</td>
                          <td className={`n lb-edge ${tone(r.edge)}`}>{edgeText(r.edge)}</td>
                          <td className="n lb-opt lb-when">{ago(r.lastRevealedAt)}</td>
                        </tr>
                        <SealedRow counts={r} span={3} rest={[true, false, true]} you={isYou} id={`lb-s-${r.handle}`} />
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
                                        Proof page<span className="sr-only">{asked ? ` for ${asked}` : ` of the call revealed ${ago(c.revealedAt)}`}</span>
                                      </Link>
                                    </li>
                                  );
                                })}
                              </ul>
                              {r.calls > r.recent.length && (
                                <p className="fine">
                                  The newest {r.recent.length} of {countText(r.calls)} revealed calls.
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
              {myHandle && myHandle !== 'you' && !onBoard && (
                <p className="fine">
                  Your handle is <b>{myHandle}</b>. It appears here once you have revealed {minCalls > 1 ? `${minCalls} closed calls` : 'a closed call'} from <Link to={keepMode(MY_BETS.to)}>{MY_BETS.name}</Link>.
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
          <p>A win adds 1 minus the call’s fair price, and a loss subtracts it. Edge adds up across your revealed calls.</p>
        </div>
        {/* A list rather than a table, so the only tables on the page are boards. */}
        <figure className="lb-example">
          <figcaption>One call made at a fair price of 41¢</figcaption>
          <dl>
            <div>
              <dt>The target is reached</dt>
              <dd className="good">+0.59</dd>
            </div>
            <div>
              <dt>The first level holds, the target is not reached</dt>
              <dd className="bad">−0.41</dd>
            </div>
            <div>
              <dt>The first level fails, stake back</dt>
              <dd className="lb-none">Not scored</dd>
            </div>
          </dl>
          <p className="fine">A Range wins between its two levels, a Breakout outside them. Neither has a stake back.</p>
        </figure>
      </section>
    </div>
  );
}
