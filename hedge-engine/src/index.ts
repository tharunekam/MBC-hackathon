import express, { Request, Response } from 'express';
import crypto from 'crypto';
import axios from 'axios';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3001;
const GEMINI_API_URL = process.env.GEMINI_API_URL || 'https://api.gemini.com';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || 'sandbox-api-key';
const GEMINI_API_SECRET = process.env.GEMINI_API_SECRET || 'sandbox-secret';

// State tracker for aggregate inventory
interface ExposureState {
  netYesDelta: number;
  lastHedgedNonce: number;
  totalVolumeGeneratedUsd: number;
}

const exposure: ExposureState = {
  netYesDelta: 0,
  lastHedgedNonce: 0,
  totalVolumeGeneratedUsd: 0,
};

/**
 * Creates an authenticated Gemini API request with custom sub-broker attribution
 */
function createGeminiAuthHeaders(payloadObj: Record<string, any>) {
  const payloadJson = JSON.stringify(payloadObj);
  const payloadBase64 = Buffer.from(payloadJson).toString('base64');
  const signature = crypto
    .createHmac('sha384', GEMINI_API_SECRET)
    .update(payloadBase64)
    .digest('hex');

  return {
    'Content-Type': 'text/plain',
    'Content-Length': '0',
    'X-GEMINI-APIKEY': GEMINI_API_KEY,
    'X-GEMINI-PAYLOAD': payloadBase64,
    'X-GEMINI-SIGNATURE': signature,
    // Custom Broker attribution header for 100% auditable flow tracking
    'gemini-client': 'living-tokens-v1',
  };
}

/**
 * Submits an offsetting hedge order on Gemini's Central Limit Order Book
 */
async function executeGeminiHedge(symbol: string, side: 'buy' | 'sell', amount: number, maxPrice: string) {
  const nonce = Date.now();
  const payload = {
    request: '/v1/order/new',
    nonce: nonce.toString(),
    symbol,
    amount: amount.toString(),
    price: maxPrice,
    side,
    type: 'exchange limit',
    client_order_id: `lt_hedge_${nonce}`,
  };

  try {
    const headers = createGeminiAuthHeaders(payload);
    console.log(`[HedgeEngine] Submitting ${side.toUpperCase()} hedge to Gemini: ${amount} contracts of ${symbol} at max ${maxPrice}`);
    
    // In production or sandbox:
    // const res = await axios.post(`${GEMINI_API_URL}/v1/order/new`, null, { headers });
    // console.log(`[HedgeEngine] Gemini Order Executed: OrderID ${res.data.order_id}`);

    // Track simulated / executed volume for dashboard audit
    exposure.totalVolumeGeneratedUsd += amount * parseFloat(maxPrice);
    return { status: 'success', simulatedOrderId: `gemini_${nonce}` };
  } catch (error: any) {
    console.error('[HedgeEngine] Failed to execute Gemini order:', error.response?.data || error.message);
    throw error;
  }
}

/**
 * QuickNode Streams Webhook Endpoint
 * Ingests real-time events emitted by the Solana Living Tokens Program
 */
app.post('/webhook/quicknode-stream', async (req: Request, res: Response) => {
  const events = req.body;
  console.log(`[QuickNode Stream] Received ${Array.isArray(events) ? events.length : 1} onchain event(s)`);

  const eventList = Array.isArray(events) ? events : [events];

  for (const event of eventList) {
    const { event_type, market_symbol, outcome, amount_claims, price_reference } = event;

    if (event_type === 'ClaimPurchased' || event_type === 'UnderdogStampMinted') {
      console.log(`[QuickNode Stream] Detected retail demand: ${amount_claims} ${outcome} claims on ${market_symbol}`);
      
      // Update inventory delta
      if (outcome === 'YES') {
        exposure.netYesDelta += amount_claims;
      } else {
        exposure.netYesDelta -= amount_claims;
      }

      // If delta crosses threshold, execute automated hedge on Gemini
      const HEDGE_BATCH_THRESHOLD = 50;
      if (Math.abs(exposure.netYesDelta) >= HEDGE_BATCH_THRESHOLD) {
        const contractsToHedge = Math.abs(exposure.netYesDelta);
        const hedgeSide = exposure.netYesDelta > 0 ? 'buy' : 'sell';
        const referencePrice = price_reference ? price_reference.toString() : '0.15';

        await executeGeminiHedge(market_symbol || 'txyes2026', hedgeSide, contractsToHedge, referencePrice);
        exposure.netYesDelta = 0; // Reconciled
      }
    }
  }

  res.status(200).json({ status: 'processed', exposure });
});

app.get('/health', (req: Request, res: Response) => {
  res.json({
    service: 'Living Tokens Hedge Engine',
    uptime: process.uptime(),
    exposure,
    geminiBrokerTag: 'living-tokens-v1',
  });
});

app.listen(PORT, () => {
  console.log(`[HedgeEngine] QuickNode stream listener running on port ${PORT}`);
  console.log(`[HedgeEngine] Gemini Sub-Broker Tag: living-tokens-v1`);
});
