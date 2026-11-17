//! Pure startup-generation policy. Windows effects and publication live elsewhere.
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashSet;

const MAX_SAFE: u64 = 9_007_199_254_740_991;
pub const MAX_GENERATIONS: usize = 64;
pub const MAX_MANIFEST_BYTES: usize = 131_072;

pub fn hex_key(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
pub fn uuid(value: &str) -> bool {
    if value == "00000000-0000-0000-0000-000000000000"
        || value == "ffffffff-ffff-ffff-ffff-ffffffffffff"
    {
        return true;
    }
    let b = value.as_bytes();
    b.len() == 36
        && b.iter().enumerate().all(|(i, c)| {
            if [8, 13, 18, 23].contains(&i) {
                *c == b'-'
            } else {
                c.is_ascii_hexdigit()
            }
        })
        && (b'1'..=b'8').contains(&b[14])
        && b"89abAB".contains(&b[19])
}
fn operation_id(value: &str) -> bool {
    uuid(value) && value.as_bytes()[14] == b'4' && value == value.to_ascii_lowercase()
}
fn utc_time(value: &str) -> bool {
    let b = value.as_bytes();
    if b.len() < 20
        || b[4] != b'-'
        || b[7] != b'-'
        || b[10] != b'T'
        || b[13] != b':'
        || b[16] != b':'
        || b.last() != Some(&b'Z')
    {
        return false;
    }
    if !b[..19]
        .iter()
        .enumerate()
        .all(|(i, c)| [4, 7, 10, 13, 16].contains(&i) || c.is_ascii_digit())
    {
        return false;
    }
    if b.len() > 20
        && (b[19] != b'.' || b.len() < 22 || !b[20..b.len() - 1].iter().all(u8::is_ascii_digit))
    {
        return false;
    }
    let number = |start: usize, end: usize| {
        b[start..end]
            .iter()
            .fold(0u32, |n, c| n * 10 + u32::from(c - b'0'))
    };
    let year = number(0, 4);
    let month = number(5, 7);
    let day = number(8, 10);
    let days = match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 => {
            if year % 4 == 0 && (year % 100 != 0 || year % 400 == 0) {
                29
            } else {
                28
            }
        }
        _ => return false,
    };
    day > 0 && day <= days && number(11, 13) < 24 && number(14, 16) < 60 && number(17, 19) < 60
}
fn fields<'a>(value: &'a Value, names: &[&str]) -> Result<&'a serde_json::Map<String, Value>, ()> {
    let object = value.as_object().ok_or(())?;
    if object.len() != names.len() || names.iter().any(|name| !object.contains_key(*name)) {
        return Err(());
    }
    Ok(object)
}
fn integer(value: &Value, max: u64) -> Result<u64, ()> {
    let number = value.as_f64().ok_or(())?;
    if !number.is_finite() || number < 0.0 || number.fract() != 0.0 || number > max as f64 {
        return Err(());
    }
    Ok(number as u64)
}
#[derive(Debug, PartialEq, Eq)]
pub struct LegacyReceipt {
    pub pending: bool,
    pub installation_key: String,
    pub fingerprint: String,
    pub enabled: bool,
}
#[derive(Debug, PartialEq, Eq)]
pub struct LegacyRecord {
    pub revision: u64,
    pub last: Option<LegacyReceipt>,
}
/// Matches the existing strict Zod v1 schema; missing-file/marker rules remain in the OS reader.
pub fn legacy_record(raw: &[u8]) -> Result<LegacyRecord, ()> {
    if raw.len() > 4096 {
        return Err(());
    }
    let value: Value = serde_json::from_slice(raw).map_err(|_| ())?;
    let root = fields(&value, &["version", "revision", "last"])?;
    if integer(&root["version"], 1)? != 1 {
        return Err(());
    }
    let revision = integer(&root["revision"], MAX_SAFE)?;
    if root["last"].is_null() {
        return if revision == 0 {
            Ok(LegacyRecord {
                revision,
                last: None,
            })
        } else {
            Err(())
        };
    }
    let last = fields(&root["last"], &["request", "startedAt", "state"])?;
    if !utc_time(last["startedAt"].as_str().ok_or(())?) {
        return Err(());
    }
    let state = last["state"].as_str().ok_or(())?;
    if !["pending", "completed", "refused"].contains(&state) {
        return Err(());
    }
    let request = fields(
        &last["request"],
        &[
            "requestId",
            "installationKey",
            "expectedRevision",
            "expectedFingerprint",
            "enabled",
        ],
    )?;
    if !uuid(request["requestId"].as_str().ok_or(())?)
        || integer(&request["expectedRevision"], MAX_SAFE - 1)?.checked_add(1) != Some(revision)
    {
        return Err(());
    }
    let key = request["installationKey"].as_str().ok_or(())?;
    let fingerprint = request["expectedFingerprint"].as_str().ok_or(())?;
    if !hex_key(key) || (fingerprint != "absent" && !hex_key(fingerprint)) {
        return Err(());
    }
    Ok(LegacyRecord {
        revision,
        last: Some(LegacyReceipt {
            pending: state == "pending",
            installation_key: key.into(),
            fingerprint: fingerprint.into(),
            enabled: request["enabled"].as_bool().ok_or(())?,
        }),
    })
}
impl LegacyRecord {
    pub fn clear_for_lifecycle(&self) -> bool {
        self.last.as_ref().is_none_or(|last| !last.pending)
    }
    pub fn authorizes_set(&self, key: &str, enabled: bool, expected_enabled: bool) -> bool {
        self.last.as_ref().is_some_and(|last| {
            last.pending
                && last.installation_key == key
                && last.enabled == enabled
                && last.fingerprint == if expected_enabled { key } else { "absent" }
        })
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Identity {
    pub principal: String,
    pub command: String,
}
impl Identity {
    fn valid(&self) -> bool {
        let command = self
            .command
            .strip_prefix('"')
            .and_then(|s| s.strip_suffix("\" --from-login"));
        self.principal.len() <= 184
            && self.principal.starts_with("S-1-")
            && self
                .principal
                .as_bytes()
                .last()
                .is_some_and(u8::is_ascii_digit)
            && self.principal[4..]
                .bytes()
                .all(|b| b.is_ascii_digit() || b == b'-')
            && !self.principal.contains("--")
            && command.is_some_and(|exe| {
                crate::startup::command(exe).is_ok_and(|value| value == self.command)
            })
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Operation {
    Activate,
    Retire,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum State {
    Active,
    Retired,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Intent {
    pub operation_id: String,
    pub operation: Operation,
    pub identity: Identity,
    pub generation: String,
    pub prior_sha256: Option<String>,
}
impl Intent {
    fn valid(&self) -> bool {
        operation_id(&self.operation_id)
            && operation_id(&self.generation)
            && self.identity.valid()
            && self.prior_sha256.as_deref().is_none_or(hex_key)
    }
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Generation {
    pub identity: Identity,
    pub generation: String,
    pub state: State,
    pub receipt: Intent,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Manifest {
    pub version: u8,
    pub revision: u64,
    pub generations: Vec<Generation>,
    pub pending: Option<Intent>,
}
impl Manifest {
    pub fn parse(raw: &[u8]) -> Result<Self, ()> {
        if raw.len() > MAX_MANIFEST_BYTES {
            return Err(());
        }
        let manifest: Self = serde_json::from_slice(raw).map_err(|_| ())?;
        manifest.validate()?;
        Ok(manifest)
    }
    pub fn validate(&self) -> Result<(), ()> {
        if self.version != 1
            || self.revision == 0
            || self.revision > MAX_SAFE
            || self.generations.len() > MAX_GENERATIONS
            || (self.generations.is_empty() && self.pending.is_none())
        {
            return Err(());
        }
        let mut ids = HashSet::new();
        let mut active = HashSet::new();
        for row in &self.generations {
            // Per installation, retired predecessors precede its sole current
            // active generation. A later retired row cannot conceal an active one.
            if active.contains(&(&row.identity.principal, &row.identity.command)) {
                return Err(());
            }
            if !row.receipt.valid()
                || row.receipt.identity != row.identity
                || row.receipt.generation != row.generation
                || !ids.insert(&row.generation)
            {
                return Err(());
            }
            if row.state == State::Active {
                if row.receipt.operation != Operation::Activate
                    || !active.insert((&row.identity.principal, &row.identity.command))
                {
                    return Err(());
                }
            } else if row.receipt.operation != Operation::Retire {
                return Err(());
            }
        }
        if let Some(intent) = &self.pending {
            if !intent.valid() {
                return Err(());
            }
            match intent.operation {
                Operation::Activate
                    if ids.contains(&intent.generation)
                        || self.generations.iter().any(|row| {
                            row.identity == intent.identity && row.state == State::Active
                        })
                        || self.generations.len() == MAX_GENERATIONS =>
                {
                    return Err(())
                }
                Operation::Retire
                    if !self.generations.iter().any(|row| {
                        row.identity == intent.identity
                            && row.generation == intent.generation
                            && row.state == State::Active
                    }) =>
                {
                    return Err(())
                }
                _ => {}
            }
        }
        Ok(())
    }
    pub fn active(&self, identity: &Identity) -> Result<Option<&str>, ()> {
        self.validate()?;
        if self.pending.is_some() {
            return Err(());
        }
        Ok(self
            .generations
            .iter()
            .find(|row| row.identity == *identity && row.state == State::Active)
            .map(|row| row.generation.as_str()))
    }
}
pub enum Plan {
    Preserved(Manifest),
    Pending(Manifest),
}
/// Explicit installer activation is the sole operation that can create a generation.
pub fn begin(
    current: Option<Manifest>,
    identity: Identity,
    operation: Operation,
    operation_id: String,
    generation: String,
    prior_sha256: Option<String>,
) -> Result<Plan, ()> {
    if !identity.valid() || !self::operation_id(&operation_id) {
        return Err(());
    }
    let mut manifest = if let Some(value) = current {
        value.validate()?;
        if value.pending.is_some() || !prior_sha256.as_deref().is_some_and(hex_key) {
            return Err(());
        }
        value
    } else {
        if operation != Operation::Activate || prior_sha256.is_some() {
            return Err(());
        }
        Manifest {
            version: 1,
            revision: 0,
            generations: vec![],
            pending: None,
        }
    };
    let existing = manifest
        .generations
        .iter()
        .rev()
        .find(|row| row.identity == identity);
    if existing.is_some_and(|row| {
        (operation == Operation::Activate && row.state == State::Active)
            || (operation == Operation::Retire && row.state == State::Retired)
    }) {
        return Ok(Plan::Preserved(manifest));
    }
    let generation = match operation {
        Operation::Activate => generation,
        Operation::Retire => existing.ok_or(())?.generation.clone(),
    };
    if manifest.revision > MAX_SAFE - 2 {
        return Err(());
    }
    manifest.revision += 1;
    manifest.pending = Some(Intent {
        operation_id,
        operation,
        identity,
        generation,
        prior_sha256,
    });
    manifest.validate()?;
    Ok(Plan::Pending(manifest))
}
/// Called only after the exact pending bytes and native effect have been verified under both locks.
pub fn complete(mut manifest: Manifest) -> Result<Manifest, ()> {
    manifest.validate()?;
    let intent = manifest.pending.take().ok_or(())?;
    match intent.operation {
        Operation::Activate => manifest.generations.push(Generation {
            identity: intent.identity.clone(),
            generation: intent.generation.clone(),
            state: State::Active,
            receipt: intent,
        }),
        Operation::Retire => {
            let row = manifest
                .generations
                .iter_mut()
                .find(|row| row.generation == intent.generation && row.identity == intent.identity)
                .ok_or(())?;
            row.state = State::Retired;
            row.receipt = intent;
        }
    }
    manifest.revision = manifest
        .revision
        .checked_add(1)
        .filter(|v| *v <= MAX_SAFE)
        .ok_or(())?;
    manifest.validate()?;
    Ok(manifest)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn identity() -> Identity {
        Identity { principal: "S-1-5-21-123".into(), command: "\"C:\\Users\\fixture\\AppData\\Local\\Agent Forge Harness\\agent-forge-desktop.exe\" --from-login".into() }
    }
    fn id(n: u8) -> String {
        format!("{n:08x}-1111-4111-8111-111111111111")
    }
    fn pending(current: Option<Manifest>, operation: Operation, n: u8) -> Manifest {
        let prior = current.as_ref().map(|_| "a".repeat(64));
        match begin(current, identity(), operation, id(n), id(n + 1), prior).unwrap() {
            Plan::Pending(value) => value,
            _ => panic!("Expected pending"),
        }
    }
    #[test]
    fn native_and_settings_share_the_strict_legacy_journal_boundary_corpus() {
        #[derive(Deserialize)]
        struct Case {
            name: String,
            raw: String,
            valid: bool,
        }
        let cases: Vec<Case> =
            serde_json::from_str(include_str!("../test-fixtures/startup-legacy-records.json"))
                .unwrap();
        for case in cases {
            assert_eq!(
                legacy_record(case.raw.as_bytes()).is_ok(),
                case.valid,
                "{}",
                case.name
            );
        }
    }
    #[test]
    fn only_the_owning_pending_settings_request_authorizes_set() {
        let raw = serde_json::json!({"version":1,"revision":1,"last":{"request":{"requestId":id(1),"installationKey":"a".repeat(64),"expectedRevision":0,"expectedFingerprint":"absent","enabled":true},"startedAt":"2026-11-16T12:00:00Z","state":"pending"}});
        let pending = legacy_record(&serde_json::to_vec(&raw).unwrap()).unwrap();
        assert!(!pending.clear_for_lifecycle());
        assert!(pending.authorizes_set(&"a".repeat(64), true, false));
        assert!(!pending.authorizes_set(&"b".repeat(64), true, false));
        assert!(!pending.authorizes_set(&"a".repeat(64), false, false));
        assert!(!pending.authorizes_set(&"a".repeat(64), true, true));
        let mut terminal = raw;
        terminal["last"]["state"] = Value::String("completed".into());
        let terminal = legacy_record(&serde_json::to_vec(&terminal).unwrap()).unwrap();
        assert!(terminal.clear_for_lifecycle());
        assert!(!terminal.authorizes_set(&"a".repeat(64), true, false));
    }
    #[test]
    fn an_unresolved_other_installation_holds_the_current_generation() {
        let active = complete(pending(None, Operation::Activate, 1)).unwrap();
        let mut other = identity();
        other.command = "\"C:\\Other\\agent-forge-desktop.exe\" --from-login".into();
        let held = match begin(
            Some(active),
            other,
            Operation::Activate,
            id(3),
            id(4),
            Some("a".repeat(64)),
        )
        .unwrap()
        {
            Plan::Pending(value) => value,
            _ => panic!("Expected pending"),
        };
        assert!(held.active(&identity()).is_err());
        assert!(begin(
            Some(held),
            identity(),
            Operation::Retire,
            id(5),
            id(6),
            Some("a".repeat(64))
        )
        .is_err());
    }
    #[test]
    fn retired_generations_cannot_rearm_and_reinstall_retains_predecessors() {
        assert!(begin(None, identity(), Operation::Retire, id(1), id(2), None).is_err());
        let active = complete(pending(None, Operation::Activate, 1)).unwrap();
        assert_eq!(active.active(&identity()).unwrap(), Some(id(2).as_str()));
        let retired = complete(pending(Some(active), Operation::Retire, 3)).unwrap();
        assert_eq!(retired.active(&identity()).unwrap(), None);
        let reinstalled = complete(pending(Some(retired), Operation::Activate, 5)).unwrap();
        assert_eq!(reinstalled.generations.len(), 2);
        assert_eq!(reinstalled.generations[0].state, State::Retired);
        assert_eq!(
            reinstalled.active(&identity()).unwrap(),
            Some(id(6).as_str())
        );
    }
    #[test]
    fn any_pending_operation_holds_all_generations_and_cannot_be_replayed() {
        let held = pending(None, Operation::Activate, 1);
        assert!(held.active(&identity()).is_err());
        assert!(begin(
            Some(held),
            identity(),
            Operation::Activate,
            id(3),
            id(4),
            Some("a".repeat(64))
        )
        .is_err());
    }
    #[test]
    fn valid_active_update_preserves_the_original_generation_and_receipt() {
        let active = complete(pending(None, Operation::Activate, 1)).unwrap();
        let original = active.clone();
        match begin(
            Some(active),
            identity(),
            Operation::Activate,
            id(3),
            id(4),
            Some("a".repeat(64)),
        )
        .unwrap()
        {
            Plan::Preserved(value) => assert_eq!(value, original),
            _ => panic!("Update rearmed"),
        }
    }
    #[test]
    fn malformed_duplicate_and_foreign_generation_links_refuse() {
        let mut active = complete(pending(None, Operation::Activate, 1)).unwrap();
        active.generations.push(active.generations[0].clone());
        assert!(active.validate().is_err());
        active.generations.pop();
        active.generations[0].receipt.identity.principal = "S-1-5-21-999".into();
        assert!(active.validate().is_err());
        assert!(Manifest::parse(
            br#"{"version":1,"revision":1,"generations":[],"pending":null,"foreign":true}"#
        )
        .is_err());
    }
    #[test]
    fn a_later_retired_record_cannot_conceal_a_still_active_generation() {
        let mut manifest = complete(pending(None, Operation::Activate, 1)).unwrap();
        manifest.generations.push(Generation {
            identity: identity(),
            generation: id(4),
            state: State::Retired,
            receipt: Intent {
                operation_id: id(3),
                operation: Operation::Retire,
                identity: identity(),
                generation: id(4),
                prior_sha256: Some("a".repeat(64)),
            },
        });
        assert!(manifest.validate().is_err());
        assert!(begin(
            Some(manifest),
            identity(),
            Operation::Retire,
            id(5),
            id(6),
            Some("a".repeat(64))
        )
        .is_err());
    }
}
