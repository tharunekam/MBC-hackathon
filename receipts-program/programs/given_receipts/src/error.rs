use anchor_lang::prelude::*;

#[error_code]
pub enum ReceiptError {
    #[msg("Signer is not the configured recorder")]
    NotRecorder,
    #[msg("Signer is not the admin")]
    NotAdmin,
    #[msg("A text field is empty or longer than its limit")]
    BadLength,
    #[msg("Fair price must be above 0 and at most 1.00")]
    BadPrice,
    #[msg("A call needs the time its event closes")]
    NoExpiry,
    #[msg("This call is already revealed")]
    AlreadyRevealed,
    #[msg("The revealed call does not match the committed hash")]
    HashMismatch,
    #[msg("This call was committed after its event closed, so it cannot be scored")]
    CommittedAfterExpiry,
    #[msg("The event has not closed yet")]
    NotExpiredYet,
    #[msg("Counter overflow")]
    Overflow,
}
