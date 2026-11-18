use {
    anchor_lang::{
        prelude::Pubkey,
        solana_program::{clock::Clock, instruction::Instruction, system_program},
        AccountDeserialize, InstructionData, ToAccountMetas,
    },
    given_receipts::{hash_of, preimage, CallRecord, CallState, CallerStats, CALLER_SEED, CALL_SEED},
    litesvm::LiteSVM,
    solana_keypair::Keypair,
    solana_message::{Message, VersionedMessage},
    solana_signer::Signer,
    solana_transaction::versioned::VersionedTransaction,
};

/// The example pinned in `chain/test/memo.test.ts`. Both sides must produce this text.
const PINNED: &str = "given1|d1a2b3|BTC2611190100|GEMI-BTC2611190100-HI62500|GEMI-BTC2611190100-HI63500|0.437500|0.410000|1763433000|aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const AT: i64 = 1_763_433_000;
const SALT: [u8; 16] = [0xaa; 16];
const HANDLE: &str = "quiet-otter-42";

#[derive(Clone)]
struct Call {
    bet_id: String,
    event: String,
    condition: String,
    target: String,
    entry_price: u64,
    fair_price: u32,
    at: i64,
    salt: [u8; 16],
}

impl Call {
    fn hash(&self) -> [u8; 32] {
        hash_of(&preimage(
            &self.bet_id,
            &self.event,
            &self.condition,
            &self.target,
            self.entry_price,
            self.fair_price,
            self.at,
            &self.salt,
        ))
    }
}

fn sample(bet_id: &str) -> Call {
    Call {
        bet_id: bet_id.to_string(),
        event: "BTC2611190100".to_string(),
        condition: "GEMI-BTC2611190100-HI62500".to_string(),
        target: "GEMI-BTC2611190100-HI63500".to_string(),
        entry_price: 437_500,
        fair_price: 410_000,
        at: AT,
        salt: SALT,
    }
}

struct Env {
    svm: LiteSVM,
    authority: Keypair,
}

fn pda(seeds: &[&[u8]]) -> Pubkey {
    Pubkey::find_program_address(seeds, &given_receipts::id()).0
}

fn call_pda(authority: &Pubkey, hash: &[u8; 32]) -> Pubkey {
    pda(&[CALL_SEED, authority.as_ref(), hash])
}

fn stats_pda(authority: &Pubkey, handle: &str) -> Pubkey {
    pda(&[CALLER_SEED, authority.as_ref(), handle.as_bytes()])
}

fn set_time(svm: &mut LiteSVM, unix_timestamp: i64) {
    let mut clock = svm.get_sysvar::<Clock>();
    clock.unix_timestamp = unix_timestamp;
    svm.set_sysvar(&clock);
}

/// Sends one instruction and returns the transaction logs, or the logs of the failure.
fn send(svm: &mut LiteSVM, ix: Instruction, signer: &Keypair) -> Result<Vec<String>, Vec<String>> {
    svm.expire_blockhash();
    let msg = Message::new_with_blockhash(&[ix], Some(&signer.pubkey()), &svm.latest_blockhash());
    let tx = VersionedTransaction::try_new(VersionedMessage::Legacy(msg), &[signer]).unwrap();
    svm.send_transaction(tx).map(|m| m.logs).map_err(|e| e.meta.logs)
}

fn funded(svm: &mut LiteSVM) -> Keypair {
    let key = Keypair::new();
    svm.airdrop(&key.pubkey(), 1_000_000_000).unwrap();
    key
}

/// A fresh chain with the program loaded, a few seconds after the sample call's time.
fn setup() -> Env {
    let mut svm = LiteSVM::new();
    let bytes = include_bytes!(concat!(env!("CARGO_TARGET_TMPDIR"), "/../deploy/given_receipts.so"));
    svm.add_program(given_receipts::id(), bytes).unwrap();
    let authority = funded(&mut svm);
    set_time(&mut svm, AT + 3);
    Env { svm, authority }
}

fn commit_ix(signer: &Pubkey, hash: [u8; 32], handle: &str, at: i64) -> Instruction {
    Instruction::new_with_bytes(
        given_receipts::id(),
        &given_receipts::instruction::CommitCall { hash, handle: handle.to_string(), at }.data(),
        given_receipts::accounts::CommitCall {
            authority: *signer,
            call: call_pda(signer, &hash),
            system_program: system_program::ID,
        }
        .to_account_metas(None),
    )
}

/// A reveal of `call` against the record at `record`, filed under `owner` and `handle`.
fn reveal_ix(signer: &Pubkey, record: Pubkey, owner: &Pubkey, handle: &str, call: &Call, outcome: bool) -> Instruction {
    Instruction::new_with_bytes(
        given_receipts::id(),
        &given_receipts::instruction::RevealCall {
            bet_id: call.bet_id.clone(),
            event: call.event.clone(),
            condition: call.condition.clone(),
            target: call.target.clone(),
            entry_price: call.entry_price,
            fair_price: call.fair_price,
            salt: call.salt,
            outcome,
        }
        .data(),
        given_receipts::accounts::RevealCall {
            authority: *signer,
            call: record,
            stats: stats_pda(owner, handle),
            system_program: system_program::ID,
        }
        .to_account_metas(None),
    )
}

fn commit(env: &mut Env, call: &Call, handle: &str) -> Result<Vec<String>, Vec<String>> {
    let key = env.authority.insecure_clone();
    send(&mut env.svm, commit_ix(&key.pubkey(), call.hash(), handle, call.at), &key)
}

/// Reveals `shown` against the record committed for `committed`.
fn reveal_as(env: &mut Env, committed: &Call, shown: &Call, handle: &str, outcome: bool) -> Result<Vec<String>, Vec<String>> {
    let key = env.authority.insecure_clone();
    let record = call_pda(&key.pubkey(), &committed.hash());
    send(&mut env.svm, reveal_ix(&key.pubkey(), record, &key.pubkey(), handle, shown, outcome), &key)
}

fn reveal(env: &mut Env, call: &Call, handle: &str, outcome: bool) -> Result<Vec<String>, Vec<String>> {
    reveal_as(env, call, call, handle, outcome)
}

fn record(env: &Env, authority: &Pubkey, hash: &[u8; 32]) -> CallRecord {
    let account = env.svm.get_account(&call_pda(authority, hash)).unwrap();
    CallRecord::try_deserialize(&mut &account.data[..]).unwrap()
}

fn stats(env: &Env, authority: &Pubkey, handle: &str) -> CallerStats {
    let account = env.svm.get_account(&stats_pda(authority, handle)).unwrap();
    CallerStats::try_deserialize(&mut &account.data[..]).unwrap()
}

fn failed_with(result: Result<Vec<String>, Vec<String>>, needle: &str) {
    let logs = result.expect_err("the transaction should have failed");
    assert!(logs.iter().any(|l| l.contains(needle)), "expected {needle} in {logs:#?}");
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn program_data(logs: &[String]) -> Vec<String> {
    logs.iter().filter_map(|l| l.strip_prefix("Program data: ")).map(str::to_string).collect()
}

#[test]
fn the_hashed_text_matches_the_chain_service() {
    let call = sample("d1a2b3");
    let text = preimage(&call.bet_id, &call.event, &call.condition, &call.target, call.entry_price, call.fair_price, call.at, &call.salt);
    assert_eq!(text, PINNED);
    // Prices at and above 1.00 keep six decimals, as JavaScript's toFixed(6) prints them.
    let text = preimage("b", "e", "k", "x", 1_000_000, 5, 7, &[0x0f; 16]);
    assert_eq!(text, "given1|b|e|k|x|1.000000|0.000005|7|0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f");
}

#[test]
fn commits_then_reveals_a_call() {
    let mut env = setup();
    let authority = env.authority.pubkey();
    let call = sample("d1a2b3");
    let hash = call.hash();

    let commit_logs = commit(&mut env, &call, HANDLE).expect("commit_call");
    let committed = record(&env, &authority, &hash);
    assert_eq!(committed.authority, authority);
    assert_eq!(committed.hash, hash);
    assert_eq!(committed.handle, HANDLE);
    assert_eq!(committed.at, AT);
    assert_eq!(committed.committed_at, AT + 3);
    assert_eq!(committed.state, CallState::Committed);
    assert_eq!(committed.fair_price, 0, "nothing about the trade is stored before the reveal");

    set_time(&mut env.svm, AT + 3_600);
    let reveal_logs = reveal(&mut env, &call, HANDLE, true).expect("reveal_call");
    let revealed = record(&env, &authority, &hash);
    assert_eq!(revealed.state, CallState::Revealed);
    assert_eq!(revealed.revealed_at, AT + 3_600);
    assert!(revealed.outcome);
    assert_eq!(revealed.fair_price, 410_000);
    assert_eq!(revealed.edge, 590_000);

    let score = stats(&env, &authority, HANDLE);
    assert_eq!((score.calls, score.hits, score.edge_sum), (1, 1, 590_000));
    assert_eq!(score.authority, authority);
    assert_eq!(score.handle, HANDLE);
    assert_eq!(score.last_revealed_at, AT + 3_600);

    // Bytes for the chain service's tests, so its encoder is checked against this program.
    if let Ok(path) = std::env::var("WRITE_PROGRAM_FIXTURE") {
        let commit_ix = commit_ix(&authority, hash, HANDLE, call.at);
        let reveal_ix = reveal_ix(&authority, call_pda(&authority, &hash), &authority, HANDLE, &call, true);
        let call_account = env.svm.get_account(&call_pda(&authority, &hash)).unwrap();
        let stats_account = env.svm.get_account(&stats_pda(&authority, HANDLE)).unwrap();
        let list = |v: &[String]| v.iter().map(|s| format!("\"{s}\"")).collect::<Vec<_>>().join(", ");
        let json = format!(
            "{{\n  \"programId\": \"{}\",\n  \"authority\": \"{}\",\n  \"handle\": \"{HANDLE}\",\n  \"preimage\": \"{PINNED}\",\n  \"hash\": \"{}\",\n  \"callPda\": \"{}\",\n  \"statsPda\": \"{}\",\n  \"commitIx\": \"{}\",\n  \"revealIx\": \"{}\",\n  \"callAccount\": \"{}\",\n  \"statsAccount\": \"{}\",\n  \"committed\": [{}],\n  \"revealed\": [{}]\n}}\n",
            given_receipts::id(),
            authority,
            hex(&hash),
            call_pda(&authority, &hash),
            stats_pda(&authority, HANDLE),
            hex(&commit_ix.data),
            hex(&reveal_ix.data),
            hex(&call_account.data),
            hex(&stats_account.data),
            list(&program_data(&commit_logs)),
            list(&program_data(&reveal_logs)),
        );
        std::fs::write(path, json).unwrap();
    }
}

#[test]
fn a_handle_accumulates_hits_and_misses() {
    let mut env = setup();
    let authority = env.authority.pubkey();
    let (won, lost, other) = (sample("bet-1"), sample("bet-2"), sample("bet-3"));
    for call in [&won, &lost] {
        commit(&mut env, call, HANDLE).expect("commit_call");
    }
    commit(&mut env, &other, "amber-wren-11").expect("commit_call");

    reveal(&mut env, &won, HANDLE, true).expect("reveal a hit");
    reveal(&mut env, &lost, HANDLE, false).expect("reveal a miss");
    reveal(&mut env, &other, "amber-wren-11", false).expect("reveal another handle");

    assert_eq!(record(&env, &authority, &lost.hash()).edge, -410_000);
    let score = stats(&env, &authority, HANDLE);
    assert_eq!((score.calls, score.hits, score.edge_sum), (2, 1, 180_000));
    let score = stats(&env, &authority, "amber-wren-11");
    assert_eq!((score.calls, score.hits, score.edge_sum), (1, 0, -410_000));
}

#[test]
fn a_changed_reveal_is_refused() {
    let mut env = setup();
    let authority = env.authority.pubkey();
    let call = sample("d1a2b3");
    commit(&mut env, &call, HANDLE).expect("commit_call");

    let lower_fair_price = Call { fair_price: 200_000, ..call.clone() };
    failed_with(reveal_as(&mut env, &call, &lower_fair_price, HANDLE, true), "HashMismatch");
    let other_target = Call { target: "GEMI-BTC2611190100-HI64000".to_string(), ..call.clone() };
    failed_with(reveal_as(&mut env, &call, &other_target, HANDLE, true), "HashMismatch");
    let other_entry = Call { entry_price: 300_000, ..call.clone() };
    failed_with(reveal_as(&mut env, &call, &other_entry, HANDLE, true), "HashMismatch");
    let other_bet = Call { bet_id: "d1a2b4".to_string(), ..call.clone() };
    failed_with(reveal_as(&mut env, &call, &other_bet, HANDLE, true), "HashMismatch");
    let other_salt = Call { salt: [0xab; 16], ..call.clone() };
    failed_with(reveal_as(&mut env, &call, &other_salt, HANDLE, true), "HashMismatch");
    assert_eq!(record(&env, &authority, &call.hash()).state, CallState::Committed);

    reveal(&mut env, &call, HANDLE, false).expect("the true call still reveals");
    // A second reveal cannot flip the result or count twice.
    failed_with(reveal(&mut env, &call, HANDLE, true), "AlreadyRevealed");
    let score = stats(&env, &authority, HANDLE);
    assert_eq!((score.calls, score.hits), (1, 0));
}

#[test]
fn the_same_hash_cannot_be_committed_twice() {
    let mut env = setup();
    let call = sample("d1a2b3");
    commit(&mut env, &call, HANDLE).expect("commit_call");
    assert!(commit(&mut env, &call, HANDLE).is_err());
    assert!(commit(&mut env, &call, "amber-wren-11").is_err());
}

#[test]
fn only_the_key_that_committed_can_reveal() {
    let mut env = setup();
    let authority = env.authority.pubkey();
    let call = sample("d1a2b3");
    commit(&mut env, &call, HANDLE).expect("commit_call");

    let stranger = funded(&mut env.svm);
    let theirs = call_pda(&authority, &call.hash());
    // Signed by a stranger, against our record: with our score account, then with their own.
    let ix = reveal_ix(&stranger.pubkey(), theirs, &authority, HANDLE, &call, true);
    failed_with(send(&mut env.svm, ix, &stranger), "ConstraintSeeds");
    let ix = reveal_ix(&stranger.pubkey(), theirs, &stranger.pubkey(), HANDLE, &call, true);
    failed_with(send(&mut env.svm, ix, &stranger), "ConstraintSeeds");
    assert_eq!(record(&env, &authority, &call.hash()).state, CallState::Committed);
}

#[test]
fn records_are_filed_under_the_key_that_wrote_them() {
    let mut env = setup();
    let authority = env.authority.pubkey();
    let call = sample("d1a2b3");
    commit(&mut env, &call, HANDLE).expect("commit_call");
    reveal(&mut env, &call, HANDLE, true).expect("reveal_call");

    // Someone else writing the same hash and handle lands in their own accounts and changes nothing of ours.
    let stranger = funded(&mut env.svm);
    send(&mut env.svm, commit_ix(&stranger.pubkey(), call.hash(), HANDLE, call.at), &stranger).expect("their commit");
    let theirs = call_pda(&stranger.pubkey(), &call.hash());
    let ix = reveal_ix(&stranger.pubkey(), theirs, &stranger.pubkey(), HANDLE, &call, false);
    send(&mut env.svm, ix, &stranger).expect("their reveal");

    let ours = stats(&env, &authority, HANDLE);
    assert_eq!((ours.calls, ours.hits, ours.edge_sum), (1, 1, 590_000));
    let other = stats(&env, &stranger.pubkey(), HANDLE);
    assert_eq!((other.calls, other.hits, other.edge_sum), (1, 0, -410_000));
}

#[test]
fn malformed_input_is_refused() {
    let mut env = setup();
    let call = sample("d1a2b3");
    failed_with(commit(&mut env, &call, ""), "BadHandle");
    failed_with(commit(&mut env, &call, &"x".repeat(33)), "BadHandle");

    // A separator inside a field could otherwise be used to forge a different call with the same text.
    let forged = Call { bet_id: "d1|a2b3".to_string(), ..call.clone() };
    commit(&mut env, &forged, HANDLE).expect("a hash says nothing about its fields");
    failed_with(reveal(&mut env, &forged, HANDLE, true), "BadField");
    let empty = Call { event: String::new(), ..sample("bet-2") };
    commit(&mut env, &empty, HANDLE).expect("commit_call");
    failed_with(reveal(&mut env, &empty, HANDLE, true), "BadField");
    let overpriced = Call { fair_price: 1_000_001, ..sample("bet-3") };
    commit(&mut env, &overpriced, HANDLE).expect("commit_call");
    failed_with(reveal(&mut env, &overpriced, HANDLE, true), "BadPrice");
}
