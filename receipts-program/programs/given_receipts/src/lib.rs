//! Given receipts: the on-chain check behind Given's commit-reveal calls.
//!
//! The chain service (`chain/`) writes each record as a Memo and, in the same
//! transaction, calls this program. When a bet fills it commits a salted hash:
//! nothing about the trade can be read from it. After the bet settles the
//! caller may reveal, and this program recomputes the hash from the revealed
//! fields, refuses anything that differs or was revealed before, scores the
//! call and adds it to the handle's running total.
//!
//! There is no admin and no setup. Every record is filed under the key that
//! signed it, so anyone may use the program and a reader counts only the
//! authority it trusts, the same rule the Memo records follow.

pub mod error;
pub mod state;

use anchor_lang::prelude::*;

pub use error::ReceiptError;
pub use state::*;

declare_id!("8q9jn7HyWs9HCFvS2N3RpRtZBuUdJHCeVq4Yp4Hs1YNK");

pub const CALL_SEED: &[u8] = b"call";
pub const CALLER_SEED: &[u8] = b"caller";

const SEPARATOR: char = '|';
const HEX: &[u8; 16] = b"0123456789abcdef";

fn check_field(s: &str) -> Result<()> {
    require!(
        !s.is_empty() && s.len() <= MAX_FIELD && !s.contains(SEPARATOR),
        ReceiptError::BadField
    );
    Ok(())
}

/// A price in millionths as JavaScript's `toFixed(6)` prints it: 437_500 is "0.437500".
fn fixed6(millionths: u64) -> String {
    format!("{}.{:06}", millionths / 1_000_000, millionths % 1_000_000)
}

/// The exact text that is hashed. It must stay byte-for-byte equal to
/// `preimage` in `chain/src/hash.ts`; a test pins both to the same example.
#[allow(clippy::too_many_arguments)]
pub fn preimage(
    bet_id: &str,
    event: &str,
    condition: &str,
    target: &str,
    entry_price: u64,
    fair_price: u32,
    at: i64,
    salt: &[u8; 16],
) -> String {
    let mut salt_hex = String::with_capacity(32);
    for byte in salt {
        salt_hex.push(HEX[(byte >> 4) as usize] as char);
        salt_hex.push(HEX[(byte & 15) as usize] as char);
    }
    [
        PREIMAGE_VERSION,
        bet_id,
        event,
        condition,
        target,
        &fixed6(entry_price),
        &fixed6(u64::from(fair_price)),
        &at.to_string(),
        &salt_hex,
    ]
    .join("|")
}

pub fn hash_of(text: &str) -> [u8; 32] {
    solana_sha256_hasher::hashv(&[text.as_bytes()]).to_bytes()
}

#[program]
pub mod given_receipts {
    use super::*;

    /// Commits to a call without publishing it. One record per authority and
    /// hash: committing the same hash twice fails.
    pub fn commit_call(ctx: Context<CommitCall>, hash: [u8; 32], handle: String, at: i64) -> Result<()> {
        require!(!handle.is_empty() && handle.len() <= MAX_HANDLE, ReceiptError::BadHandle);
        let now = Clock::get()?.unix_timestamp;

        let call = &mut ctx.accounts.call;
        call.authority = ctx.accounts.authority.key();
        call.hash = hash;
        call.handle = handle.clone();
        call.at = at;
        call.committed_at = now;
        call.state = CallState::Committed;
        call.revealed_at = 0;
        call.outcome = false;
        call.fair_price = 0;
        call.edge = 0;
        call.bump = ctx.bumps.call;

        emit!(CallCommitted {
            authority: call.authority,
            hash,
            handle,
            at,
            committed_at: now,
        });
        Ok(())
    }

    /// Publishes a committed call and scores it. The fields and salt must hash
    /// to what was committed. Only a call whose condition held is ever
    /// revealed, so the result is just whether the target hit.
    #[allow(clippy::too_many_arguments)]
    pub fn reveal_call(
        ctx: Context<RevealCall>,
        bet_id: String,
        event: String,
        condition: String,
        target: String,
        entry_price: u64,
        fair_price: u32,
        salt: [u8; 16],
        outcome: bool,
    ) -> Result<()> {
        check_field(&bet_id)?;
        check_field(&event)?;
        check_field(&condition)?;
        check_field(&target)?;
        require!(fair_price <= PRICE_ONE, ReceiptError::BadPrice);

        let now = Clock::get()?.unix_timestamp;
        let call = &mut ctx.accounts.call;
        require!(call.state == CallState::Committed, ReceiptError::AlreadyRevealed);
        let text = preimage(&bet_id, &event, &condition, &target, entry_price, fair_price, call.at, &salt);
        require!(hash_of(&text) == call.hash, ReceiptError::HashMismatch);

        let won: i64 = if outcome { i64::from(PRICE_ONE) } else { 0 };
        let edge = won - i64::from(fair_price);

        call.state = CallState::Revealed;
        call.revealed_at = now;
        call.outcome = outcome;
        call.fair_price = fair_price;
        call.edge = edge;

        let stats = &mut ctx.accounts.stats;
        if stats.handle.is_empty() {
            stats.authority = call.authority;
            stats.handle = call.handle.clone();
            stats.bump = ctx.bumps.stats;
        }
        stats.calls = stats.calls.checked_add(1).ok_or(ReceiptError::Overflow)?;
        if outcome {
            stats.hits = stats.hits.checked_add(1).ok_or(ReceiptError::Overflow)?;
        }
        stats.edge_sum = stats.edge_sum.checked_add(edge).ok_or(ReceiptError::Overflow)?;
        stats.last_revealed_at = now;

        emit!(CallRevealed {
            authority: call.authority,
            hash: call.hash,
            handle: call.handle.clone(),
            bet_id,
            event,
            condition,
            target,
            entry_price,
            fair_price,
            at: call.at,
            committed_at: call.committed_at,
            revealed_at: now,
            outcome,
            edge,
        });
        Ok(())
    }
}

#[derive(Accounts)]
#[instruction(hash: [u8; 32])]
pub struct CommitCall<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        init,
        payer = authority,
        space = 8 + CallRecord::INIT_SPACE,
        seeds = [CALL_SEED, authority.key().as_ref(), hash.as_ref()],
        bump
    )]
    pub call: Account<'info, CallRecord>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RevealCall<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    /// The seeds include the signer, so only the key that committed a call can reveal it.
    #[account(
        mut,
        seeds = [CALL_SEED, authority.key().as_ref(), call.hash.as_ref()],
        bump = call.bump
    )]
    pub call: Account<'info, CallRecord>,
    #[account(
        init_if_needed,
        payer = authority,
        space = 8 + CallerStats::INIT_SPACE,
        seeds = [CALLER_SEED, authority.key().as_ref(), call.handle.as_bytes()],
        bump
    )]
    pub stats: Account<'info, CallerStats>,
    pub system_program: Program<'info, System>,
}
