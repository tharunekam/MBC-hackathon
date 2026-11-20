/**
 * The contract between the web app and its two services.
 *
 * Executor types mirror `executor/src/api.ts` and `executor/src/ledger.ts`
 * (hosted service that places the two Gemini orders). Chain types describe the
 * service that commits and reveals calls on Solana and serves the leaderboard.
 * The demo data in `mock.ts` returns the same shapes, so every page can be built
 * and checked without either service running.
 */

/**
 * The kinds of bet. A parlay refunds the stake if its first condition fails; a range wins if the price finishes between two
 * levels; a breakout is the range's opposite and wins if it finishes outside them, either way.
 */
export type Product = 'parlay' | 'range' | 'breakout';

/** Which way a parlay looks: "up" bets that a price reaches a higher level, "down" that it falls to a lower one. */
export type Direction = 'up' | 'down';

// ------------------------------------------------------------------ executor: markets

export interface Rung {
  symbol: string;
  label: string;
  strike: number;
  bid: number | null;
  ask: number | null;
  open: boolean;
  state: string;
}

export type RefusalCode =
  | 'market_closed'
  | 'one_sided_book'
  | 'ladder_out_of_order'
  | 'no_price'
  | 'price_too_high'
  | 'markup_too_high';

export interface OfferQuote {
  verdict: 'ok' | 'warn' | 'refuse';
  reasons: { code: RefusalCode; message: string }[];
  warnings: string[];
  offerable: boolean;
  overridden: boolean;
  chanceCondition: number | null;
  chanceBothHappen: number | null;
  fairPrice: number | null;
  pricePaid: number | null;
  allInPrice: number | null;
  markup: number | null;
  markupPct: number | null;
  cashOutPer100: number | null;
  cashOutPer100AtProductionFees: number | null;
  feeCoefCharged: number;
}

export interface PairLeg {
  symbol: string;
  label: string;
  strike: number;
  bid: number | null;
  ask: number | null;
}

export interface Pair {
  condition: PairLeg;
  target: PairLeg;
  quote: OfferQuote;
}

export interface MarketEvent {
  ticker: string;
  title: string;
  category?: string;
  expiry: string | null;
  rungs: Rung[];
  ladderOutOfOrder: boolean;
  pairs: Pair[];
  offerableCount: number;
  refusedCount: number;
  refusedByReason: Record<string, number>;
  /**
   * The same for a parlay that a price falls: the condition is the higher strike and the target the lower. Absent in a session
   * recorded before falling bets existed; the page then starts a falling bet from the rungs alone.
   */
  down?: { pairs: Pair[]; offerableCount: number; refusedCount: number };
}

export interface MarketsResponse {
  venue: string;
  asOf: string;
  feeCoefCharged: number;
  totals: { events: number; eventsWithOffers: number; offerable: number; refused: number };
  events: MarketEvent[];
}

// ------------------------------------------------------------------ executor: quote

export interface StakePlan {
  requested: number;
  reduced: boolean;
  outcomeContracts: number;
  hedgeContracts: number;
  cost: number;
  ifBothHit: number;
  ifConditionFails: number;
  ifConditionOnly: number;
  feesAtProductionRates: number;
  cashOutNow: number | null;
}

/** The offer rule's verdict and numbers for a range. The same verdict words as a parlay's quote. */
export interface RangeQuote {
  verdict: 'ok' | 'warn' | 'refuse';
  reasons: { code: RefusalCode; message: string }[];
  warnings: string[];
  offerable: boolean;
  overridden: boolean;
  /** Chance the price finishes at or above the lower strike and below the higher one. */
  chanceInRange: number | null;
  /** What a $1 "inside the range" payout is worth with no spread and no fees. The same as the chance. */
  fairPrice: number | null;
  /** Price per $1 of "inside the range" payout on this venue. */
  pricePaid: number | null;
  /** The same at Gemini's production fee rate. */
  allInPrice: number | null;
  markup: number | null;
  markupPct: number | null;
  cashOutPer100: number | null;
  cashOutPer100AtProductionFees: number | null;
  feeCoefCharged: number;
}

export interface RangeStakePlan {
  requested: number;
  reduced: boolean;
  /** Contracts of each leg. */
  contracts: number;
  cost: number;
  /** Dollars that come back whatever happens. */
  backAlways: number;
  /** Net result if the price finishes inside the range. */
  ifInRange: number;
  /** Net result if it finishes outside. */
  ifOutside: number;
  feesAtProductionRates: number;
  cashOutNow: number | null;
}

export interface RangeQuoteResponse {
  venue: string;
  asOf: string;
  product: 'range';
  event: { ticker: string; title: string; expiry: string | null };
  low: PairLeg;
  high: PairLeg;
  quote: RangeQuote;
  stake: RangeStakePlan | null;
  depth: { outcomeAvailable: number; conditionAvailable: number; maxStake: number } | { unavailable: string } | null;
}

/**
 * The offer rule's verdict and numbers for a breakout: YES on the higher strike and NO on the lower, the same number of
 * contracts of each. Exactly one of the two pays $1 when the price finishes outside the two levels and neither pays inside,
 * so the pair's cost is the price of $1 of "outside" payout.
 */
export interface BreakoutQuote {
  verdict: 'ok' | 'warn' | 'refuse';
  reasons: { code: RefusalCode; message: string }[];
  warnings: string[];
  offerable: boolean;
  overridden: boolean;
  /** Chance the price finishes below the lower strike, or at or above the higher one. */
  chanceOutside: number | null;
  /** What a $1 "outside" payout is worth with no spread and no fees. The same as the chance. */
  fairPrice: number | null;
  /** Price per $1 of "outside" payout on this venue. */
  pricePaid: number | null;
  /** The same at Gemini's production fee rate. */
  allInPrice: number | null;
  markup: number | null;
  markupPct: number | null;
  cashOutPer100: number | null;
  cashOutPer100AtProductionFees: number | null;
  feeCoefCharged: number;
}

export interface BreakoutStakePlan {
  requested: number;
  reduced: boolean;
  /** Contracts of each leg. */
  contracts: number;
  cost: number;
  /** Net result if the price finishes outside the two levels (the win). */
  ifOutside: number;
  /** Net result if it finishes between them (the loss: everything spent). */
  ifInRange: number;
  feesAtProductionRates: number;
  cashOutNow: number | null;
}

export interface BreakoutQuoteResponse {
  venue: string;
  asOf: string;
  product: 'breakout';
  event: { ticker: string; title: string; expiry: string | null };
  low: PairLeg;
  high: PairLeg;
  quote: BreakoutQuote;
  stake: BreakoutStakePlan | null;
  /** `outcomeAvailable` is what is on offer on the higher strike's YES, `conditionAvailable` on the lower strike's NO. */
  depth: { outcomeAvailable: number; conditionAvailable: number; maxStake: number } | { unavailable: string } | null;
}

export interface QuoteResponse {
  venue: string;
  asOf: string;
  product?: 'parlay';
  direction?: Direction;
  event: { ticker: string; title: string; expiry: string | null };
  condition: PairLeg;
  target: PairLeg;
  quote: OfferQuote;
  stake: StakePlan | null;
  depth: { outcomeAvailable: number; conditionAvailable: number; maxStake: number } | { unavailable: string } | null;
}

// ------------------------------------------------------------------ executor: bets

export interface LegRecord {
  clientOrderId: string;
  role: 'outcome' | 'hedge' | 'unwind' | 'trigger' | 'cashout';
  symbol: string;
  side: 'buy' | 'sell';
  outcome: 'yes' | 'no';
  limitPrice: number;
  quantityRequested: number;
  quantityFilled: number;
  avgPrice: number | null;
  fee: number;
  /**
   * `unknown`: the order was sent and nobody knows what became of it (the answer was lost and the exchange could not say). Nothing
   * more is sent for it; the executor looks it up by its tag again on a timer.
   */
  status: 'sent' | 'filled' | 'partial' | 'unfilled' | 'resting' | 'error' | 'unknown';
  orderId?: string;
  sentAt: string;
  note?: string;
}

export type BetStatus = 'placing' | 'open' | 'unhedged' | 'unwound' | 'failed' | 'settled' | 'needs_review' | 'cashed_out';

/** What one bet sent to Gemini's book (executor `betFlow`). The same shape as the totals in `FlowResponse`. */
export interface BetFlow {
  bets: number;
  ordersSent: number;
  ordersFilled: number;
  contracts: number;
  premium: number;
  feesAtProductionRates: number;
  feesCharged: number;
}

/** Set on a bet placed as one leg of a basket. */
export interface BasketTag {
  id: string;
  name?: string;
  /** Which leg this bet is, from 0. */
  index: number;
  /** How many legs the basket was asked to have. */
  size: number;
}

export interface Bet {
  id: string;
  user: string;
  createdAt: string;
  eventTicker: string;
  eventTitle: string;
  expiry: string | null;
  /** Absent on bets recorded before there were ranges: those are rising parlays. */
  product?: Product;
  direction?: Direction;
  basket?: BasketTag;
  /**
   * A parlay's condition is the strike that has to hold first (the HIGHER one for a falling parlay) and its target the strike
   * it is really about. A range has no condition: here its lower strike is the "condition" and its higher the "target". A
   * breakout names its two strikes the same way as a range.
   */
  condition: { symbol: string; label: string; strike: number };
  target: { symbol: string; label: string; strike: number };
  requestedStake: number;
  quotedPrice: number;
  /** The id the page sent with the request that placed this bet (see `requestId` on the place requests). Absent without one. */
  clientRequestId?: string;
  status: BetStatus;
  /** The executor's own sentence about the bet's state (for an order with no confirmed result, that it may be in place). Never shown as it is. */
  note?: string;
  legs: LegRecord[];
  cost: number;
  /**
   * For a parlay: ifBothHit is the win, ifConditionOnly the loss and ifConditionFails the refund. For a range: ifInRange and
   * ifOutside, and ifBothHit / ifConditionOnly carry the same two numbers; there is no refund line. For a breakout the same
   * four fields, the other way round: ifOutside (and ifBothHit) is the win, ifInRange (and ifConditionOnly) the loss.
   */
  payoffs?: {
    stake: number;
    ifConditionFails?: number;
    ifBothHit: number;
    ifConditionOnly: number;
    ifInRange?: number;
    ifOutside?: number;
    conditionalPrice: number | null;
    hedged: boolean;
  };
  offer?: OfferQuote | RangeQuote | BreakoutQuote;
  stakeReduced?: { requested: number; reducedTo: number; outcomeAvailable: number; conditionAvailable: number; reason: string };
  settlement?: {
    conditionResolved: 'yes' | 'no';
    targetResolved: 'yes' | 'no';
    payout: number;
    /** Payout minus cost, in dollars (the executor calls it `pnl`). */
    pnl: number;
    settledAt: string;
    /** The price the ladder finished at, when the exchange reported it. For showing where it ended; the payout never depends on it. */
    finishedAt?: number;
  };
  /**
   * Present when Gemini settled the market without a plain yes or no (`needs_review`). `resolved` is what it actually
   * paid, read from the account and entered by hand. Such a bet is never scored.
   */
  review?: { reason: string; resolved?: { payout: number; pnl: number; recordedAt: string; note: string } };
  /**
   * Present once some or all of the bet has been sold back (`POST /cashout`). `stake` is what the bet had cost before the
   * first sale, `proceeds` what the sell orders brought in after fees, `pnl` the difference. While `complete` is false part
   * of the bet is still held and it settles as usual; when true the status is `cashed_out`.
   */
  cashOut?: { at: string; stake: number; proceeds: number; pnl: number; complete: boolean };
  /**
   * For a bet sold back before its market settled: how its call turned out, once the market has a clean result. The bet is
   * never paid or `settled`, but its call can then be revealed and scored like any other (`scorable` becomes true).
   */
  called?: { conditionResolved: 'yes' | 'no'; targetResolved: 'yes' | 'no'; at: string; finishedAt?: number };
  scorable: boolean;
  flow: BetFlow;
}

/** Why a bet cannot be sold back right now (executor `CashOutCode`). */
export type CashOutCode =
  | 'not_open'
  | 'market_closed'
  | 'no_bid'
  | 'insufficient_depth'
  | 'position_netted'
  | 'below_minimum'
  /** The first sell order definitely sold nothing: the bet is unchanged. */
  | 'nothing_sold'
  /** The first sell order has no confirmed result (HTTP 409): the sale may have gone through. */
  | 'sale_unconfirmed';

/** `GET /cashout?bet=`: what selling an open bet's two orders back would bring in right now. Nothing is sent. */
export interface CashOutQuote {
  betId: string;
  asOf: string;
  /** True when the whole bet can be sold now at these prices. */
  available: boolean;
  code: CashOutCode | null;
  /** Why not, in a sentence. Null when available. */
  reason: string | null;
  /** Net dollars in the bet now. */
  stake: number;
  /** What selling both orders now brings in, after the fees this venue charges. Null when an order has no buyer. */
  proceeds: number | null;
  /** proceeds minus stake. */
  pnl: number | null;
  /** The same sale at Gemini's published taker rate. */
  proceedsAtProductionFees: number | null;
  legs: { role: 'outcome' | 'hedge'; symbol: string; outcome: 'yes' | 'no'; quantity: number; price: number | null; available: number | null }[];
}

/** `POST /cashout` when it sold. A refusal is an ApiError (422, or 409 `not_open`) whose body carries `code` and `quote`. */
export interface CashOutResponse {
  bet: Bet;
  cashOut: NonNullable<Bet['cashOut']>;
}

export interface PlaceParlayRequest {
  user: string;
  event: string;
  condition: string;
  target: string;
  direction?: Direction;
  stake: number;
  /** The highest price per $1 the person accepts. The pages send the quote's price plus a little room (see `maxPriceFor`). */
  maxPrice?: number;
  slippageTicks?: number;
  onHedgeFail?: 'unwind' | 'leave';
  requestId?: string;
}

export interface PlaceRangeRequest {
  product: 'range';
  user: string;
  event: string;
  /** Symbol of the lower strike. */
  low: string;
  /** Symbol of the higher strike. */
  high: string;
  /** Dollars to spend on the two orders together. */
  stake: number;
  maxPrice?: number;
  slippageTicks?: number;
  requestId?: string;
}

export interface PlaceBreakoutRequest {
  product: 'breakout';
  user: string;
  event: string;
  /** Symbol of the lower strike (the NO order). */
  low: string;
  /** Symbol of the higher strike (the YES order). */
  high: string;
  /** Dollars to spend on the two orders together. */
  stake: number;
  maxPrice?: number;
  slippageTicks?: number;
  requestId?: string;
}

export type PlaceBetRequest = PlaceParlayRequest | PlaceRangeRequest | PlaceBreakoutRequest;

export interface PlaceBetResponse {
  bet: Bet;
  stakeReduced: Bet['stakeReduced'] | null;
  /** True when the executor had already placed a bet for this `requestId` and sent that one back: nothing new was bought. */
  repeated?: boolean;
}

/**
 * One leg of a basket request: a parlay (either way) or a range, with its own stake. `maxPrice` is the highest price per $1 the
 * person accepts for that leg, with the same meaning and checks as on a single bet.
 */
export type BasketLegRequest =
  | { product?: 'parlay'; event: string; condition: string; target: string; direction?: Direction; stake: number; maxPrice?: number }
  | { product: 'range'; event: string; low: string; high: string; stake: number; maxPrice?: number }
  | { product: 'breakout'; event: string; low: string; high: string; stake: number; maxPrice?: number };

export interface PlaceBasketRequest {
  user: string;
  name?: string;
  legs: BasketLegRequest[];
  /** 8 to 64 characters from A-Z, a-z, 0-9, `_` and `-`. A repeat of one the executor has seen returns that basket and places nothing. */
  requestId?: string;
}

export interface PlaceBasketResponse {
  basket: {
    id: string;
    name: string | null;
    /** How many legs were asked for. */
    size: number;
    /** Set when a leg could not be completed: which, and why. The legs after it were not attempted. */
    failed: { index: number; code: string; message: string } | null;
    /** The `requestId` the basket was placed under, when it had one. */
    clientRequestId?: string;
  };
  /** The bets that were placed, in leg order. */
  bets: Bet[];
  /** True when this is the basket an earlier request with the same `requestId` placed: nothing new was bought. */
  repeated?: boolean;
}

export interface FlowResponse {
  venue: string;
  user: string | null;
  bets: number;
  ordersSent: number;
  ordersFilled: number;
  contracts: number;
  premium: number;
  feesAtProductionRates: number;
  feesCharged: number;
  productionFeeCoef: number;
  note: string;
}

export interface HealthResponse {
  ok: boolean;
  venue: string;
  sandbox: boolean;
  /** True when the executor has no Gemini keys: live prices and quotes, but every order is refused. */
  readOnly?: boolean;
  /** True when our own liquidity seeder is quoting on the sandbox, so some of the prices shown are ours. */
  seeded?: boolean;
  /** The most one bet may stake on this server, when it sets a limit (the hosted demo does). */
  maxStake?: number | null;
  /** Present when the server is playing back a recorded session with nothing live behind it, and when it was recorded. */
  replay?: { recordedAt: string };
  users: { user: string; connected: boolean | null }[];
  time: string;
}

/** Shape of every error body from the executor. */
export interface ApiErrorBody {
  error: string;
  code: string;
  refused?: boolean;
  quote?: OfferQuote | RangeQuote | BreakoutQuote | null;
  /** On a basket that was refused: the leg that did not pass, from 0. */
  leg?: number;
}

// ------------------------------------------------------------------ executor: reconcile

/** `GET /reconcile`: executor `ReconcileReport` plus the order counts. */
export interface ReconcileResponse {
  venue: string;
  checkedAt: string;
  user: string;
  ordersChecked: number;
  ordersMatched: number;
  mismatches: { clientOrderId: string; ledger: string; gemini: string }[];
  untrackedOrders: number;
  untrackedCashFlow: number;
  /** YES and NO on one contract that Gemini cancelled against each other at once, paying $1 a pair early. */
  nettedContracts?: number;
  /** The cash those pairs already paid. Included in `expectedCash`. */
  nettedCash?: number;
  baselineCash: number | null;
  /** What cash should be, from our ledger. */
  expectedCash: number | null;
  /** What the account actually holds. */
  actualCash: number;
  cashDifference: number | null;
  betsNeedingReview: string[];
  /** Bets Gemini settled without a plain yes or no whose payout was read from the account and entered by hand. */
  betsResolvedByHand?: string[];
  ok: boolean;
}

// ------------------------------------------------------------------ chain service: calls and leaderboard

export type CallState = 'committed' | 'revealed' | 'void';

export interface CallRecord {
  id: string;
  /** Pseudonymous: a salted hash, never a Gemini account id. */
  handle: string;
  betId: string;
  state: CallState;
  commitHash: string;
  commitSignature: string;
  committedAt: string;
  /** `devnet` records are real transactions with an explorer link; `fake` ones come from the in-memory chain and have none. */
  network: 'devnet' | 'fake';
  /** Present once the user reveals. */
  reveal?: {
    signature: string;
    revealedAt: string;
    eventTitle: string;
    conditionLabel: string;
    targetLabel: string;
    fairPriceAtEntry: number;
    outcome: 0 | 1 | null;
    edge: number | null;
  };
}

/** A revealed call as the public sees it (`GET /reveals/:signature`): no salt, no account. */
export interface PublicReveal {
  signature: string;
  commitSignature: string;
  handle: string;
  /** Committed with the call, so it cannot be changed afterwards. It says what kind of bet this was (see `kindOfBetId`). */
  betId: string;
  event: string;
  condition: string;
  target: string;
  entryPrice: number;
  fairPrice: number;
  outcome: 0 | 1;
  edge: number;
  revealedAt: string;
  network: 'devnet' | 'fake';
  /** Public key of the key that signed the records. The proof page checks every transaction was signed by it. */
  authority: string;
  /** The given_receipts program that checks each record on chain, or null when records are Memos only. */
  program?: string | null;
}

export interface LeaderboardRow {
  rank: number;
  handle: string;
  calls: number;
  edge: number;
  hitRate: number;
  lastRevealedAt: string;
  /**
   * Every call this player has sealed on Solana, revealed or not. A commit carries the handle, so the count is public; set
   * beside `calls` (the revealed ones) it shows whether a record was built by revealing only the calls that came off.
   */
  sealed?: number;
  /** Sealed calls the service knows could never be revealed: the first half failed and the stake came back. */
  refunded?: number;
  /**
   * Up to five of this player's newest verified calls, each openable on /verify/:signature. `event`, `condition` and
   * `target` are the ticker and the two contract symbols the reveal published (absent from an older service).
   */
  recent?: { signature: string; betId: string; event?: string; condition?: string; target?: string; revealedAt: string; outcome: 0 | 1; edge: number }[];
}

export interface LeaderboardResponse {
  asOf: string;
  minCalls: number;
  source: 'quicknode-stream' | 'rpc';
  /** Which chain the rows were read from. `fake` is the in-memory test chain. */
  network: 'devnet' | 'fake';
  /**
   * The given_receipts program, which keeps a running score per player in its own accounts, or null when records are
   * Memos only. With `authorities` it is all a browser needs to read those scores from Solana itself (`lib/programBoard`).
   */
  program?: string | null;
  /** Public keys whose records the rows count. */
  authorities?: string[];
  rows: LeaderboardRow[];
}

export const explorerTx = (signature: string, cluster: 'devnet' | 'mainnet-beta' = 'devnet') =>
  `https://explorer.solana.com/tx/${signature}${cluster === 'devnet' ? '?cluster=devnet' : ''}`;
