//! Given receipts: a commit-reveal record of conditional calls placed on
//! Gemini.
//!
//! When a bet fills, the chain service commits a salted hash of the call. The
//! hash identifies nobody and says nothing about the trade. After the event
//! closes the caller may reveal: this program checks the revealed call against
//! the hash, checks the commitment was made before the event closed, scores it
//! and adds it to the caller's running total. The leaderboard is built from
//! the `CallRevealed` events.

pub mod error;
pub mod state;

use anchor_lang::prelude::*;

pub use error::ReceiptError;
pub use state::*;

declare_id!("8q9jn7HyWs9HCFvS2N3RpRtZBuUdJHCeVq4Yp4Hs1YNK");

pub const CONFIG_SEED: &[u8] = b"config";
pub const CALL_SEED: &[u8] = b"call";
pub const CALLER_SEED: &[u8] = b"caller";

fn check_len(s: &str, max: usize) -> Result<()> {
    require!(!s.is_empty() && s.len() <= max, ReceiptError::BadLength);
    Ok(())
}

/// sha256(COMMIT_DOMAIN || borsh(details) || salt)
pub fn commit_hash(details: &CallDetails, salt: &[u8; 32]) -> Result<[u8; 32]> {
    let mut bytes = Vec::with_capacity(CallDetails::INIT_SPACE);
    details
        .serialize(&mut bytes)
        .map_err(|_| error!(ReceiptError::BadLength))?;
    Ok(solana_sha256_hasher::hashv(&[COMMIT_DOMAIN, &bytes, salt]).to_bytes())
}

#[program]
pub mod given_receipts {
    use super::*;

    /// One-time setup. The signer becomes admin and names the recorder.
    pub fn initialize(ctx: Context<Initialize>, recorder: Pubkey) -> Result<()> {
        let config = &mut ctx.accounts.config;
        config.admin = ctx.accounts.admin.key();
        config.recorder = recorder;
        config.commits = 0;
        config.reveals = 0;
        config.bump = ctx.bumps.config;
        Ok(())
    }

    pub fn set_recorder(ctx: Context<SetRecorder>, recorder: Pubkey) -> Result<()> {
        ctx.accounts.config.recorder = recorder;
        Ok(())
    }

    /// Commits to a call without publishing it. One record per hash:
    /// committing the same hash twice fails, so the service can retry safely.
    pub fn commit_call(ctx: Context<CommitCall>, commit: [u8; 32]) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let config = &mut ctx.accounts.config;
        let seq = config.commits;
        config.commits = seq.checked_add(1).ok_or(ReceiptError::Overflow)?;

        let call = &mut ctx.accounts.call;
        call.seq = seq;
        call.commit = commit;
        call.committed_at = now;
        call.state = CallState::Committed;
        call.bump = ctx.bumps.call;
        call.revealed_at = 0;
        call.target_hit = false;
        call.edge = 0;
        call.details = CallDetails::default();

        emit!(CallCommitted { seq, commit, committed_at: now });
        Ok(())
    }

    /// Publishes a committed call and scores it. Only a call whose condition
    /// held is ever revealed (a failed condition returns the stake and is not
    /// scored), so the result is just whether the target hit. The recorder
    /// attests that result; `details.evidence` ties it to the Gemini orders.
    pub fn reveal_call(
        ctx: Context<RevealCall>,
        details: CallDetails,
        salt: [u8; 32],
        target_hit: bool,
    ) -> Result<()> {
        check_len(&details.bet_id, MAX_BET_ID)?;
        check_len(&details.handle, MAX_HANDLE)?;
        check_len(&details.event_ticker, MAX_TICKER)?;
        check_len(&details.condition_symbol, MAX_SYMBOL)?;
        check_len(&details.target_symbol, MAX_SYMBOL)?;
        require!(
            details.fair_price > 0 && details.fair_price <= PRICE_ONE,
            ReceiptError::BadPrice
        );
        require!(details.expiry > 0, ReceiptError::NoExpiry);

        let now = Clock::get()?.unix_timestamp;
        let call = &mut ctx.accounts.call;
        require!(call.state == CallState::Committed, ReceiptError::AlreadyRevealed);
        require!(commit_hash(&details, &salt)? == call.commit, ReceiptError::HashMismatch);
        // The point of committing first: the call was fixed before anyone could
        // know how the event ended.
        require!(call.committed_at < details.expiry, ReceiptError::CommittedAfterExpiry);
        require!(now >= details.expiry, ReceiptError::NotExpiredYet);

        let won: i64 = if target_hit { i64::from(PRICE_ONE) } else { 0 };
        let edge = won - i64::from(details.fair_price);

        call.state = CallState::Revealed;
        call.revealed_at = now;
        call.target_hit = target_hit;
        call.edge = edge;
        call.details = details.clone();

        let stats = &mut ctx.accounts.stats;
        if stats.handle.is_empty() {
            stats.handle = details.handle.clone();
            stats.bump = ctx.bumps.stats;
        }
        stats.calls = stats.calls.checked_add(1).ok_or(ReceiptError::Overflow)?;
        if target_hit {
            stats.hits = stats.hits.checked_add(1).ok_or(ReceiptError::Overflow)?;
        }
        stats.edge_sum = stats.edge_sum.checked_add(edge).ok_or(ReceiptError::Overflow)?;
        stats.last_revealed_at = now;

        let config = &mut ctx.accounts.config;
        config.reveals = config.reveals.checked_add(1).ok_or(ReceiptError::Overflow)?;

        emit!(CallRevealed {
            seq: call.seq,
            commit: call.commit,
            committed_at: call.committed_at,
            revealed_at: now,
            target_hit,
            edge,
            details,
        });
        Ok(())
    }
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(
        init,
        payer = admin,
        space = 8 + Config::INIT_SPACE,
        seeds = [CONFIG_SEED],
        bump
    )]
    pub config: Account<'info, Config>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SetRecorder<'info> {
    pub admin: Signer<'info>,
    #[account(
        mut,
        seeds = [CONFIG_SEED],
        bump = config.bump,
        has_one = admin @ ReceiptError::NotAdmin
    )]
    pub config: Account<'info, Config>,
}

#[derive(Accounts)]
#[instruction(commit: [u8; 32])]
pub struct CommitCall<'info> {
    #[account(mut)]
    pub recorder: Signer<'info>,
    #[account(
        mut,
        seeds = [CONFIG_SEED],
        bump = config.bump,
        has_one = recorder @ ReceiptError::NotRecorder
    )]
    pub config: Account<'info, Config>,
    #[account(
        init,
        payer = recorder,
        space = 8 + CallRecord::INIT_SPACE,
        seeds = [CALL_SEED, commit.as_ref()],
        bump
    )]
    pub call: Account<'info, CallRecord>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(details: CallDetails)]
pub struct RevealCall<'info> {
    #[account(mut)]
    pub recorder: Signer<'info>,
    #[account(
        mut,
        seeds = [CONFIG_SEED],
        bump = config.bump,
        has_one = recorder @ ReceiptError::NotRecorder
    )]
    pub config: Account<'info, Config>,
    /// Any committed call; the handler checks the revealed details hash to it.
    #[account(mut)]
    pub call: Account<'info, CallRecord>,
    #[account(
        init_if_needed,
        payer = recorder,
        space = 8 + CallerStats::INIT_SPACE,
        seeds = [CALLER_SEED, details.handle.as_bytes()],
        bump
    )]
    pub stats: Account<'info, CallerStats>,
    pub system_program: Program<'info, System>,
}
