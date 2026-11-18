use anchor_lang::prelude::*;

/// A handle is also a PDA seed, and a seed holds at most 32 bytes.
pub const MAX_HANDLE: usize = 32;
/// Longest bet id, event ticker or contract symbol (the chain service's memo parser uses the same limit).
pub const MAX_FIELD: usize = 128;
/// Prices are per $1, in millionths: 1.00 is 1_000_000.
pub const PRICE_ONE: u32 = 1_000_000;
/// First field of the hashed text. Must match `PREIMAGE_VERSION` in `chain/src/hash.ts`.
pub const PREIMAGE_VERSION: &str = "given1";

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub enum CallState {
    Committed,
    Revealed,
}

/// One call. Until it is revealed it holds a hash, a pseudonymous handle and
/// two times, and nothing about the trade.
#[account]
#[derive(InitSpace)]
pub struct CallRecord {
    /// The key that wrote this record. Readers count only the authority they trust.
    pub authority: Pubkey,
    /// sha256 of the call's preimage (see `preimage`).
    pub hash: [u8; 32],
    #[max_len(MAX_HANDLE)]
    pub handle: String,
    /// The time the service gave the call. It is part of the hash.
    pub at: i64,
    /// The chain's own clock when the hash was written.
    pub committed_at: i64,
    pub state: CallState,
    pub revealed_at: i64,
    /// True if the target hit. Attested by the authority; no hash can cover it.
    pub outcome: bool,
    pub fair_price: u32,
    /// (1.00 if the target hit, else 0) minus the fair price, in millionths.
    pub edge: i64,
    pub bump: u8,
}

/// Running score of one handle under one authority. The leaderboard can be
/// read from these accounts alone, without replaying any history.
#[account]
#[derive(InitSpace)]
pub struct CallerStats {
    pub authority: Pubkey,
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
    pub authority: Pubkey,
    pub hash: [u8; 32],
    pub handle: String,
    pub at: i64,
    pub committed_at: i64,
}

#[event]
pub struct CallRevealed {
    pub authority: Pubkey,
    pub hash: [u8; 32],
    pub handle: String,
    pub bet_id: String,
    pub event: String,
    pub condition: String,
    pub target: String,
    pub entry_price: u64,
    pub fair_price: u32,
    pub at: i64,
    pub committed_at: i64,
    pub revealed_at: i64,
    pub outcome: bool,
    pub edge: i64,
}
