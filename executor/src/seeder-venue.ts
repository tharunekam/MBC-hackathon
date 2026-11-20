import type { GeminiExchange } from './exchange.ts';
import type { SeederVenue } from './seeder.ts';

/** The seeder's view of Gemini: depth with sizes, resting orders by tag, and the same order entry the executor uses. */
export function geminiVenue(exchange: GeminiExchange): SeederVenue {
  return {
    getEvent: (ticker) => exchange.getEvent(ticker),
    depth: (symbol) => exchange.ws.depth(symbol),
    place: (req) => exchange.placeOrder(req),
    cancel: (orderId) => exchange.cancelOrder(orderId),
    openOrders: async () =>
      (await exchange.rest.activeOrders()).map((rec) => ({
        orderId: rec.globalOrderId ?? String(rec.orderId),
        filledQuantity: Number(rec.filledQuantity ?? 0) || 0,
        avgPrice: null,
        open: rec.status === 'open',
        clientOrderId: rec.clientOrderId ?? '',
        symbol: rec.symbol,
        side: rec.side,
        createdAt: rec.createdAt ?? null,
      })),
    cash: () => exchange.cash(),
  };
}
