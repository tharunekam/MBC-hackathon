use anchor_lang::prelude::*;

pub const MAX_BET_ID: usize = 16;
pub const MAX_HANDLE: usize = 24;
pub const MAX_TICKER: usize = 32;
pub const MAX_SYMBOL: usize = 64;

/// Prices are micro-dollars per $1 of payout, so 1_000_000 = $1.00. Edge is on
/// the same scale.
pub const PRICE_ONE: u32 = 1_000_000;

/// Prefix of every commitment, so a hash made for anything else can never pass
/// as one.
pub const COMMIT_DOMAIN: &[u8] = b"given:call:v1";

#[account]
#[derive(InitSpace)]
pub struct Config {
    /// May rotate the recorder.
    pub admin: Pubkey,
    /// The chain service's key: the only signer allowed to commit and reveal.
    pub recorder: Pubkey,
    pub commits: u64,
    pub reveals: u64,
    pub bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub enum CallState {
    /// Only the hash is on chain. Nothing about the call can be read from it.
    Committed,
    /// The caller chose to publish it and the program checked it against the hash.
    Revealed,
}

/// What a commitment hides until its caller reveals it: "given <condition>,
/// will <target>?", placed on Gemini as two orders. No stake, payout or profit:
/// the leaderboard scores judgement, not size.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug, Default, PartialEq, Eq, InitSpace)]
pub struct CallDetails {
    /// The executor's ledger id for the bet.
    #[max_len(MAX_BET_ID)]
    pub bet_id: String,
    /// Pseudonymous handle the call is scored under. Never a Gemini account id.
    #[max_len(MAX_HANDLE)]
    pub handle: String,
    #[max_len(MAX_TICKER)]
    pub event_ticker: String,
    #[max_len(MAX_SYMBOL)]
    pub condition_symbol: String,
    #[max_len(MAX_SYMBOL)]
    pub target_symbol: String,
    /// Fair price of the call when it was placed: the chance the target hits
    /// given the condition holds, with no spread and no fees.
    pub fair_price: u32,
    pub placed_at: i64,
    /// When the event closes. A call must be committed before this and can be
    /// revealed only after it.
    pub expiry: i64,
    /// SHA-256 of the bet's Gemini order legs, so a revealed call can be
    /// checked against exchange order history.
    pub evidence: [u8; 32],
}

/// One call. Created by `commit_call` holding only the hash; `reveal_call`
/// fills in the rest.
#[account]
#[derive(InitSpace)]
pub struct CallRecord {
    /// Order of commitment, starting at 0.
    pub seq: u64,
    /// sha256(COMMIT_DOMAIN || borsh(CallDetails) || salt)
    pub commit: [u8; 32],
    pub committed_at: i64,
    pub state: CallState,
    pub bump: u8,
    // Everything below is zero or empty until the call is revealed.
    pub revealed_at: i64,
    pub target_hit: bool,
    /// (1.00 if the target hit, else 0) minus the fair price at entry.
    pub edge: i64,
    pub details: CallDetails,
}

/// Running score for one handle, updated on every reveal, so the leaderboard
/// can be rebuilt from accounts alone.
#[account]
#[derive(InitSpace)]
pub struct CallerStats {
    #[max_len(MAX_HANDLE)]
    pub handle: String,
    pub calls: u32,
    pub hits: u32,
    pub edge_sum: i64,
    pub last_revealed_at: i64,
    pub bump: u8,
}

#[event]
pub struct CallCommitted {
    pub seq: u64,
    pub commit: [u8; 32],
    pub committed_at: i64,
}

#[event]
pub struct CallRevealed {
    pub seq: u64,
    pub commit: [u8; 32],
    pub committed_at: i64,
    pub revealed_at: i64,
    pub target_hit: bool,
    pub edge: i64,
    pub details: CallDetails,
}
