/**
 * The contract between the web app and its two services.
 *
 * Executor types mirror `executor/src/api.ts` and `executor/src/ledger.ts`
 * (hosted service that places the two Gemini orders). Chain types describe the
 * service that commits and reveals calls on Solana and serves the leaderboard.
 * Anything marked "planned" does not exist on the executor yet; the mock
 * implements it so the UI can be built against it.
 */

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

export interface QuoteResponse {
  venue: string;
  asOf: string;
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
  role: 'outcome' | 'hedge' | 'unwind' | 'trigger';
  symbol: string;
  side: 'buy' | 'sell';
  outcome: 'yes' | 'no';
  limitPrice: number;
  quantityRequested: number;
  quantityFilled: number;
  avgPrice: number | null;
  fee: number;
  status: 'sent' | 'filled' | 'partial' | 'unfilled' | 'resting' | 'error';
  orderId?: string;
  sentAt: string;
  note?: string;
}

export type BetStatus = 'placing' | 'open' | 'unhedged' | 'unwound' | 'failed' | 'settled' | 'needs_review';

export interface BetFlow {
  orders: number;
  filled: number;
  contracts: number;
  premium: number;
  feesAtProductionRates: number;
}

export interface Bet {
  id: string;
  user: string;
  createdAt: string;
  eventTicker: string;
  eventTitle: string;
  expiry: string | null;
  condition: { symbol: string; label: string; strike: number };
  target: { symbol: string; label: string; strike: number };
  requestedStake: number;
  quotedPrice: number;
  status: BetStatus;
  legs: LegRecord[];
  cost: number;
  payoffs?: {
    stake: number;
    ifConditionFails: number;
    ifBothHit: number;
    ifConditionOnly: number;
    conditionalPrice: number | null;
    hedged: boolean;
  };
  offer?: OfferQuote;
  stakeReduced?: { requested: number; reducedTo: number; outcomeAvailable: number; conditionAvailable: number; reason: string };
  settlement?: {
    conditionResolved: 'yes' | 'no';
    targetResolved: 'yes' | 'no';
    payout: number;
    profit: number;
    settledAt?: string;
  };
  scorable: boolean;
  flow: BetFlow;
}

export interface PlaceBetRequest {
  user: string;
  event: string;
  condition: string;
  target: string;
  stake: number;
  maxPrice?: number;
  slippageTicks?: number;
  onHedgeFail?: 'unwind' | 'leave';
}

export interface PlaceBetResponse {
  bet: Bet;
  stakeReduced: Bet['stakeReduced'] | null;
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
  users: { user: string; connected: boolean | null }[];
  time: string;
}

/** Shape of every error body from the executor. */
export interface ApiErrorBody {
  error: string;
  code: string;
  refused?: boolean;
  quote?: OfferQuote | null;
}

// ------------------------------------------------------------------ executor: planned

export interface ReconcileResponse {
  ok: boolean;
  checkedAt: string;
  orders: { checked: number; matched: number; missing: number };
  cash: { ledger: number; gemini: number; difference: number };
  betsNeedingReview: string[];
}

// ------------------------------------------------------------------ chain service (planned)

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

export interface LeaderboardRow {
  rank: number;
  handle: string;
  calls: number;
  edge: number;
  hitRate: number;
  lastRevealedAt: string;
}

export interface LeaderboardResponse {
  asOf: string;
  minCalls: number;
  source: 'quicknode-stream' | 'rpc';
  rows: LeaderboardRow[];
}

export const explorerTx = (signature: string, cluster: 'devnet' | 'mainnet-beta' = 'devnet') =>
  `https://explorer.solana.com/tx/${signature}${cluster === 'devnet' ? '?cluster=devnet' : ''}`;
