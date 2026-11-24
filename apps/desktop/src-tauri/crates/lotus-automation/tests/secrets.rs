use std::collections::HashMap;
use std::sync::Mutex;

use lotus_automation::secrets::{
    forget_slack_tokens_flagged, load_slack_tokens, load_slack_tokens_flagged, save_slack_tokens,
    save_slack_tokens_flagged, FileStore, SavedFlag, SecretStore, SlackTokens, TokenError,
};

const APP: &str = "xapp-1-A0SECRETAPP-1234567890-abcdefabcdef";
const USER: &str = "xoxp-1111-2222-3333-SECRETUSERabcdef";

/// Counts reads, since each read of the real macOS keychain can prompt.
#[derive(Default)]
struct MemoryKeychain(Mutex<HashMap<String, String>>, Mutex<usize>);

impl MemoryKeychain {
    fn reads(&self) -> usize {
        *self.1.lock().unwrap()
    }
    fn names(&self) -> Vec<String> {
        let mut names: Vec<_> = self.0.lock().unwrap().keys().cloned().collect();
        names.sort();
        names
    }
}

impl SecretStore for MemoryKeychain {
    fn get(&self, name: &str) -> Result<Option<String>, String> {
        *self.1.lock().unwrap() += 1;
        Ok(self.0.lock().unwrap().get(name).cloned())
    }
    fn set(&self, name: &str, value: &str) -> Result<(), String> {
        self.0.lock().unwrap().insert(name.into(), value.into());
        Ok(())
    }
    fn delete(&self, name: &str) -> Result<(), String> {
        self.0.lock().unwrap().remove(name);
        Ok(())
    }
}

#[test]
fn tokens_pasted_with_spaces_or_quotes_are_accepted_and_never_printed() {
    let tokens = SlackTokens::new(&format!("  \"{APP}\" "), &format!("{USER}\n")).unwrap();

    assert_eq!(tokens.app().expose(), APP);
    assert_eq!(tokens.user().expose(), USER);
    let shown = format!("{tokens:?} {} {:?}", tokens.app(), tokens.user());
    assert!(!shown.contains("SECRET"), "{shown}");
}

#[test]
fn a_wrong_kind_of_token_is_named_without_echoing_it() {
    let err = SlackTokens::new("xoxb-SECRETbot-token", USER).unwrap_err();
    assert!(matches!(&err, TokenError::WrongKind { field: "app", .. }), "{err}");
    let message = err.to_string();
    assert!(message.contains("bot token") && !message.contains("SECRET"), "{message}");

    let err = SlackTokens::new(APP, "0123456789abcdef0123456789abcdef").unwrap_err();
    assert!(err.to_string().contains("Signing Secret"), "{err}");
}

#[test]
fn tokens_round_trip_through_the_keychain_as_one_entry_and_can_be_removed() {
    let keychain = MemoryKeychain::default();
    assert!(load_slack_tokens(&keychain).unwrap().is_none());

    save_slack_tokens(&keychain, &SlackTokens::new(APP, USER).unwrap()).unwrap();
    assert_eq!(keychain.names(), ["slack-tokens"]);
    let before = keychain.reads();
    let loaded = load_slack_tokens(&keychain).unwrap().expect("saved");
    assert_eq!(keychain.reads() - before, 1, "one keychain read per launch");
    assert_eq!((loaded.app().expose(), loaded.user().expose()), (APP, USER));

    lotus_automation::secrets::forget_slack_tokens(&keychain).unwrap();
    assert!(load_slack_tokens(&keychain).unwrap().is_none());
    assert!(keychain.names().is_empty());
}

#[test]
fn tokens_saved_as_two_entries_by_an_older_lotus_move_into_one() {
    let keychain = MemoryKeychain::default();
    keychain.set("slack-app-token", APP).unwrap();
    keychain.set("slack-user-token", USER).unwrap();

    let loaded = load_slack_tokens(&keychain).unwrap().expect("migrated");
    assert_eq!((loaded.app().expose(), loaded.user().expose()), (APP, USER));
    assert_eq!(keychain.names(), ["slack-tokens"], "old entries removed");
}

#[test]
fn a_launch_without_slack_reads_the_keychain_only_once_ever() {
    let dir = tempfile::tempdir().unwrap();
    let flag = SavedFlag::new(dir.path().join("slack-tokens-saved"));
    let keychain = MemoryKeychain::default();

    assert!(load_slack_tokens_flagged(&keychain, &flag).unwrap().is_none());
    let after_first = keychain.reads();
    assert!(after_first > 0, "an unknown flag reads once, e.g. the first launch after an upgrade");
    assert!(load_slack_tokens_flagged(&keychain, &flag).unwrap().is_none());
    assert_eq!(keychain.reads(), after_first, "flag says none: keychain untouched");

    save_slack_tokens_flagged(&keychain, &flag, &SlackTokens::new(APP, USER).unwrap()).unwrap();
    assert!(load_slack_tokens_flagged(&keychain, &flag).unwrap().is_some());

    forget_slack_tokens_flagged(&keychain, &flag).unwrap();
    let after_forget = keychain.reads();
    assert!(load_slack_tokens_flagged(&keychain, &flag).unwrap().is_none());
    assert_eq!(keychain.reads(), after_forget);
}

#[test]
fn the_dev_file_store_round_trips_and_is_private_to_the_user() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("nested").join("dev-secrets.json");
    let store = FileStore::new(path.clone());
    assert!(load_slack_tokens(&store).unwrap().is_none());

    save_slack_tokens(&store, &SlackTokens::new(APP, USER).unwrap()).unwrap();
    let loaded = load_slack_tokens(&FileStore::new(path.clone())).unwrap().expect("saved");
    assert_eq!(loaded.user().expose(), USER);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
    }

    lotus_automation::secrets::forget_slack_tokens(&store).unwrap();
    assert!(load_slack_tokens(&store).unwrap().is_none());
}

// ---------- slice 07: nothing secret is ever stored or logged ----------

#[test]
fn every_token_shape_is_masked_wherever_it_sits_in_a_text() {
    use lotus_automation::secrets::redact;
    let text = "auth xapp-1-A0-1234-abcdef, then xoxp-123-456-789-abc; gh said gho_FAKEFAKEFAKE0000 \
                and ghp_AbCdEf0123456789 and github_pat_11ABC_def and Bearer xoxb-1-2-3.";
    let masked = redact(text);
    for secret in ["xapp-1", "xoxp-123", "gho_16C", "ghp_AbC", "github_pat_11", "xoxb-1"] {
        assert!(!masked.contains(secret), "{secret} leaked: {masked}");
    }
    assert!(masked.contains("auth xapp-[redacted], then xoxp-[redacted]; gh said"), "{masked}");
    assert_eq!(redact("nothing to hide: xoxo- gho ghp"), "nothing to hide: xoxo- gho ghp");
}

#[test]
fn a_run_that_fails_with_a_token_in_its_error_keeps_the_error_but_not_the_token() {
    use lotus_automation::{NewAutomation, RunStatus, Spec, Store};
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("automations.db");
    let store = Store::open(&path).unwrap();
    let a = store
        .create_automation(
            NewAutomation {
                name: "x".into(),
                trigger: Spec::new("manual", serde_json::json!({})),
                action: Spec::new("x", serde_json::json!({})),
                outputs: vec![],
            },
            1,
        )
        .unwrap();
    let run = match store.claim_run(&a.id, "k", 1).unwrap() {
        lotus_automation::ClaimOutcome::Claimed(r) => r,
        other => panic!("{other:?}"),
    };
    store
        .finish_run(&run.id, RunStatus::Failed, Some("gh: Bad credentials for ghp_SECRETSECRET1234 (HTTP 401)"), 2)
        .unwrap();

    let detail = store.get_run(&run.id).unwrap().unwrap().detail.unwrap();
    assert_eq!(detail, "gh: Bad credentials for ghp_[redacted] (HTTP 401)");
    drop(store);
    // The file itself, WAL included, never saw it.
    for file in std::fs::read_dir(dir.path()).unwrap() {
        let bytes = std::fs::read(file.unwrap().path()).unwrap();
        assert!(!String::from_utf8_lossy(&bytes).contains("SECRETSECRET"));
    }
}

const BOT: &str = "xoxb-1111-2222-SECRETBOTabcdef";

#[test]
fn a_bot_token_is_kept_beside_the_user_token_in_the_same_entry() {
    let keychain = MemoryKeychain::default();
    let tokens = SlackTokens::new(APP, USER).unwrap().with_bot(&format!(" {BOT}\n")).unwrap();
    assert_eq!(tokens.bot().map(|b| b.expose()), Some(BOT));
    assert!(!format!("{tokens:?}").contains("SECRET"));

    save_slack_tokens(&keychain, &tokens).unwrap();
    assert_eq!(keychain.names(), ["slack-tokens"]);
    let loaded = load_slack_tokens(&keychain).unwrap().expect("saved");
    assert_eq!(loaded.bot().map(|b| b.expose()), Some(BOT));
    assert_eq!((loaded.app().expose(), loaded.user().expose()), (APP, USER));
}

#[test]
fn tokens_saved_before_the_bot_load_without_one() {
    let keychain = MemoryKeychain::default();
    keychain.set("slack-tokens", &format!("{{\"app\":\"{APP}\",\"user\":\"{USER}\"}}")).unwrap();
    let loaded = load_slack_tokens(&keychain).unwrap().expect("saved");
    assert!(loaded.bot().is_none());
}

#[test]
fn the_bot_field_refuses_a_user_token() {
    let err = SlackTokens::new(APP, USER).unwrap().with_bot(USER).unwrap_err();
    assert!(matches!(&err, TokenError::WrongKind { field: "bot", .. }), "{err}");
    assert!(err.to_string().contains("user token") && !err.to_string().contains("SECRET"), "{err}");
}
