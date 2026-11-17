//! Native startup coordination. Only installer lifecycle takes the outer SQL
//! lock; ordinary Settings already owns it and takes only the inner effect lease.
use crate::{
    config_publish, private_files, startup, startup_lifecycle as policy,
    startup_package_windows::PackageGuard,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::ffi::{c_char, c_void, CString};
use std::path::{Path, PathBuf};
use std::ptr::null_mut;
use std::time::{Duration, Instant};

type Handle = *mut c_void;
type Callback =
    Option<unsafe extern "C" fn(*mut c_void, i32, *mut *mut c_char, *mut *mut c_char) -> i32>;
type Open = unsafe extern "C" fn(*const c_char, *mut Handle, i32, *const c_char) -> i32;
type Exec =
    unsafe extern "C" fn(Handle, *const c_char, Callback, *mut c_void, *mut *mut c_char) -> i32;
type Close = unsafe extern "C" fn(Handle) -> i32;
type Busy = unsafe extern "C" fn(Handle, i32) -> i32;
type Readonly = unsafe extern "C" fn(Handle, *const c_char) -> i32;
#[link(name = "kernel32")]
unsafe extern "system" {
    fn GetSystemDirectoryW(buffer: *mut u16, length: u32) -> u32;
    fn LoadLibraryExW(name: *const u16, file: Handle, flags: u32) -> Handle;
    fn GetProcAddress(module: Handle, name: *const u8) -> *const c_void;
    fn FreeLibrary(module: Handle) -> i32;
}
struct Library(Handle);
impl Drop for Library {
    fn drop(&mut self) {
        unsafe {
            FreeLibrary(self.0);
        }
    }
}
struct SqlApi {
    _library: Library,
    open: Open,
    exec: Exec,
    close: Close,
    busy: Busy,
    readonly: Readonly,
}
impl SqlApi {
    fn load() -> Result<Self, ()> {
        // No environment-derived DLL path or ordinary DLL search fallback.
        let mut system = vec![0u16; 32768];
        let count =
            unsafe { GetSystemDirectoryW(system.as_mut_ptr(), system.len() as u32) } as usize;
        if count < 3 || count >= system.len() {
            return Err(());
        }
        system.truncate(count);
        system.extend("\\winsqlite3.dll".encode_utf16());
        system.push(0);
        let module = unsafe { LoadLibraryExW(system.as_ptr(), null_mut(), 0x00000800) };
        if module.is_null() {
            return Err(());
        }
        let library = Library(module);
        macro_rules! symbol {
            ($name:literal, $kind:ty) => {{
                let pointer = unsafe { GetProcAddress(module, concat!($name, "\0").as_ptr()) };
                if pointer.is_null() {
                    return Err(());
                }
                unsafe { std::mem::transmute::<*const c_void, $kind>(pointer) }
            }};
        }
        Ok(Self {
            open: symbol!("sqlite3_open_v2", Open),
            exec: symbol!("sqlite3_exec", Exec),
            close: symbol!("sqlite3_close", Close),
            busy: symbol!("sqlite3_busy_timeout", Busy),
            readonly: symbol!("sqlite3_db_readonly", Readonly),
            _library: library,
        })
    }
}
struct Mode {
    calls: usize,
    delete: bool,
}
unsafe extern "C" fn journal_mode(
    context: *mut c_void,
    count: i32,
    values: *mut *mut c_char,
    _names: *mut *mut c_char,
) -> i32 {
    if context.is_null() || count != 1 || values.is_null() {
        return 1;
    }
    let mode = unsafe { &mut *context.cast::<Mode>() };
    mode.calls += 1;
    let value = unsafe { *values };
    if mode.calls != 1 || value.is_null() {
        return 1;
    }
    let expected = b"delete\0";
    mode.delete = expected
        .iter()
        .enumerate()
        .all(|(i, byte)| unsafe { *value.add(i) as u8 } == *byte);
    if mode.delete {
        0
    } else {
        1
    }
}
/// Owns the existing database identity and a write transaction for its lifetime.
/// The qualified VFS/mode are required, never configured or silently substituted.
struct SqlLock {
    api: SqlApi,
    connection: Handle,
    begun: bool,
    _pin: private_files::Lease,
}
impl SqlLock {
    fn acquire(path: &Path) -> Result<Self, ()> {
        let pin = private_files::sqlite_pin(path).map_err(|_| ())?;
        let api = SqlApi::load()?;
        let name = CString::new(path.to_str().ok_or(())?).map_err(|_| ())?;
        let mut owned = Self {
            api,
            connection: null_mut(),
            begun: false,
            _pin: pin,
        };
        // READWRITE only: lifecycle bootstrap creates a protected file separately.
        let code =
            unsafe { (owned.api.open)(name.as_ptr(), &mut owned.connection, 2, c"win32".as_ptr()) };
        if code != 0 || owned.connection.is_null() {
            return Err(());
        }
        if unsafe { (owned.api.readonly)(owned.connection, c"main".as_ptr()) } != 0
            || unsafe { (owned.api.busy)(owned.connection, 750) } != 0
        {
            return Err(());
        }
        if unsafe {
            (owned.api.exec)(
                owned.connection,
                c"BEGIN EXCLUSIVE".as_ptr(),
                None,
                null_mut(),
                null_mut(),
            )
        } != 0
        {
            return Err(());
        }
        owned.begun = true;
        let mut mode = Mode {
            calls: 0,
            delete: false,
        };
        if unsafe {
            (owned.api.exec)(
                owned.connection,
                c"PRAGMA journal_mode".as_ptr(),
                Some(journal_mode),
                (&mut mode as *mut Mode).cast(),
                null_mut(),
            )
        } != 0
            || mode.calls != 1
            || !mode.delete
        {
            return Err(());
        }
        Ok(owned)
    }
}
impl Drop for SqlLock {
    fn drop(&mut self) {
        if !self.connection.is_null() {
            // No domain effects after terminal publication: release SQL ownership,
            // close the exact connection, then release its pinned file and DLL.
            if self.begun {
                unsafe {
                    (self.api.exec)(
                        self.connection,
                        c"COMMIT".as_ptr(),
                        None,
                        null_mut(),
                        null_mut(),
                    );
                }
            }
            unsafe {
                (self.api.close)(self.connection);
            }
        }
    }
}

const MARKER: &str = "startup-generation.initialized";
const MANIFEST: &str = "startup-generations.json";
const EFFECT: &str = "startup-generation.lock";
const SQL: &str = "startup-registration.lock";
const MARKER_BYTES: &[u8] = b"startup-generations-v1\n";
fn missing(path: &Path) -> bool {
    std::fs::symlink_metadata(path).is_err_and(|e| e.kind() == std::io::ErrorKind::NotFound)
}
fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn installation_key(command: &str, generation: &str) -> String {
    let mut bytes = command.as_bytes().to_vec();
    bytes.push(0);
    bytes.extend(generation.as_bytes());
    digest(&bytes)
}
fn effect_lease(path: &Path) -> Result<private_files::Lease, ()> {
    let until = Instant::now() + Duration::from_millis(500);
    loop {
        if let Ok(lease) = private_files::lease(path, false) {
            return Ok(lease);
        }
        if Instant::now() >= until {
            return Err(());
        }
        std::thread::sleep(Duration::from_millis(10));
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
enum Phase {
    Pending,
    Active,
    Retired,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Publication {
    version: u8,
    intent: policy::Intent,
    phase: Phase,
    revision: u64,
    manifest_sha256: String,
}
fn receipt_path(home: &Path, intent: &policy::Intent, terminal: bool) -> PathBuf {
    home.join(format!(
        "startup-generation-{}-{}.json",
        intent.operation_id,
        if terminal { "terminal" } else { "pending" }
    ))
}
fn validate_receipts(home: &Path, manifest: &policy::Manifest, raw: &[u8]) -> Result<(), ()> {
    if manifest.pending.is_some() {
        return Err(());
    }
    let mut revisions = std::collections::HashSet::new();
    let mut latest = 0;
    for row in &manifest.generations {
        let bytes =
            private_files::read(&receipt_path(home, &row.receipt, true), 8192).map_err(|_| ())?;
        let receipt: Publication = serde_json::from_slice(&bytes).map_err(|_| ())?;
        let phase = if row.state == policy::State::Active {
            Phase::Active
        } else {
            Phase::Retired
        };
        if receipt.version != 1
            || receipt.intent != row.receipt
            || receipt.phase != phase
            || receipt.revision == 0
            || receipt.revision > manifest.revision
            || !policy::hex_key(&receipt.manifest_sha256)
            || !revisions.insert(receipt.revision)
        {
            return Err(());
        }
        if receipt.revision == manifest.revision && receipt.manifest_sha256 != digest(raw) {
            return Err(());
        }
        latest = latest.max(receipt.revision);
    }
    if latest != manifest.revision {
        return Err(());
    }
    Ok(())
}
fn publish(
    home: &Path,
    before: Option<&[u8]>,
    after: &policy::Manifest,
    intent: &policy::Intent,
    phase: Phase,
) -> Result<Vec<u8>, ()> {
    let bytes = serde_json::to_vec(after).map_err(|_| ())?;
    if bytes.len() > policy::MAX_MANIFEST_BYTES {
        return Err(());
    }
    let reviewed = config_publish::review(&home.join(MANIFEST)).map_err(|_| ())?;
    if reviewed.exists() != before.is_some() || reviewed.original() != before.unwrap_or(&[]) {
        return Err(());
    }
    let receipt = serde_json::to_vec(&Publication {
        version: 1,
        intent: intent.clone(),
        phase,
        revision: after.revision,
        manifest_sha256: digest(&bytes),
    })
    .map_err(|_| ())?;
    let path = receipt_path(home, intent, phase != Phase::Pending);
    let security = private_files::creation_security().map_err(|_| ())?;
    let pending = config_publish::prepare_private(
        reviewed,
        &bytes,
        config_publish::review(&path).map_err(|_| ())?,
        &receipt,
        &security,
    )
    .map_err(|_| ())?;
    if pending.commit() != config_publish::Outcome::Confirmed
        || private_files::read(&home.join(MANIFEST), policy::MAX_MANIFEST_BYTES).map_err(|_| ())?
            != bytes
        || private_files::read(&path, 8192).map_err(|_| ())? != receipt
    {
        return Err(());
    }
    Ok(bytes)
}
fn read_legacy(home: &Path) -> Result<policy::LegacyRecord, ()> {
    let record = private_files::read_optional(&home.join("startup-registration.json"), 4096)
        .map_err(|_| ())?;
    let marker = private_files::read_optional(&home.join("startup-registration.initialized"), 64)
        .map_err(|_| ())?;
    match (record, marker) {
        (None, None) => Ok(policy::LegacyRecord {
            revision: 0,
            last: None,
        }),
        (Some(raw), Some(marker)) if marker == b"app-startup-v1\n" => {
            let value = policy::legacy_record(&raw)?;
            if value.revision == 0 {
                return Err(());
            }
            Ok(value)
        }
        _ => Err(()),
    }
}
fn current_manifest(home: &Path) -> Result<(policy::Manifest, Vec<u8>), ()> {
    if private_files::read(&home.join(MARKER), 64).map_err(|_| ())? != MARKER_BYTES {
        return Err(());
    }
    let raw =
        private_files::read(&home.join(MANIFEST), policy::MAX_MANIFEST_BYTES).map_err(|_| ())?;
    let manifest = policy::Manifest::parse(&raw)?;
    validate_receipts(home, &manifest, &raw)?;
    Ok((manifest, raw))
}
struct Managed {
    _directory: private_files::Directory,
    _sql_pin: private_files::Lease,
    _effect: private_files::Lease,
    manifest: policy::Manifest,
}
#[repr(C)]
struct Guid {
    a: u32,
    b: u16,
    c: u16,
    d: [u8; 8],
}
#[link(name = "ole32")]
unsafe extern "system" {
    fn CoCreateGuid(value: *mut Guid) -> i32;
}
fn new_uuid() -> Result<String, ()> {
    let mut value = Guid {
        a: 0,
        b: 0,
        c: 0,
        d: [0; 8],
    };
    if unsafe { CoCreateGuid(&mut value) } != 0 {
        return Err(());
    }
    Ok(format!(
        "{:08x}-{:04x}-{:04x}-{:02x}{:02x}-{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}",
        value.a,
        value.b,
        value.c,
        value.d[0],
        value.d[1],
        value.d[2],
        value.d[3],
        value.d[4],
        value.d[5],
        value.d[6],
        value.d[7]
    ))
}
pub struct Context {
    identity: policy::Identity,
    parent: String,
    home: PathBuf,
    supported: bool,
}
impl Context {
    /// Both arguments come only from current_exe and SHGetKnownFolderPath in the
    /// native entry point, never from argv, renderer fields or environment homes.
    pub fn from_os(exe: &Path, parent: String) -> Result<Self, ()> {
        let expected = startup::command(exe.to_str().ok_or(())?)?;
        let supported = exe
            == Path::new(&parent)
                .join("Agent Forge Harness")
                .join("agent-forge-desktop.exe");
        Ok(Self {
            identity: policy::Identity {
                principal: private_files::principal_sid().map_err(|_| ())?,
                command: expected,
            },
            home: Path::new(&parent).join(".agent-forge-startup-v1"),
            parent,
            supported,
        })
    }
    fn data(
        &self,
        outcome: &str,
        generation: Option<&str>,
        observed: Option<startup::Registration>,
    ) -> serde_json::Value {
        let registration = observed.map(|value| match value {
            startup::Registration::Enabled => "enabled",
            startup::Registration::Disabled => "disabled",
            startup::Registration::Conflict => "conflict",
        });
        serde_json::json!({"version":2,"expectedCommand":self.identity.command,"coordinationParent":self.parent,"capability":if generation.is_some(){"available"}else{"install-required"},"generation":generation,"outcome":outcome,"registration":registration})
    }
    fn existing(&self) -> Result<Option<Managed>, ()> {
        if missing(&self.home) {
            return Ok(None);
        }
        let directory = private_files::directory(&self.home, false).map_err(|_| ())?;
        let marker = missing(&self.home.join(MARKER));
        let manifest = missing(&self.home.join(MANIFEST));
        let effect = missing(&self.home.join(EFFECT));
        if marker && manifest && effect {
            return Ok(None);
        }
        if marker || manifest || effect {
            return Err(());
        }
        let sql_pin = private_files::sqlite_pin(&self.home.join(SQL)).map_err(|_| ())?;
        let lease = effect_lease(&self.home.join(EFFECT))?;
        let (manifest, _) = current_manifest(&self.home)?;
        Ok(Some(Managed {
            _directory: directory,
            _sql_pin: sql_pin,
            _effect: lease,
            manifest,
        }))
    }
    pub fn read(&self, registry: &mut impl startup::Registry) -> Result<serde_json::Value, ()> {
        if !self.supported {
            return Ok(self.data("read", None, None));
        }
        let Some(state) = self.existing()? else {
            return Ok(self.data("read", None, None));
        };
        let generation = state.manifest.active(&self.identity)?;
        let Some(generation) = generation else {
            return Ok(self.data("read", None, None));
        };
        Ok(self.data(
            "read",
            Some(generation),
            Some(startup::inspect(registry, &self.identity.command)?),
        ))
    }
    pub fn set(
        &self,
        registry: &mut impl startup::Registry,
        enabled: bool,
        expected: startup::Registration,
        reviewed_key: &str,
    ) -> Result<serde_json::Value, ()> {
        if !self.supported
            || !policy::hex_key(reviewed_key)
            || expected == startup::Registration::Conflict
        {
            return Err(());
        }
        let state = self.existing()?.ok_or(())?;
        let generation = state.manifest.active(&self.identity)?.ok_or(())?;
        if installation_key(&self.identity.command, generation) != reviewed_key
            || !read_legacy(&self.home)?.authorizes_set(
                reviewed_key,
                enabled,
                expected == startup::Registration::Enabled,
            )
        {
            return Err(());
        }
        // The TS caller owns SQLite and its exact pending intent. Never reacquire
        // the outer lock here, and never publish or repair its v1 journal.
        let (outcome, observed) =
            match startup::set(registry, &self.identity.command, expected, enabled) {
                startup::Outcome::Completed(value) => ("completed", Some(value)),
                startup::Outcome::Refused(value) => ("refused", Some(value)),
                startup::Outcome::Unconfirmed => ("unconfirmed", None),
            };
        Ok(self.data(outcome, Some(generation), observed))
    }
    /// PackageGuard is opaque and held by the entry point through process exit.
    /// This path is synchronous and childless; it never starts a GUI or worker.
    pub fn lifecycle(
        &self,
        registry: &mut impl startup::Registry,
        operation: policy::Operation,
        _package: &PackageGuard,
    ) -> Result<serde_json::Value, ()> {
        self.lifecycle_inner(registry, operation)
    }
    fn lifecycle_inner(
        &self,
        registry: &mut impl startup::Registry,
        operation: policy::Operation,
    ) -> Result<serde_json::Value, ()> {
        if !self.supported {
            return Err(());
        }
        let operation_id = new_uuid()?;
        let generation = new_uuid()?;
        // Retirement never creates a home, SQL lock, marker or generation.
        let _directory =
            private_files::directory(&self.home, operation == policy::Operation::Activate)
                .map_err(|_| ())?;
        let uninitialized = self.generation_shape()?;
        if operation == policy::Operation::Retire && uninitialized {
            return Err(());
        }
        let before_legacy = read_legacy(&self.home)?;
        if !before_legacy.clear_for_lifecycle() {
            return Err(());
        }
        if missing(&self.home.join(SQL)) {
            if operation != policy::Operation::Activate
                || !uninitialized
                || before_legacy.revision != 0
            {
                return Err(());
            }
            private_files::create(&self.home.join(SQL), b"").map_err(|_| ())?;
        }
        let _sql = SqlLock::acquire(&self.home.join(SQL))?;
        if !read_legacy(&self.home)?.clear_for_lifecycle() {
            return Err(());
        }
        let uninitialized = self.generation_shape()?;
        let (_effect, current, before) = if uninitialized {
            if operation != policy::Operation::Activate {
                return Err(());
            }
            // A crash anywhere here leaves an explicit orphan/marker hold. The
            // next invocation never repairs or removes these originals.
            private_files::create(&self.home.join(EFFECT), b"").map_err(|_| ())?;
            let lease = effect_lease(&self.home.join(EFFECT))?;
            private_files::create(&self.home.join(MARKER), MARKER_BYTES).map_err(|_| ())?;
            (lease, None, None)
        } else {
            let lease = effect_lease(&self.home.join(EFFECT))?;
            let (manifest, raw) = current_manifest(&self.home)?;
            (lease, Some(manifest), Some(raw))
        };
        let prior = before.as_deref().map(digest);
        let plan = policy::begin(
            current,
            self.identity.clone(),
            operation,
            operation_id,
            generation,
            prior,
        )?;
        let pending = match plan {
            policy::Plan::Preserved(manifest) => {
                // A completed retirement is reusable only while the exact owned
                // Run command remains absent. Foreign values remain untouched.
                if operation == policy::Operation::Retire
                    && startup::inspect(registry, &self.identity.command)?
                        == startup::Registration::Enabled
                {
                    return Err(());
                }
                let row = manifest
                    .generations
                    .iter()
                    .rev()
                    .find(|row| row.identity == self.identity)
                    .ok_or(())?;
                return Ok(
                    serde_json::json!({"version":1,"outcome":"completed","operation":operation,"generation":row.generation,"state":row.state}),
                );
            }
            policy::Plan::Pending(manifest) => manifest,
        };
        let intent = pending.pending.clone().ok_or(())?;
        let pending_raw = publish(
            &self.home,
            before.as_deref(),
            &pending,
            &intent,
            Phase::Pending,
        )?;
        if operation == policy::Operation::Retire
            && startup::inspect(registry, &self.identity.command)? == startup::Registration::Enabled
        {
            match startup::set(
                registry,
                &self.identity.command,
                startup::Registration::Enabled,
                false,
            ) {
                startup::Outcome::Completed(startup::Registration::Disabled)
                | startup::Outcome::Refused(
                    startup::Registration::Disabled | startup::Registration::Conflict,
                ) => {}
                _ => return Err(()),
            }
        }
        let terminal = policy::complete(pending)?;
        let state = if operation == policy::Operation::Activate {
            Phase::Active
        } else {
            Phase::Retired
        };
        publish(&self.home, Some(&pending_raw), &terminal, &intent, state)?;
        // From the verified terminal publication onward: no registry calls,
        // retries, callbacks, children or further lifecycle writes. Only JSON
        // construction and RAII lock/handle cleanup precede the native exit.
        Ok(
            serde_json::json!({"version":1,"outcome":"completed","operation":operation,"generation":intent.generation,"state":state}),
        )
    }
    fn generation_shape(&self) -> Result<bool, ()> {
        let absent = [MARKER, MANIFEST, EFFECT].map(|name| missing(&self.home.join(name)));
        if absent.iter().all(|value| *value) {
            return Ok(true);
        }
        if absent.iter().any(|value| *value) {
            return Err(());
        }
        Ok(false)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Scratch(PathBuf);
    impl Drop for Scratch {
        fn drop(&mut self) {
            let actual = std::fs::canonicalize(&self.0).unwrap();
            assert_eq!(
                actual.parent(),
                Some(
                    std::fs::canonicalize(std::env::temp_dir())
                        .unwrap()
                        .as_path()
                )
            );
            assert!(actual
                .file_name()
                .unwrap()
                .to_string_lossy()
                .starts_with("forge-startup-lifecycle-"));
            std::fs::remove_dir_all(actual).unwrap();
        }
    }
    struct FakeRegistry {
        entry: startup::Entry,
        reads: usize,
        writes: usize,
        fail_write: bool,
        home: PathBuf,
    }
    impl startup::Registry for FakeRegistry {
        fn read(&mut self) -> Result<startup::Entry, ()> {
            self.reads += 1;
            Ok(match &self.entry {
                startup::Entry::Absent => startup::Entry::Absent,
                startup::Entry::Text(text) => startup::Entry::Text(text.clone()),
                startup::Entry::Invalid => startup::Entry::Invalid,
            })
        }
        fn write(&mut self, value: Option<&str>) -> Result<(), ()> {
            self.writes += 1;
            // Retirement intent is durable before any registry effect.
            let raw =
                private_files::read(&self.home.join(MANIFEST), policy::MAX_MANIFEST_BYTES).unwrap();
            let manifest = policy::Manifest::parse(&raw).unwrap();
            if value.is_none() {
                assert_eq!(
                    manifest.pending.unwrap().operation,
                    policy::Operation::Retire
                );
            }
            if self.fail_write {
                return Err(());
            }
            self.entry = value.map_or(startup::Entry::Absent, |text| {
                startup::Entry::Text(text.into())
            });
            Ok(())
        }
    }
    struct Fixture {
        context: Context,
        registry: FakeRegistry,
        _root: private_files::Directory,
        _scratch: Scratch,
    }
    impl Fixture {
        fn new() -> Self {
            let nonce = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let path = std::env::temp_dir().join(format!(
                "forge-startup-lifecycle-{:x}-{nonce:x}",
                std::process::id()
            ));
            let root = private_files::directory(&path, true).unwrap();
            let home = path.join(".agent-forge-startup-v1");
            let context = Context { identity: policy::Identity { principal: private_files::principal_sid().unwrap(), command: "\"C:\\Users\\fixture\\AppData\\Local\\Agent Forge Harness\\agent-forge-desktop.exe\" --from-login".into() }, parent: path.to_str().unwrap().into(), home: home.clone(), supported: true };
            Self {
                context,
                registry: FakeRegistry {
                    entry: startup::Entry::Absent,
                    reads: 0,
                    writes: 0,
                    fail_write: false,
                    home,
                },
                _root: root,
                _scratch: Scratch(path),
            }
        }
        fn lifecycle(&mut self, operation: policy::Operation) -> Result<serde_json::Value, ()> {
            self.context.lifecycle_inner(&mut self.registry, operation)
        }
        fn generation(&self) -> String {
            current_manifest(&self.context.home)
                .unwrap()
                .0
                .active(&self.context.identity)
                .unwrap()
                .unwrap()
                .into()
        }
        fn pending(&self, key: &str) {
            private_files::create(
                &self.context.home.join("startup-registration.initialized"),
                b"app-startup-v1\n",
            )
            .unwrap();
            let value = serde_json::json!({"version":1,"revision":1,"last":{"request":{"requestId":"11111111-1111-4111-8111-111111111111","installationKey":key,"expectedRevision":0,"expectedFingerprint":"absent","enabled":true},"startedAt":"2026-11-16T12:00:00Z","state":"pending"}});
            private_files::create(
                &self.context.home.join("startup-registration.json"),
                &serde_json::to_vec(&value).unwrap(),
            )
            .unwrap();
        }
    }
    #[test]
    fn portable_and_missing_retirement_never_bootstrap_state_or_read_registry() {
        let mut f = Fixture::new();
        f.context.supported = false;
        let value = f.context.read(&mut f.registry).unwrap();
        assert_eq!(value["capability"], "install-required");
        assert!(value["registration"].is_null());
        assert!(f.lifecycle(policy::Operation::Activate).is_err());
        f.context.supported = true;
        assert!(f.lifecycle(policy::Operation::Retire).is_err());
        assert!(!f.context.home.exists());
        assert_eq!((f.registry.reads, f.registry.writes), (0, 0));
    }
    #[test]
    fn retirement_reinstall_and_own_pending_key_prevent_late_generation_writes() {
        let mut f = Fixture::new();
        f.registry.entry = startup::Entry::Text(f.context.identity.command.clone());
        f.lifecycle(policy::Operation::Activate).unwrap();
        let old = f.generation();
        f.lifecycle(policy::Operation::Activate).unwrap();
        assert_eq!(f.generation(), old);
        f.lifecycle(policy::Operation::Retire).unwrap();
        assert!(matches!(f.registry.entry, startup::Entry::Absent));
        f.lifecycle(policy::Operation::Activate).unwrap();
        let current = f.generation();
        assert_ne!(old, current);
        assert_eq!(
            current_manifest(&f.context.home)
                .unwrap()
                .0
                .generations
                .len(),
            2
        );
        let key = installation_key(&f.context.identity.command, &current);
        f.pending(&key);
        // Native Set must not reacquire the outer SQL transaction already owned by TS.
        let _outer = SqlLock::acquire(&f.context.home.join(SQL)).unwrap();
        assert!(f
            .context
            .set(
                &mut f.registry,
                true,
                startup::Registration::Disabled,
                &installation_key(&f.context.identity.command, &old)
            )
            .is_err());
        assert_eq!(f.registry.writes, 1);
        assert_eq!(
            f.context
                .set(&mut f.registry, true, startup::Registration::Disabled, &key)
                .unwrap()["outcome"],
            "completed"
        );
        assert_eq!(f.registry.writes, 2);
        assert!(read_legacy(&f.context.home).unwrap().last.unwrap().pending);
    }
    #[test]
    fn existing_global_settings_uncertainty_blocks_both_lifecycle_verbs() {
        let mut f = Fixture::new();
        f.lifecycle(policy::Operation::Activate).unwrap();
        let raw = private_files::read(&f.context.home.join(MANIFEST), policy::MAX_MANIFEST_BYTES)
            .unwrap();
        f.pending(&installation_key(
            &f.context.identity.command,
            &f.generation(),
        ));
        assert!(f.lifecycle(policy::Operation::Retire).is_err());
        assert!(f.lifecycle(policy::Operation::Activate).is_err());
        assert_eq!(
            private_files::read(&f.context.home.join(MANIFEST), policy::MAX_MANIFEST_BYTES)
                .unwrap(),
            raw
        );
        assert_eq!(f.registry.writes, 0);
    }
    #[test]
    fn failed_retirement_stays_globally_pending_and_is_never_retried() {
        let mut f = Fixture::new();
        f.registry.entry = startup::Entry::Text(f.context.identity.command.clone());
        f.lifecycle(policy::Operation::Activate).unwrap();
        f.registry.fail_write = true;
        assert!(f.lifecycle(policy::Operation::Retire).is_err());
        assert_eq!(f.registry.writes, 1);
        assert!(f.context.read(&mut f.registry).is_err());
        assert!(f.lifecycle(policy::Operation::Retire).is_err());
        assert!(f.lifecycle(policy::Operation::Activate).is_err());
        assert_eq!(f.registry.writes, 1);
        assert!(!f
            .context
            .home
            .join("startup-registration.initialized")
            .exists());
    }
    #[test]
    fn foreign_and_malformed_run_values_survive_retirement() {
        for entry in [
            startup::Entry::Text("foreign command".into()),
            startup::Entry::Invalid,
        ] {
            let mut f = Fixture::new();
            f.registry.entry = entry;
            f.lifecycle(policy::Operation::Activate).unwrap();
            f.lifecycle(policy::Operation::Retire).unwrap();
            assert_eq!(f.registry.writes, 0);
            assert!(matches!(
                f.registry.entry,
                startup::Entry::Text(_) | startup::Entry::Invalid
            ));
        }
    }
    #[test]
    fn sqlite_pin_allows_connections_but_missing_initialized_lock_is_not_recreated() {
        let mut f = Fixture::new();
        f.lifecycle(policy::Operation::Activate).unwrap();
        let path = f.context.home.join(SQL);
        {
            let _pin = private_files::sqlite_pin(&path).unwrap();
            assert!(std::fs::rename(&path, f.context.home.join("foreign.db")).is_err());
            let _sql = SqlLock::acquire(&path).unwrap();
        }
        {
            let _directory = private_files::directory(&f.context.home, false).unwrap();
            assert!(std::fs::rename(&f.context.home, f._scratch.0.join("moved-home")).is_err());
        }
        std::fs::remove_file(&path).unwrap();
        assert!(f.context.read(&mut f.registry).is_err());
        assert!(f.lifecycle(policy::Operation::Activate).is_err());
        assert!(!path.exists());
        assert_eq!(f.registry.writes, 0);
    }
}
