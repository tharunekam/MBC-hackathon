use {
    anchor_lang::{
        prelude::Pubkey,
        solana_program::{clock::Clock, instruction::Instruction, system_program},
        AccountDeserialize, InstructionData, ToAccountMetas,
    },
    given_receipts::{
        commit_hash, CallDetails, CallRecord, CallState, CallerStats, Config, CALLER_SEED, CALL_SEED, CONFIG_SEED,
    },
    litesvm::LiteSVM,
    solana_keypair::Keypair,
    solana_message::{Message, VersionedMessage},
    solana_signer::Signer,
    solana_transaction::versioned::VersionedTransaction,
};

/// ETH2611180000 closes at 2026-11-18 00:00 UTC; the sample bet went in two hours before.
const EXPIRY: i64 = 1_794_960_000;
const PLACED: i64 = EXPIRY - 7_200;

struct Env {
    svm: LiteSVM,
    admin: Keypair,
    recorder: Keypair,
    config: Pubkey,
}

fn pda(seeds: &[&[u8]]) -> Pubkey {
    Pubkey::find_program_address(seeds, &given_receipts::id()).0
}

fn call_pda(commit: &[u8; 32]) -> Pubkey {
    pda(&[CALL_SEED, commit])
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

/// A fresh chain with the program set up, at the moment the sample bet filled.
fn setup() -> Env {
    let mut svm = LiteSVM::new();
    let bytes = include_bytes!(concat!(env!("CARGO_TARGET_TMPDIR"), "/../deploy/given_receipts.so"));
    svm.add_program(given_receipts::id(), bytes).unwrap();
    let admin = Keypair::new();
    let recorder = Keypair::new();
    svm.airdrop(&admin.pubkey(), 1_000_000_000).unwrap();
    svm.airdrop(&recorder.pubkey(), 1_000_000_000).unwrap();
    let config = pda(&[CONFIG_SEED]);
    let ix = Instruction::new_with_bytes(
        given_receipts::id(),
        &given_receipts::instruction::Initialize { recorder: recorder.pubkey() }.data(),
        given_receipts::accounts::Initialize { admin: admin.pubkey(), config, system_program: system_program::ID }
            .to_account_metas(None),
    );
    send(&mut svm, ix, &admin).expect("initialize");
    set_time(&mut svm, PLACED + 4);
    Env { svm, admin, recorder, config }
}

fn sample(bet_id: &str, handle: &str) -> CallDetails {
    CallDetails {
        bet_id: bet_id.to_string(),
        handle: handle.to_string(),
        event_ticker: "ETH2611180000".to_string(),
        condition_symbol: "GEMI-ETH2611180000-HI1800".to_string(),
        target_symbol: "GEMI-ETH2611180000-HI1820".to_string(),
        fair_price: 625_000,
        placed_at: PLACED,
        expiry: EXPIRY,
        evidence: [7u8; 32],
    }
}

fn commit_ix(env: &Env, signer: &Keypair, commit: [u8; 32]) -> Instruction {
    Instruction::new_with_bytes(
        given_receipts::id(),
        &given_receipts::instruction::CommitCall { commit }.data(),
        given_receipts::accounts::CommitCall {
            recorder: signer.pubkey(),
            config: env.config,
            call: call_pda(&commit),
            system_program: system_program::ID,
        }
        .to_account_metas(None),
    )
}

fn reveal_ix(env: &Env, signer: &Keypair, call: Pubkey, details: CallDetails, salt: [u8; 32], target_hit: bool) -> Instruction {
    let stats = pda(&[CALLER_SEED, details.handle.as_bytes()]);
    Instruction::new_with_bytes(
        given_receipts::id(),
        &given_receipts::instruction::RevealCall { details, salt, target_hit }.data(),
        given_receipts::accounts::RevealCall {
            recorder: signer.pubkey(),
            config: env.config,
            call,
            stats,
            system_program: system_program::ID,
        }
        .to_account_metas(None),
    )
}

/// Commits `details` under `salt` as the recorder and returns the hash.
fn commit(env: &mut Env, details: &CallDetails, salt: [u8; 32]) -> [u8; 32] {
    let hash = commit_hash(details, &salt).unwrap();
    let ix = commit_ix(env, &env.recorder, hash);
    send(&mut env.svm, ix, &env.recorder.insecure_clone()).expect("commit_call");
    hash
}

fn reveal(env: &mut Env, details: &CallDetails, salt: [u8; 32], target_hit: bool) -> Result<Vec<String>, Vec<String>> {
    let call = call_pda(&commit_hash(details, &salt).unwrap());
    let ix = reveal_ix(env, &env.recorder, call, details.clone(), salt, target_hit);
    send(&mut env.svm, ix, &env.recorder.insecure_clone())
}

fn call(env: &Env, commit: &[u8; 32]) -> CallRecord {
    let account = env.svm.get_account(&call_pda(commit)).unwrap();
    CallRecord::try_deserialize(&mut &account.data[..]).unwrap()
}

fn stats(env: &Env, handle: &str) -> CallerStats {
    let account = env.svm.get_account(&pda(&[CALLER_SEED, handle.as_bytes()])).unwrap();
    CallerStats::try_deserialize(&mut &account.data[..]).unwrap()
}

fn config(env: &Env) -> Config {
    let account = env.svm.get_account(&env.config).unwrap();
    Config::try_deserialize(&mut &account.data[..]).unwrap()
}

fn failed_with(logs: &[String], name: &str) -> bool {
    logs.iter().any(|l| l.contains(name))
}

#[test]
fn commits_then_reveals_a_call() {
    let mut env = setup();
    let recorder = env.recorder.insecure_clone();
    let details = sample("a1b2c3d4", "brisk-otter-42");
    let salt = [9u8; 32];
    let hash = commit_hash(&details, &salt).unwrap();

    let ix = commit_ix(&env, &recorder, hash);
    let committed = send(&mut env.svm, ix, &recorder).expect("commit_call");
    assert!(committed.iter().any(|l| l.starts_with("Program data: ")), "event emitted");

    // On chain there is a hash and a time, and nothing else.
    let c = call(&env, &hash);
    assert_eq!((c.seq, c.commit, c.committed_at, c.state), (0, hash, PLACED + 4, CallState::Committed));
    assert_eq!(c.details, CallDetails::default());
    assert_eq!((config(&env).commits, config(&env).reveals), (1, 0));

    // One record per hash.
    let again = commit_ix(&env, &recorder, hash);
    assert!(send(&mut env.svm, again, &recorder).is_err());
    assert_eq!(config(&env).commits, 1);

    // Not before the event closes.
    let early = reveal(&mut env, &details, salt, true).unwrap_err();
    assert!(failed_with(&early, "NotExpiredYet"), "{early:?}");
    set_time(&mut env.svm, EXPIRY + 300);

    // Not with a different salt, and not with a call that was edited afterwards.
    let ix = reveal_ix(&env, &recorder, call_pda(&hash), details.clone(), [8u8; 32], true);
    let err = send(&mut env.svm, ix, &recorder).unwrap_err();
    assert!(failed_with(&err, "HashMismatch"), "{err:?}");
    let mut cheaper = details.clone();
    cheaper.fair_price = 100_000;
    let ix = reveal_ix(&env, &recorder, call_pda(&hash), cheaper, salt, true);
    let err = send(&mut env.svm, ix, &recorder).unwrap_err();
    assert!(failed_with(&err, "HashMismatch"), "{err:?}");
    assert_eq!(call(&env, &hash).state, CallState::Committed);

    let revealed = reveal(&mut env, &details, salt, true).expect("reveal_call");
    let c = call(&env, &hash);
    assert_eq!((c.state, c.target_hit, c.edge, c.revealed_at), (CallState::Revealed, true, 375_000, EXPIRY + 300));
    assert_eq!(c.details, details);
    let s = stats(&env, "brisk-otter-42");
    assert_eq!((s.handle.as_str(), s.calls, s.hits, s.edge_sum, s.last_revealed_at), ("brisk-otter-42", 1, 1, 375_000, EXPIRY + 300));
    assert_eq!(config(&env).reveals, 1);

    let twice = reveal(&mut env, &details, salt, false).unwrap_err();
    assert!(failed_with(&twice, "AlreadyRevealed"), "{twice:?}");
    assert_eq!(stats(&env, "brisk-otter-42").calls, 1);

    // Lets the TypeScript codec be tested against bytes this program really
    // accepted and emitted.
    if let Ok(path) = std::env::var("WRITE_LOG_FIXTURE") {
        let quote = |logs: &[String]| logs.iter().map(|l| format!("{l:?}")).collect::<Vec<_>>().join(",");
        let hex = |bytes: &[u8]| bytes.iter().map(|b| format!("{b:02x}")).collect::<String>();
        let stats_pda = pda(&[CALLER_SEED, b"brisk-otter-42"]);
        let json = format!(
            concat!(
                "{{\"programId\":\"{}\",\"recorder\":\"{}\",",
                "\"initializeIx\":\"{}\",\"commitIx\":\"{}\",\"revealIx\":\"{}\",",
                "\"commit\":\"{}\",\"salt\":\"{}\",",
                "\"callPda\":\"{}\",\"callAccount\":\"{}\",",
                "\"statsPda\":\"{}\",\"statsAccount\":\"{}\",",
                "\"committed\":[{}],\"revealed\":[{}]}}\n"
            ),
            given_receipts::id(),
            recorder.pubkey(),
            hex(&given_receipts::instruction::Initialize { recorder: recorder.pubkey() }.data()),
            hex(&given_receipts::instruction::CommitCall { commit: hash }.data()),
            hex(&given_receipts::instruction::RevealCall { details: details.clone(), salt, target_hit: true }.data()),
            hex(&hash),
            hex(&salt),
            call_pda(&hash),
            hex(&env.svm.get_account(&call_pda(&hash)).unwrap().data),
            stats_pda,
            hex(&env.svm.get_account(&stats_pda).unwrap().data),
            quote(&committed),
            quote(&revealed)
        );
        std::fs::write(path, json).unwrap();
    }
}

#[test]
fn a_handle_accumulates_hits_and_misses() {
    let mut env = setup();
    let hit = sample("hit00001", "calm-heron-7");
    let mut miss = sample("miss0001", "calm-heron-7");
    miss.fair_price = 400_000;
    let other = sample("othr0001", "slow-lynx-19");
    commit(&mut env, &hit, [1u8; 32]);
    commit(&mut env, &miss, [2u8; 32]);
    commit(&mut env, &other, [3u8; 32]);
    assert_eq!(config(&env).commits, 3);

    set_time(&mut env.svm, EXPIRY + 60);
    reveal(&mut env, &hit, [1u8; 32], true).unwrap();
    reveal(&mut env, &miss, [2u8; 32], false).unwrap();

    let s = stats(&env, "calm-heron-7");
    assert_eq!((s.calls, s.hits, s.edge_sum), (2, 1, 375_000 - 400_000));
    assert_eq!(call(&env, &commit_hash(&miss, &[2u8; 32]).unwrap()).edge, -400_000);
    // The third call stays a bare hash, and its handle has no record at all.
    assert_eq!(call(&env, &commit_hash(&other, &[3u8; 32]).unwrap()).state, CallState::Committed);
    assert!(env.svm.get_account(&pda(&[CALLER_SEED, b"slow-lynx-19"])).is_none());
    assert_eq!(config(&env).reveals, 2);
}

#[test]
fn a_call_committed_after_the_event_closed_is_never_scored() {
    let mut env = setup();
    set_time(&mut env.svm, EXPIRY + 1);
    let late = sample("late0001", "brisk-otter-42");
    commit(&mut env, &late, [4u8; 32]);
    set_time(&mut env.svm, EXPIRY + 600);
    let err = reveal(&mut env, &late, [4u8; 32], true).unwrap_err();
    assert!(failed_with(&err, "CommittedAfterExpiry"), "{err:?}");
}

#[test]
fn only_the_recorder_can_write() {
    let mut env = setup();
    let stranger = Keypair::new();
    env.svm.airdrop(&stranger.pubkey(), 1_000_000_000).unwrap();

    let ix = commit_ix(&env, &stranger, [5u8; 32]);
    let err = send(&mut env.svm, ix, &stranger).unwrap_err();
    assert!(failed_with(&err, "NotRecorder"), "{err:?}");

    // Knowing a call and its salt is not enough to reveal it.
    let details = sample("real0001", "brisk-otter-42");
    let hash = commit(&mut env, &details, [6u8; 32]);
    set_time(&mut env.svm, EXPIRY + 60);
    let ix = reveal_ix(&env, &stranger, call_pda(&hash), details.clone(), [6u8; 32], true);
    let err = send(&mut env.svm, ix, &stranger).unwrap_err();
    assert!(failed_with(&err, "NotRecorder"), "{err:?}");

    // The admin key is not the recorder either.
    let ix = commit_ix(&env, &env.admin, [5u8; 32]);
    let err = send(&mut env.svm, ix, &env.admin.insecure_clone()).unwrap_err();
    assert!(failed_with(&err, "NotRecorder"), "{err:?}");
}

#[test]
fn rejects_malformed_reveals() {
    let mut env = setup();
    let mut free = sample("bad00001", "brisk-otter-42");
    free.fair_price = 0;
    let mut over_a_dollar = sample("bad00002", "brisk-otter-42");
    over_a_dollar.fair_price = 1_000_001;
    let mut no_expiry = sample("bad00003", "brisk-otter-42");
    no_expiry.expiry = 0;
    let mut long_ticker = sample("bad00004", "brisk-otter-42");
    long_ticker.event_ticker = "x".repeat(33);
    let mut unnamed = sample("bad00005", "brisk-otter-42");
    unnamed.bet_id = String::new();

    let cases = [
        (free, "BadPrice"),
        (over_a_dollar, "BadPrice"),
        (no_expiry, "NoExpiry"),
        (long_ticker, "BadLength"),
        (unnamed, "BadLength"),
    ];
    for (i, (details, _)) in cases.iter().enumerate() {
        commit(&mut env, details, [i as u8; 32]);
    }
    set_time(&mut env.svm, EXPIRY + 60);
    for (i, (details, error)) in cases.iter().enumerate() {
        let err = reveal(&mut env, details, [i as u8; 32], true).unwrap_err();
        assert!(failed_with(&err, error), "{error}: {err:?}");
    }
    assert_eq!(config(&env).reveals, 0);
}

#[test]
fn admin_can_rotate_the_recorder() {
    let mut env = setup();
    let next = Keypair::new();
    env.svm.airdrop(&next.pubkey(), 1_000_000_000).unwrap();
    let rotate = |signer: &Keypair, config: Pubkey| {
        Instruction::new_with_bytes(
            given_receipts::id(),
            &given_receipts::instruction::SetRecorder { recorder: next.pubkey() }.data(),
            given_receipts::accounts::SetRecorder { admin: signer.pubkey(), config }.to_account_metas(None),
        )
    };

    let err = send(&mut env.svm, rotate(&env.recorder, env.config), &env.recorder.insecure_clone()).unwrap_err();
    assert!(failed_with(&err, "NotAdmin"), "{err:?}");

    send(&mut env.svm, rotate(&env.admin, env.config), &env.admin.insecure_clone()).unwrap();
    let ix = commit_ix(&env, &next, [1u8; 32]);
    send(&mut env.svm, ix, &next).unwrap();
    let ix = commit_ix(&env, &env.recorder, [2u8; 32]);
    assert!(send(&mut env.svm, ix, &env.recorder.insecure_clone()).is_err());
}
