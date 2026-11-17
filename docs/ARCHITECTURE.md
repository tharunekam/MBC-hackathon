# 🏗️ Technical Architecture: Living Tokens System

This document outlines the detailed system architecture, smart contract specifications, QuickNode event streaming pipeline, and Gemini hedging integration.

---

## 1. System Topology Overview

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                             SOLANA RUNTIME                                  │
│                                                                             │
│   ┌───────────────────────────┐         ┌───────────────────────────────┐   │
│   │    Living Tokens Vault    │         │       Token-2022 Mints        │   │
│   │  (1 USDC = 1 YES + 1 NO)  │◄────────┤  • $HORNS (ScaledUiAmount)    │   │
│   └─────────────┬─────────────┘         │  • Dynamic Metadata Pointer   │   │
│                 │                       └───────────────────────────────┘   │
│                 ▼                                                           │
│   ┌───────────────────────────┐         ┌───────────────────────────────┐   │
│   │   Underdog Stamp Escrow   │         │     Autonomous Trophy Escrow  │   │
│   │  (Wraps YES Claims + Odds)│         │     (Condition-Bound Delivery)│   │
│   └─────────────┬─────────────┘         └───────────────▲───────────────┘   │
└─────────────────┼───────────────────────────────────────┼───────────────────┘
                  │ Solana Program Events                 │ Settlement / Odds
                  ▼                                       │
┌──────────────────────────────────────┐  ┌───────────────┴───────────────────┐
│          QUICKNODE STREAMS           │  │        GEMINI ORACLE RELAY        │
│ • Filters Program ID Events          │  │ • Subscribes to Gemini Market WS  │
│ • Webhook Delivery (<250ms)          │  │ • Pushes Signed Price & Outcome   │
└─────────────────┬────────────────────┘  └───────────────▲───────────────────┘
                  │                                       │
                  ▼                                       │
┌─────────────────────────────────────────────────────────┴───────────────────┐
│                     OFFCHAIN HEDGE & MAKER ENGINE                           │
│                                                                             │
│   1. Calculates Net Directional Delta (Σ YES_claims - Σ NO_claims)          │
│   2. Checks Inventory Limits & Risk Thresholds                              │
│   3. Dispatches Hedging Orders via Gemini REST API                          │
│   4. Maintains Resting Two-Sided Liquidity Quotes                           │
│   5. Tags All Orders with 'gemini-client: living-tokens-v1'                  │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Solana Smart Contracts (`Anchor`)

### A. Program Accounts

```rust
#[account]
pub struct EventSpace {
    pub creator: Pubkey,
    pub gemini_market_id: [u8; 32],
    pub collateral_vault: Pubkey,
    pub yes_mint: Pubkey,
    pub no_mint: Pubkey,
    pub total_collateral: u64,
    pub current_odds_bps: u16,        // e.g., 850 = 8.5%
    pub status: EventStatus,          // Open, Paused, SettledYes, SettledNo, Invalid
    pub underdog_threshold_bps: u16,  // e.g., 1000 = 10.0%
    pub bump: u8,
}

#[account]
pub struct UnderdogStamp {
    pub owner: Pubkey,
    pub event_space: Pubkey,
    pub wrapped_claims_amount: u64,   // Number of YES claims locked
    pub mint_odds_bps: u16,           // Immutable proof of entry odds
    pub mint_timestamp: i64,          // Block time when minted
    pub is_redeemed: bool,
    pub bump: u8,
}

#[account]
pub struct TrophyEscrow {
    pub event_space: Pubkey,
    pub nft_mint: Pubkey,
    pub yes_beneficiary: Pubkey,      // e.g. Texas Alumni DAO Treasury
    pub no_beneficiary: Pubkey,       // e.g. Rival Alumni DAO Treasury
    pub prize_pot_amount: u64,        // Escrowed USDC prize
    pub is_distributed: bool,
    pub bump: u8,
}
```

### B. SPL Token-2022 Extensions Implementation

1. **`ScaledUiAmount` Extension:**
   - Instead of inflationary rebasing (which alters token share amounts and creates accounting chaos), the $HORNS token uses Token-2022's native `ScaledUiAmount`.
   - **Formula:**
     $$\text{UI Display} = \text{Raw Balance} \times \left( \frac{\text{Current Odds Bps}}{\text{Base Reference Bps}} \right)$$
   - When Texas is at 8%, 100 raw claims display as **8.00 $HORNS**.
   - When Texas moves to 35%, the exact same 100 raw claims display as **35.00 $HORNS**.
   - The user's visual wallet balance swells with market belief, while the underlying collateral backing remains 100% mathematically solvent.

2. **Dynamic Metadata Pointer:**
   - The Token-2022 Metadata Pointer references an onchain metadata account that updates its visual tier based on `current_odds_bps`:
     - `< 2000 bps`: *Underdog* (bronze border, muted banner).
     - `2000 - 5000 bps`: *Contender* (silver border, energetic banner).
     - `> 5000 bps`: *Favorite* (gold border, burning aura).
     - `Settled YES`: *Champion* (victory laurel crown).

3. **Transfer Hook (Front-Running Mitigation):**
   - The transfer hook validates that transfers cannot occur during active oracle relay update blocks, preventing toxic MEV latency arbitrage against slow price updates.

---

## 3. QuickNode Streams: Real-Time Event Dispatch

QuickNode Streams provides the real-time connective tissue between Solana execution and Gemini hedging.

### Stream Filter Rule
```json
{
  "network": "solana-mainnet",
  "program_id": "LivingTokens11111111111111111111111111111111",
  "instruction_filters": [
    { "name": "buy_claim", "discriminator": "0x4a12f8e1" },
    { "name": "mint_underdog_stamp", "discriminator": "0x89b2c3a5" },
    { "name": "unwrap_stamp", "discriminator": "0x12c4d9e0" }
  ]
}
```

### Stream Payload Handling
When a user buys $HORNS or mints an Underdog Stamp:
1. QuickNode Streams captures the confirmed Solana block event.
2. Emits an HTTP POST webhook to the Hedge Engine endpoint within **<250ms**.
3. The payload contains:
   ```json
   {
     "event_type": "ClaimPurchased",
     "market_id": "GEMINI_CFB_TEXAS_2026",
     "outcome": "YES",
     "amount_claims": 1000000000,
     "usdc_paid": 80000000,
     "signature": "5K...solana_tx_hash",
     "timestamp": 1794881000
   }
   ```

---

## 4. Offchain Hedge Engine & Gemini API Execution

### Delta Calculation & Hedging Algorithm

$$\Delta_{\text{net}} = \sum \text{Claims}_{\text{YES\_Customer}} - \sum \text{Claims}_{\text{NO\_Customer}}$$

If $\Delta_{\text{net}} > \text{Threshold}$ (e.g. 50 contracts):
1. **Check Gemini Orderbook:** Fetch top-of-book ask depth on the corresponding contract (`GEMINI_CFB_TEXAS_2026_YES`).
2. **Execute Taker Hedge:**
   - Method: `POST https://api.gemini.com/v1/order/new`
   - Headers:
     ```http
     Content-Type: application/json
     X-GEMINI-APIKEY: <API_KEY>
     X-GEMINI-PAYLOAD: <BASE64_PAYLOAD>
     X-GEMINI-SIGNATURE: <HMAC_SHA384>
     gemini-client: living-tokens-v1
     ```
   - Payload:
     ```json
     {
       "request": "/v1/order/new",
       "nonce": "1794881000123",
       "symbol": "txyes2026",
       "amount": "100",
       "price": "0.09",
       "side": "buy",
       "type": "exchange limit",
       "client_order_id": "lt_hedge_5K...tx"
     }
     ```
3. **Resting Liquidity Quoting:**
   - When not actively hedging taker delta, the engine places passive two-sided limit orders at $\pm 1\text{ tick}$ around fair value to earn maker rebates and qualify for Gemini's **Prediction Market Liquidity Rewards Program**.
