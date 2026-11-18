/** Shapes returned by Gemini's prediction-market API, limited to the fields this service reads. */

export interface GeminiPrices {
  buy?: { yes?: string; no?: string };
  sell?: { yes?: string; no?: string };
  bestBid?: string | null;
  bestAsk?: string | null;
  lastTradePrice?: string | null;
}

export interface GeminiContract {
  id: string;
  label: string;
  ticker: string;
  instrumentSymbol: string;
  status: string;
  marketState?: string;
  expiryDate?: string;
  strike?: { type?: string; value?: string } | null;
  prices?: GeminiPrices | null;
  /** "yes" or "no" for a clean result; Gemini may report something else (or nothing) for a void or fractional settlement. */
  resolutionSide?: string | null;
  resolvedAt?: string | null;
  settlementValue?: string | null;
}

export interface GeminiEvent {
  id: string;
  title: string;
  ticker: string;
  category: string;
  status: string;
  type?: string;
  expiryDate?: string;
  contracts: GeminiContract[];
}

export type Outcome = 'yes' | 'no';
export type Side = 'buy' | 'sell';

/** A row from POST /v1/prediction-markets/orders/history or /orders/active. */
export interface GeminiOrderRecord {
  orderId: number | string;
  /** The same id as text, exact to the last digit. Preferred when present. */
  globalOrderId?: string;
  clientOrderId?: string;
  status: string;
  symbol: string;
  side: Side;
  outcome: Outcome;
  quantity: string;
  filledQuantity: string;
  remainingQuantity?: string;
  price: string;
  avgExecutionPrice?: string | null;
  timeInForce?: string;
  createdAt?: string;
}

export interface GeminiPosition {
  symbol: string;
  outcome: Outcome;
  totalQuantity: string;
  avgPrice: string;
}

/** Push message on the `orders@account` stream. */
export interface OrderUpdate {
  symbol: string;
  orderId: string;
  clientOrderId: string;
  side: 'BUY' | 'SELL';
  outcome: 'YES' | 'NO';
  /** NEW | PARTIALLY_FILLED | FILLED | CANCELED | REJECTED | EXPIRED */
  status: string;
  avgPrice?: string;
  reason?: string;
}

export interface BookTicker {
  /** Upper-cased instrument symbol. Prices are in YES space. */
  symbol: string;
  bid: number | null;
  bidSize: number | null;
  ask: number | null;
  askSize: number | null;
}

/** Resting orders at the top price levels of one contract, in YES prices. Each level is [price, size]. */
export interface DepthSnapshot {
  /** Upper-cased instrument symbol. */
  symbol: string;
  /** Highest first. */
  bids: Array<[number, number]>;
  /** Lowest first. */
  asks: Array<[number, number]>;
}
