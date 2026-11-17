use anchor_lang::prelude::*;

pub const MAX_BET_ID: usize = 16;
pub const MAX_HANDLE: usize = 24;
pub const MAX_TICKER: usize = 32;
pub const MAX_SYMBOL: usize = 64;

/// Dollar amounts are micro-USD (6 decimals, like USDC). `price` is the
/// conditional price per $1 of payout on the same scale, so 1_000_000 = $1.00.
pub const PRICE_ONE: u32 = 1_000_000;

#[account]
#[derive(InitSpace)]
pub struct Config {
    /// May rotate the recorder.
    pub admin: Pubkey,
    /// The executor's key: the only signer allowed to write receipts.
    pub recorder: Pubkey,
    pub calls: u64,
    pub settled: u64,
    pub bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub enum CallStatus {
    Open,
    Settled,
}

/// One conditional call: "given <condition>, will <target>?", placed on Gemini
/// as YES on the target plus a sized NO on the condition.
#[account]
#[derive(InitSpace)]
pub struct CallReceipt {
    /// Order of recording, starting at 0.
    pub seq: u64,
    /// Wallet the call is attributed to on the leaderboard.
    pub caller: Pubkey,
    /// The executor's ledger id for the bet.
    #[max_len(MAX_BET_ID)]
    pub bet_id: String,
    #[max_len(MAX_HANDLE)]
    pub handle: String,
    #[max_len(MAX_TICKER)]
    pub event_ticker: String,
    #[max_len(MAX_SYMBOL)]
    pub condition_symbol: String,
    #[max_len(MAX_SYMBOL)]
    pub target_symbol: String,
    pub condition_strike: i64,
    pub target_strike: i64,
    /// Dollars spent across both legs.
    pub stake: u64,
    pub price: u32,
    /// Gross payout if the condition holds and the target hits.
    pub payout_if_hit: u64,
    /// True when a failed condition returns the stake.
    pub hedged: bool,
    pub placed_at: i64,
    /// 0 when the event has no published expiry.
    pub expiry: i64,
    /// SHA-256 of the bet's Gemini order legs, so the receipt can be checked
    /// against exchange order history.
    pub evidence: [u8; 32],
    pub recorded_at: i64,
    pub status: CallStatus,
    pub condition_held: bool,
    pub target_hit: bool,
    pub payout: u64,
    pub pnl: i64,
    pub settled_at: i64,
    pub bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct RecordCallArgs {
    pub bet_id: String,
    pub caller: Pubkey,
    pub handle: String,
    pub event_ticker: String,
    pub condition_symbol: String,
    pub target_symbol: String,
    pub condition_strike: i64,
    pub target_strike: i64,
    pub stake: u64,
    pub price: u32,
    pub payout_if_hit: u64,
    pub hedged: bool,
    pub placed_at: i64,
    pub expiry: i64,
    pub evidence: [u8; 32],
}

#[event]
pub struct CallRecorded {
    pub seq: u64,
    pub bet_id: String,
    pub caller: Pubkey,
    pub handle: String,
    pub event_ticker: String,
    pub condition_symbol: String,
    pub target_symbol: String,
    pub condition_strike: i64,
    pub target_strike: i64,
    pub stake: u64,
    pub price: u32,
    pub payout_if_hit: u64,
    pub hedged: bool,
    pub placed_at: i64,
    pub expiry: i64,
    pub evidence: [u8; 32],
    pub recorded_at: i64,
}

#[event]
pub struct CallSettled {
    pub seq: u64,
    pub bet_id: String,
    pub caller: Pubkey,
    pub handle: String,
    pub condition_held: bool,
    pub target_hit: bool,
    pub stake: u64,
    pub payout: u64,
    pub pnl: i64,
    pub settled_at: i64,
}
