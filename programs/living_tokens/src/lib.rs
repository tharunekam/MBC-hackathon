use anchor_lang::prelude::*;
use anchor_spl::token_interface::{self, Mint, TokenAccount, TokenInterface, TransferChecked};

declare_id!("LivTkn1111111111111111111111111111111111111");

#[program]
pub mod living_tokens {
    use super::*;

    /// Initialize a new Event Space tied to a specific Gemini Prediction Market
    pub mod instructions {
        use super::*;

        pub fn initialize_event_space(
            ctx: Context<InitializeEventSpace>,
            gemini_market_id: [u8; 32],
            underdog_threshold_bps: u16,
        ) -> Result<()> {
            let space = &mut ctx.accounts.event_space;
            space.authority = ctx.accounts.authority.key();
            space.oracle_relay = ctx.accounts.oracle_relay.key();
            space.gemini_market_id = gemini_market_id;
            space.collateral_vault = ctx.accounts.collateral_vault.key();
            space.yes_mint = ctx.accounts.yes_mint.key();
            space.no_mint = ctx.accounts.no_mint.key();
            space.total_collateral = 0;
            space.current_odds_bps = 5000; // Default 50%
            space.status = EventStatus::Active;
            space.underdog_threshold_bps = underdog_threshold_bps;
            space.bump = ctx.bumps.event_space;
            space.vault_bump = ctx.bumps.collateral_vault;
            Ok(())
        }

        pub fn split_collateral(ctx: Context<SplitCollateral>, amount: u64) -> Result<()> {
            require!(ctx.accounts.event_space.status == EventStatus::Active, ErrorCode::MarketNotActive);
            require!(amount > 0, ErrorCode::InvalidAmount);

            // Deposit USDC into segregated Collateral Vault
            let transfer_ctx = CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.user_collateral.to_account_info(),
                    mint: ctx.accounts.collateral_mint.to_account_info(),
                    to: ctx.accounts.collateral_vault.to_account_info(),
                    authority: ctx.accounts.user.to_account_info(),
                },
            );
            token_interface::transfer_checked(transfer_ctx, amount, 6)?;

            // Mint 1 YES Claim and 1 NO Claim for every 1 USDC
            ctx.accounts.event_space.total_collateral += amount;

            emit!(CollateralSplitEvent {
                event_space: ctx.accounts.event_space.key(),
                user: ctx.accounts.user.key(),
                amount,
                timestamp: Clock::get()?.unix_timestamp,
            });

            Ok(())
        }

        pub fn merge_claims(ctx: Context<MergeClaims>, amount: u64) -> Result<()> {
            require!(amount > 0, ErrorCode::InvalidAmount);

            // Burn 1 YES Claim and 1 NO Claim to redeem 1 USDC before settlement
            ctx.accounts.event_space.total_collateral = ctx
                .accounts
                .event_space
                .total_collateral
                .checked_sub(amount)
                .ok_or(ErrorCode::MathOverflow)?;

            emit!(ClaimsMergedEvent {
                event_space: ctx.accounts.event_space.key(),
                user: ctx.accounts.user.key(),
                amount,
                timestamp: Clock::get()?.unix_timestamp,
            });

            Ok(())
        }

        pub fn mint_underdog_stamp(ctx: Context<MintUnderdogStamp>, claims_to_wrap: u64) -> Result<()> {
            let space = &ctx.accounts.event_space;
            require!(space.status == EventStatus::Active, ErrorCode::MarketNotActive);
            
            // Strictly enforce the Underdog rule: Odds must be below published threshold (e.g. < 10%)
            require!(
                space.current_odds_bps <= space.underdog_threshold_bps,
                ErrorCode::UnderdogWindowClosed
            );
            require!(claims_to_wrap > 0, ErrorCode::InvalidAmount);

            let stamp = &mut ctx.accounts.underdog_stamp;
            stamp.owner = ctx.accounts.user.key();
            stamp.event_space = space.key();
            stamp.wrapped_claims_amount = claims_to_wrap;
            stamp.mint_odds_bps = space.current_odds_bps;
            stamp.mint_timestamp = Clock::get()?.unix_timestamp;
            stamp.is_redeemed = false;
            stamp.bump = ctx.bumps.underdog_stamp;

            emit!(UnderdogStampMintedEvent {
                event_space: space.key(),
                minter: ctx.accounts.user.key(),
                mint_odds_bps: space.current_odds_bps,
                claims_wrapped: claims_to_wrap,
                timestamp: stamp.mint_timestamp,
            });

            Ok(())
        }

        pub fn update_oracle_state(
            ctx: Context<UpdateOracleState>,
            new_odds_bps: u16,
            new_status: EventStatus,
        ) -> Result<()> {
            let space = &mut ctx.accounts.event_space;
            require_keys_eq!(ctx.accounts.oracle_relay.key(), space.oracle_relay, ErrorCode::UnauthorizedRelay);

            space.current_odds_bps = new_odds_bps;
            space.status = new_status;

            emit!(OracleStateUpdatedEvent {
                event_space: space.key(),
                odds_bps: new_odds_bps,
                status: new_status,
                timestamp: Clock::get()?.unix_timestamp,
            });

            Ok(())
        }
    }
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq)]
pub enum EventStatus {
    Active,
    Closed,
    SettledYes,
    SettledNo,
    Invalid,
}

#[account]
pub struct EventSpace {
    pub authority: Pubkey,
    pub oracle_relay: Pubkey,
    pub gemini_market_id: [u8; 32],
    pub collateral_vault: Pubkey,
    pub yes_mint: Pubkey,
    pub no_mint: Pubkey,
    pub total_collateral: u64,
    pub current_odds_bps: u16,
    pub status: EventStatus,
    pub underdog_threshold_bps: u16,
    pub bump: u8,
    pub vault_bump: u8,
}

#[account]
pub struct UnderdogStamp {
    pub owner: Pubkey,
    pub event_space: Pubkey,
    pub wrapped_claims_amount: u64,
    pub mint_odds_bps: u16,
    pub mint_timestamp: i64,
    pub is_redeemed: bool,
    pub bump: u8,
}

#[derive(Accounts)]
#[instruction(gemini_market_id: [u8; 32])]
pub struct InitializeEventSpace<'info> {
    #[account(
        init,
        payer = authority,
        space = 8 + 32 + 32 + 32 + 32 + 32 + 32 + 8 + 2 + 1 + 2 + 1 + 1,
        seeds = [b"event_space", gemini_market_id.as_ref()],
        bump
    )]
    pub event_space: Account<'info, EventSpace>,
    #[account(mut)]
    pub authority: Signer<'info>,
    /// CHECK: The authorized oracle relay public key
    pub oracle_relay: AccountInfo<'info>,
    pub collateral_mint: InterfaceAccount<'info, Mint>,
    #[account(
        init,
        payer = authority,
        seeds = [b"vault", event_space.key().as_ref()],
        bump,
        token::mint = collateral_mint,
        token::authority = collateral_vault,
    )]
    pub collateral_vault: InterfaceAccount<'info, TokenAccount>,
    pub yes_mint: InterfaceAccount<'info, Mint>,
    pub no_mint: InterfaceAccount<'info, Mint>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SplitCollateral<'info> {
    #[account(mut)]
    pub event_space: Account<'info, EventSpace>,
    #[account(mut)]
    pub user: Signer<'info>,
    pub collateral_mint: InterfaceAccount<'info, Mint>,
    #[account(mut)]
    pub user_collateral: InterfaceAccount<'info, TokenAccount>,
    #[account(mut)]
    pub collateral_vault: InterfaceAccount<'info, TokenAccount>,
    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct MergeClaims<'info> {
    #[account(mut)]
    pub event_space: Account<'info, EventSpace>,
    #[account(mut)]
    pub user: Signer<'info>,
    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct MintUnderdogStamp<'info> {
    #[account(mut)]
    pub event_space: Account<'info, EventSpace>,
    #[account(
        init,
        payer = user,
        space = 8 + 32 + 32 + 8 + 2 + 8 + 1 + 1,
        seeds = [b"stamp", event_space.key().as_ref(), user.key().as_ref()],
        bump
    )]
    pub underdog_stamp: Account<'info, UnderdogStamp>,
    #[account(mut)]
    pub user: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UpdateOracleState<'info> {
    #[account(mut)]
    pub event_space: Account<'info, EventSpace>,
    pub oracle_relay: Signer<'info>,
}

#[event]
pub struct CollateralSplitEvent {
    pub event_space: Pubkey,
    pub user: Pubkey,
    pub amount: u64,
    pub timestamp: i64,
}

#[event]
pub struct ClaimsMergedEvent {
    pub event_space: Pubkey,
    pub user: Pubkey,
    pub amount: u64,
    pub timestamp: i64,
}

#[event]
pub struct UnderdogStampMintedEvent {
    pub event_space: Pubkey,
    pub minter: Pubkey,
    pub mint_odds_bps: u16,
    pub claims_wrapped: u64,
    pub timestamp: i64,
}

#[event]
pub struct OracleStateUpdatedEvent {
    pub event_space: Pubkey,
    pub odds_bps: u16,
    pub status: EventStatus,
    pub timestamp: i64,
}

#[error_code]
pub enum ErrorCode {
    #[msg("Market is not currently active.")]
    MarketNotActive,
    #[msg("Amount must be greater than zero.")]
    InvalidAmount,
    #[msg("Math calculation overflow.")]
    MathOverflow,
    #[msg("Underdog mint window is closed (odds exceed threshold).")]
    UnderdogWindowClosed,
    #[msg("Signer is not authorized oracle relay.")]
    UnauthorizedRelay,
}
