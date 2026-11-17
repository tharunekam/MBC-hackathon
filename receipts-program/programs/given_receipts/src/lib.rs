//! Given receipts: an on-chain record of every conditional call the executor
//! places on Gemini, and of how each one settled. The leaderboard is built
//! from the events this program emits.

pub mod error;
pub mod state;

use anchor_lang::prelude::*;

pub use error::ReceiptError;
pub use state::*;

declare_id!("8q9jn7HyWs9HCFvS2N3RpRtZBuUdJHCeVq4Yp4Hs1YNK");

pub const CONFIG_SEED: &[u8] = b"config";
pub const CALL_SEED: &[u8] = b"call";

fn check_len(s: &str, max: usize) -> Result<()> {
    require!(!s.is_empty() && s.len() <= max, ReceiptError::BadLength);
    Ok(())
}

#[program]
pub mod given_receipts {
    use super::*;

    /// One-time setup. The signer becomes admin and names the recorder.
    pub fn initialize(ctx: Context<Initialize>, recorder: Pubkey) -> Result<()> {
        let config = &mut ctx.accounts.config;
        config.admin = ctx.accounts.admin.key();
        config.recorder = recorder;
        config.calls = 0;
        config.settled = 0;
        config.bump = ctx.bumps.config;
        Ok(())
    }

    pub fn set_recorder(ctx: Context<SetRecorder>, recorder: Pubkey) -> Result<()> {
        ctx.accounts.config.recorder = recorder;
        Ok(())
    }

    /// Writes the receipt for a placed call. One receipt per bet id: recording
    /// the same bet twice fails, so the recorder can retry safely.
    pub fn record_call(ctx: Context<RecordCall>, args: RecordCallArgs) -> Result<()> {
        check_len(&args.bet_id, MAX_BET_ID)?;
        check_len(&args.handle, MAX_HANDLE)?;
        check_len(&args.event_ticker, MAX_TICKER)?;
        check_len(&args.condition_symbol, MAX_SYMBOL)?;
        check_len(&args.target_symbol, MAX_SYMBOL)?;
        require!(args.stake > 0, ReceiptError::ZeroStake);
        require!(args.price > 0 && args.price <= PRICE_ONE, ReceiptError::BadPrice);

        let now = Clock::get()?.unix_timestamp;
        let config = &mut ctx.accounts.config;
        let seq = config.calls;
        config.calls = seq.checked_add(1).ok_or(ReceiptError::Overflow)?;

        let r = &mut ctx.accounts.receipt;
        r.seq = seq;
        r.caller = args.caller;
        r.bet_id = args.bet_id.clone();
        r.handle = args.handle.clone();
        r.event_ticker = args.event_ticker.clone();
        r.condition_symbol = args.condition_symbol.clone();
        r.target_symbol = args.target_symbol.clone();
        r.condition_strike = args.condition_strike;
        r.target_strike = args.target_strike;
        r.stake = args.stake;
        r.price = args.price;
        r.payout_if_hit = args.payout_if_hit;
        r.hedged = args.hedged;
        r.placed_at = args.placed_at;
        r.expiry = args.expiry;
        r.evidence = args.evidence;
        r.recorded_at = now;
        r.status = CallStatus::Open;
        r.condition_held = false;
        r.target_hit = false;
        r.payout = 0;
        r.pnl = 0;
        r.settled_at = 0;
        r.bump = ctx.bumps.receipt;

        emit!(CallRecorded {
            seq,
            bet_id: args.bet_id,
            caller: args.caller,
            handle: args.handle,
            event_ticker: args.event_ticker,
            condition_symbol: args.condition_symbol,
            target_symbol: args.target_symbol,
            condition_strike: args.condition_strike,
            target_strike: args.target_strike,
            stake: args.stake,
            price: args.price,
            payout_if_hit: args.payout_if_hit,
            hedged: args.hedged,
            placed_at: args.placed_at,
            expiry: args.expiry,
            evidence: args.evidence,
            recorded_at: now,
        });
        Ok(())
    }

    /// Records how Gemini resolved the call. Profit and loss is derived here
    /// from the stake already on the receipt, not supplied by the recorder.
    pub fn settle_call(
        ctx: Context<SettleCall>,
        _bet_id: String,
        condition_held: bool,
        target_hit: bool,
        payout: u64,
    ) -> Result<()> {
        // The target is the higher strike of the same ladder: it cannot hit
        // unless the condition did.
        require!(condition_held || !target_hit, ReceiptError::ImpossibleOutcome);

        let now = Clock::get()?.unix_timestamp;
        let r = &mut ctx.accounts.receipt;
        require!(r.status == CallStatus::Open, ReceiptError::AlreadySettled);

        let pnl = i64::try_from(payout)
            .ok()
            .zip(i64::try_from(r.stake).ok())
            .and_then(|(p, s)| p.checked_sub(s))
            .ok_or(ReceiptError::Overflow)?;

        r.status = CallStatus::Settled;
        r.condition_held = condition_held;
        r.target_hit = target_hit;
        r.payout = payout;
        r.pnl = pnl;
        r.settled_at = now;

        let config = &mut ctx.accounts.config;
        config.settled = config.settled.checked_add(1).ok_or(ReceiptError::Overflow)?;

        emit!(CallSettled {
            seq: r.seq,
            bet_id: r.bet_id.clone(),
            caller: r.caller,
            handle: r.handle.clone(),
            condition_held,
            target_hit,
            stake: r.stake,
            payout,
            pnl,
            settled_at: now,
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
#[instruction(args: RecordCallArgs)]
pub struct RecordCall<'info> {
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
        space = 8 + CallReceipt::INIT_SPACE,
        seeds = [CALL_SEED, args.bet_id.as_bytes()],
        bump
    )]
    pub receipt: Account<'info, CallReceipt>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(bet_id: String)]
pub struct SettleCall<'info> {
    pub recorder: Signer<'info>,
    #[account(
        mut,
        seeds = [CONFIG_SEED],
        bump = config.bump,
        has_one = recorder @ ReceiptError::NotRecorder
    )]
    pub config: Account<'info, Config>,
    #[account(
        mut,
        seeds = [CALL_SEED, bet_id.as_bytes()],
        bump = receipt.bump
    )]
    pub receipt: Account<'info, CallReceipt>,
}
