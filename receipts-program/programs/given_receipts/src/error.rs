use anchor_lang::prelude::*;

#[error_code]
pub enum ReceiptError {
    #[msg("Signer is not the configured recorder")]
    NotRecorder,
    #[msg("Signer is not the admin")]
    NotAdmin,
    #[msg("A text field is empty or longer than its limit")]
    BadLength,
    #[msg("Stake must be greater than zero")]
    ZeroStake,
    #[msg("Price must be above 0 and at most 1.00")]
    BadPrice,
    #[msg("This call is already settled")]
    AlreadySettled,
    #[msg("The target cannot hit when the condition failed")]
    ImpossibleOutcome,
    #[msg("Amount does not fit the receipt")]
    Overflow,
}
