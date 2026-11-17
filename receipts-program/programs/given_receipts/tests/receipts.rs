use {
    anchor_lang::{
        prelude::Pubkey,
        solana_program::{instruction::Instruction, system_program},
        AccountDeserialize, InstructionData, ToAccountMetas,
    },
    given_receipts::{CallReceipt, CallStatus, Config, RecordCallArgs, CALL_SEED, CONFIG_SEED},
    litesvm::LiteSVM,
    solana_keypair::Keypair,
    solana_message::{Message, VersionedMessage},
    solana_signer::Signer,
    solana_transaction::versioned::VersionedTransaction,
};

struct Env {
    svm: LiteSVM,
    admin: Keypair,
    recorder: Keypair,
    config: Pubkey,
}

fn pda(seeds: &[&[u8]]) -> Pubkey {
    Pubkey::find_program_address(seeds, &given_receipts::id()).0
}

/// Sends one instruction and returns the transaction logs, or the logs of the failure.
fn send(svm: &mut LiteSVM, ix: Instruction, signer: &Keypair) -> Result<Vec<String>, Vec<String>> {
    svm.expire_blockhash();
    let msg = Message::new_with_blockhash(&[ix], Some(&signer.pubkey()), &svm.latest_blockhash());
    let tx = VersionedTransaction::try_new(VersionedMessage::Legacy(msg), &[signer]).unwrap();
    svm.send_transaction(tx).map(|m| m.logs).map_err(|e| e.meta.logs)
}

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
    Env { svm, admin, recorder, config }
}

fn sample(bet_id: &str, caller: Pubkey) -> RecordCallArgs {
    RecordCallArgs {
        bet_id: bet_id.to_string(),
        caller,
        handle: "primary".to_string(),
        event_ticker: "ETH2611180000".to_string(),
        condition_symbol: "GEMI-ETH2611180000-HI1800".to_string(),
        target_symbol: "GEMI-ETH2611180000-HI1820".to_string(),
        condition_strike: 1_800_000_000,
        target_strike: 1_820_000_000,
        stake: 5_000_000,
        price: 625_000,
        payout_if_hit: 8_000_000,
        hedged: true,
        placed_at: 1_794_960_000,
        expiry: 1_795_046_400,
        evidence: [7u8; 32],
    }
}

fn record_ix(env: &Env, signer: &Keypair, args: RecordCallArgs) -> Instruction {
    let receipt = pda(&[CALL_SEED, args.bet_id.as_bytes()]);
    Instruction::new_with_bytes(
        given_receipts::id(),
        &given_receipts::instruction::RecordCall { args }.data(),
        given_receipts::accounts::RecordCall {
            recorder: signer.pubkey(),
            config: env.config,
            receipt,
            system_program: system_program::ID,
        }
        .to_account_metas(None),
    )
}

fn settle_ix(env: &Env, signer: &Keypair, bet_id: &str, condition_held: bool, target_hit: bool, payout: u64) -> Instruction {
    Instruction::new_with_bytes(
        given_receipts::id(),
        &given_receipts::instruction::SettleCall { _bet_id: bet_id.to_string(), condition_held, target_hit, payout }.data(),
        given_receipts::accounts::SettleCall {
            recorder: signer.pubkey(),
            config: env.config,
            receipt: pda(&[CALL_SEED, bet_id.as_bytes()]),
        }
        .to_account_metas(None),
    )
}

fn receipt(env: &Env, bet_id: &str) -> CallReceipt {
    let account = env.svm.get_account(&pda(&[CALL_SEED, bet_id.as_bytes()])).unwrap();
    CallReceipt::try_deserialize(&mut &account.data[..]).unwrap()
}

fn config(env: &Env) -> Config {
    let account = env.svm.get_account(&env.config).unwrap();
    Config::try_deserialize(&mut &account.data[..]).unwrap()
}

fn failed_with(logs: &[String], name: &str) -> bool {
    logs.iter().any(|l| l.contains(name))
}

#[test]
fn records_then_settles_a_call() {
    let mut env = setup();
    let caller = Pubkey::new_unique();

    let ix = record_ix(&env, &env.recorder, sample("a1b2c3d4", caller));
    let recorded = send(&mut env.svm, ix, &env.recorder.insecure_clone()).expect("record_call");
    assert!(recorded.iter().any(|l| l.starts_with("Program data: ")), "event emitted");

    let r = receipt(&env, "a1b2c3d4");
    assert_eq!((r.seq, r.caller, r.stake, r.price), (0, caller, 5_000_000, 625_000));
    assert_eq!(r.target_symbol, "GEMI-ETH2611180000-HI1820");
    assert_eq!(r.status, CallStatus::Open);
    assert_eq!(config(&env).calls, 1);

    // One receipt per bet id.
    let again = record_ix(&env, &env.recorder, sample("a1b2c3d4", caller));
    assert!(send(&mut env.svm, again, &env.recorder.insecure_clone()).is_err());
    assert_eq!(config(&env).calls, 1);

    let ix = settle_ix(&env, &env.recorder, "a1b2c3d4", true, true, 8_000_000);
    let settled = send(&mut env.svm, ix, &env.recorder.insecure_clone()).expect("settle_call");
    let r = receipt(&env, "a1b2c3d4");
    assert_eq!(r.status, CallStatus::Settled);
    assert_eq!((r.condition_held, r.target_hit, r.payout, r.pnl), (true, true, 8_000_000, 3_000_000));
    assert_eq!(config(&env).settled, 1);

    let twice = settle_ix(&env, &env.recorder, "a1b2c3d4", true, false, 0);
    let err = send(&mut env.svm, twice, &env.recorder.insecure_clone()).unwrap_err();
    assert!(failed_with(&err, "AlreadySettled"), "{err:?}");

    // Lets the TypeScript codec be tested against bytes this program really
    // accepted and emitted.
    if let Ok(path) = std::env::var("WRITE_LOG_FIXTURE") {
        let quote = |logs: &[String]| logs.iter().map(|l| format!("{l:?}")).collect::<Vec<_>>().join(",");
        let hex = |bytes: Vec<u8>| bytes.iter().map(|b| format!("{b:02x}")).collect::<String>();
        let account = env.svm.get_account(&pda(&[CALL_SEED, b"a1b2c3d4"])).unwrap();
        let json = format!(
            concat!(
                "{{\"programId\":\"{}\",\"caller\":\"{}\",\"recorder\":\"{}\",",
                "\"initializeIx\":\"{}\",\"recordIx\":\"{}\",\"settleIx\":\"{}\",",
                "\"receiptPda\":\"{}\",\"receiptAccount\":\"{}\",",
                "\"recorded\":[{}],\"settled\":[{}]}}\n"
            ),
            given_receipts::id(),
            caller,
            env.recorder.pubkey(),
            hex(given_receipts::instruction::Initialize { recorder: env.recorder.pubkey() }.data()),
            hex(given_receipts::instruction::RecordCall { args: sample("a1b2c3d4", caller) }.data()),
            hex(given_receipts::instruction::SettleCall {
                _bet_id: "a1b2c3d4".to_string(),
                condition_held: true,
                target_hit: true,
                payout: 8_000_000
            }
            .data()),
            pda(&[CALL_SEED, b"a1b2c3d4"]),
            hex(account.data),
            quote(&recorded),
            quote(&settled)
        );
        std::fs::write(path, json).unwrap();
    }
}

#[test]
fn a_losing_call_settles_with_negative_pnl() {
    let mut env = setup();
    let ix = record_ix(&env, &env.recorder, sample("lose0001", Pubkey::new_unique()));
    send(&mut env.svm, ix, &env.recorder.insecure_clone()).unwrap();
    let ix = settle_ix(&env, &env.recorder, "lose0001", true, false, 0);
    send(&mut env.svm, ix, &env.recorder.insecure_clone()).unwrap();
    assert_eq!(receipt(&env, "lose0001").pnl, -5_000_000);
}

#[test]
fn only_the_recorder_can_write() {
    let mut env = setup();
    let stranger = Keypair::new();
    env.svm.airdrop(&stranger.pubkey(), 1_000_000_000).unwrap();

    let ix = record_ix(&env, &stranger, sample("fake0001", stranger.pubkey()));
    let err = send(&mut env.svm, ix, &stranger).unwrap_err();
    assert!(failed_with(&err, "NotRecorder"), "{err:?}");

    let ix = record_ix(&env, &env.recorder, sample("real0001", Pubkey::new_unique()));
    send(&mut env.svm, ix, &env.recorder.insecure_clone()).unwrap();
    let ix = settle_ix(&env, &stranger, "real0001", true, true, 9_000_000_000);
    let err = send(&mut env.svm, ix, &stranger).unwrap_err();
    assert!(failed_with(&err, "NotRecorder"), "{err:?}");

    // The admin key is not the recorder either.
    let ix = record_ix(&env, &env.admin, sample("admn0001", Pubkey::new_unique()));
    let err = send(&mut env.svm, ix, &env.admin.insecure_clone()).unwrap_err();
    assert!(failed_with(&err, "NotRecorder"), "{err:?}");
}

#[test]
fn rejects_malformed_calls_and_impossible_outcomes() {
    let mut env = setup();
    let recorder = env.recorder.insecure_clone();
    let caller = Pubkey::new_unique();

    let mut zero_stake = sample("bad00001", caller);
    zero_stake.stake = 0;
    let ix = record_ix(&env, &recorder, zero_stake);
    let err = send(&mut env.svm, ix, &recorder).unwrap_err();
    assert!(failed_with(&err, "ZeroStake"), "{err:?}");

    let mut over_a_dollar = sample("bad00002", caller);
    over_a_dollar.price = 1_000_001;
    let ix = record_ix(&env, &recorder, over_a_dollar);
    let err = send(&mut env.svm, ix, &recorder).unwrap_err();
    assert!(failed_with(&err, "BadPrice"), "{err:?}");

    let mut long_handle = sample("bad00003", caller);
    long_handle.handle = "x".repeat(25);
    let ix = record_ix(&env, &recorder, long_handle);
    let err = send(&mut env.svm, ix, &recorder).unwrap_err();
    assert!(failed_with(&err, "BadLength"), "{err:?}");

    let ix = record_ix(&env, &recorder, sample("good0001", caller));
    send(&mut env.svm, ix, &recorder).unwrap();
    let ix = settle_ix(&env, &recorder, "good0001", false, true, 8_000_000);
    let err = send(&mut env.svm, ix, &recorder).unwrap_err();
    assert!(failed_with(&err, "ImpossibleOutcome"), "{err:?}");
    assert_eq!(receipt(&env, "good0001").status, CallStatus::Open);
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
    let ix = record_ix(&env, &next, sample("next0001", Pubkey::new_unique()));
    send(&mut env.svm, ix, &next).unwrap();
    let ix = record_ix(&env, &env.recorder, sample("old00001", Pubkey::new_unique()));
    assert!(send(&mut env.svm, ix, &env.recorder.insecure_clone()).is_err());
}
