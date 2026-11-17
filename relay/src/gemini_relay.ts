import WebSocket from 'ws';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import dotenv from 'dotenv';

dotenv.config();

const GEMINI_WS_URL = process.env.GEMINI_WS_URL || 'wss://api.gemini.com/v1/marketdata/txyes2026';
const SOLANA_RPC_URL = process.env.QUICKNODE_SOLANA_RPC || 'https://api.devnet.solana.com';

console.log('[Relay] Initializing Gemini Market Data Relay...');
console.log(`[Relay] Subscribing to: ${GEMINI_WS_URL}`);
console.log(`[Relay] Solana Endpoint: ${SOLANA_RPC_URL}`);

interface MarketState {
  lastPriceBps: number;
  bidDepth: number;
  askDepth: number;
  isResolved: boolean;
  outcome?: 'YES' | 'NO';
}

const state: MarketState = {
  lastPriceBps: 800, // 8.0%
  bidDepth: 25000,
  askDepth: 18000,
  isResolved: false,
};

function connectGeminiWs() {
  const ws = new WebSocket(GEMINI_WS_URL);

  ws.on('open', () => {
    console.log('[Relay] Connected to Gemini Market Data stream');
  });

  ws.on('message', (data: string) => {
    try {
      const msg = JSON.parse(data);
      if (msg.type === 'update' && msg.events) {
        for (const ev of msg.events) {
          if (ev.type === 'trade') {
            const price = parseFloat(ev.price);
            state.lastPriceBps = Math.round(price * 10000);
            console.log(`[Relay] Gemini Trade observed: ${ev.price} (${(price * 100).toFixed(1)}%) -> ${state.lastPriceBps} bps`);
            
            // Push update onchain when significant move occurs
            pushOracleUpdateToSolana(state.lastPriceBps, 'Active');
          } else if (ev.type === 'settlement') {
            state.isResolved = true;
            state.outcome = ev.outcome;
            console.log(`[Relay] Gemini Market Settled: ${ev.outcome}`);
            pushOracleUpdateToSolana(ev.outcome === 'YES' ? 10000 : 0, ev.outcome === 'YES' ? 'SettledYes' : 'SettledNo');
          }
        }
      }
    } catch (e) {
      // Mock / heartbeat logging
    }
  });

  ws.on('close', () => {
    console.warn('[Relay] Gemini WebSocket closed. Reconnecting in 3s...');
    setTimeout(connectGeminiWs, 3000);
  });

  ws.on('error', (err) => {
    console.error('[Relay] WebSocket error:', err.message);
  });
}

/**
 * Pushes the signed odds and status update to the Solana Living Tokens Program
 */
async function pushOracleUpdateToSolana(oddsBps: number, status: string) {
  console.log(`[Relay -> Solana] Submitting signed Oracle update: ${oddsBps} bps | Status: ${status}`);
  // In production: Builds and signs instruction `update_oracle_state` using relay keypair
}

// Start listener
connectGeminiWs();
