use anchor_lang::prelude::*;

#[error_code]
pub enum ReceiptError {
    #[msg("A handle must be 1 to 32 bytes")]
    BadHandle,
    #[msg("A text field is empty, too long, or contains the separator")]
    BadField,
    #[msg("Fair price must be between 0 and 1.00")]
    BadPrice,
    #[msg("This call is already revealed")]
    AlreadyRevealed,
    #[msg("The revealed call does not match the committed hash")]
    HashMismatch,
    #[msg("Counter overflow")]
    Overflow,
}
