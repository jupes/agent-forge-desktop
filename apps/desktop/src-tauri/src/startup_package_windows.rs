//! A cooperating package retains one presence barrier in every lifecycle process.
//! This proves a live shared object, not who launched the process. The OS-user,
//! supported installation path and private generation provide the authority.
use std::ffi::c_void;
use windows::Win32::Foundation::{CompareObjectHandles, HANDLE};
type Handle = *mut c_void;
pub const PACKAGE_GUARD: &str = "Global\\dev.agentforge.harness.package.v1";

#[link(name = "kernel32")]
unsafe extern "system" {
    fn GetStdHandle(which: u32) -> Handle;
    fn GetHandleInformation(handle: Handle, flags: *mut u32) -> i32;
    fn SetHandleInformation(handle: Handle, mask: u32, flags: u32) -> i32;
    fn OpenMutexW(access: u32, inherit: i32, name: *const u16) -> Handle;
    fn CloseHandle(handle: Handle) -> i32;
}
pub struct PackageGuard {
    handle: Handle,
}
impl Drop for PackageGuard {
    fn drop(&mut self) {
        unsafe {
            CloseHandle(self.handle);
        }
    }
}
fn valid(handle: Handle) -> bool {
    !handle.is_null() && handle != -1isize as Handle
}

/// NSIS passes its actual, explicitly inherited guard as STD_INPUT_HANDLE.
/// Never accept an argv/environment handle, PID, name alone or bootstrap text.
pub fn inherited_guard() -> Result<PackageGuard, ()> {
    let input = unsafe { GetStdHandle((-10i32) as u32) };
    if !valid(input) {
        return Err(());
    }
    let mut flags = 0;
    if unsafe { GetHandleInformation(input, &mut flags) } == 0 || flags & 1 == 0 {
        return Err(());
    }
    let name: Vec<u16> = PACKAGE_GUARD.encode_utf16().chain(Some(0)).collect();
    let named = unsafe { OpenMutexW(0x00100000, 0, name.as_ptr()) };
    if !valid(named) {
        return Err(());
    }
    let same = unsafe { CompareObjectHandles(HANDLE(input), HANDLE(named)) }.as_bool();
    unsafe {
        CloseHandle(named);
    }
    if !same || unsafe { SetHandleInformation(input, 1, 0) } == 0 {
        return Err(());
    }
    // The caller retains this through process::exit, including all error paths.
    // No mutex ownership is acquired or released; presence lasts until exit.
    Ok(PackageGuard { handle: input })
}

#[cfg(test)]
mod tests {
    const INSTALLER: &str = include_str!("../installer/installer.nsi");

    fn section(name: &str) -> &str {
        INSTALLER
            .split(&format!("Section {name}"))
            .nth(1)
            .expect("package section")
            .split("SectionEnd")
            .next()
            .unwrap()
    }

    #[test]
    fn retirement_and_running_app_preflight_precede_any_payload_deletion() {
        let uninstall = section("Uninstall");
        let check = uninstall
            .find("Call un.ForgePreflight")
            .expect("read-only app preflight");
        let retire = uninstall
            .find("Call un.ForgeLifecycle")
            .expect("generation retirement");
        let delete = uninstall.find("Delete ").expect("payload deletion");
        assert!(check < retire && retire < delete);
        let install = section("Install");
        assert!(install.find("Call ForgePreflight").unwrap() < install.find("File ").unwrap());
        assert!(install.find("File ").unwrap() < install.find("Call ForgeLifecycle").unwrap());
    }

    #[test]
    fn package_cannot_bypass_retirement_or_force_stop_the_operator() {
        for forbidden in [
            "CheckIfAppIsRunning",
            "RmShutdown",
            "RmRestart(",
            "ExecWait '$R1'",
            "PageReinstall",
            "MUI_PAGE_DIRECTORY",
            "DeleteAppDataCheckbox",
            "RmDir /r",
            "DeleteRegValue HKCU \"Software\\Microsoft\\Windows\\CurrentVersion\\Run\"",
        ] {
            assert!(
                !INSTALLER.contains(forbidden),
                "forbidden package bypass: {forbidden}"
            );
        }
        assert!(INSTALLER.contains("SHGetKnownFolderPath"));
        assert!(INSTALLER.contains("GetExitCodeProcess"));
        assert!(INSTALLER.contains("WaitForSingleObject"));
        assert!(
            INSTALLER.contains("0x00020002"),
            "explicit inherited HANDLE_LIST"
        );
        assert!(
            INSTALLER.contains("0x08080000"),
            "extended startup without a console"
        );
    }

    #[test]
    fn both_package_entries_retain_the_same_native_presence_guard() {
        assert!(INSTALLER.contains(super::PACKAGE_GUARD));
        for callback in [".onInit", "un.onInit"] {
            let body = INSTALLER
                .split(&format!("Function {callback}"))
                .nth(1)
                .unwrap()
                .split("FunctionEnd")
                .next()
                .unwrap();
            assert!(body.contains("!insertmacro ForgePackageInit"));
        }
        assert!(!INSTALLER.contains("ReleaseMutex"));
        assert!(!INSTALLER.contains("CloseHandle(p $ForgeGuard"));
    }

    #[test]
    fn unknown_package_state_and_target_directory_errors_cannot_copy_payload() {
        let install = section("Install");
        let clear = install.find("ClearErrors").unwrap();
        let target = install.find("SetOutPath $INSTDIR").unwrap();
        let error = install.find("${If} ${Errors}").unwrap();
        let copy = install.find("File ").unwrap();
        assert!(clear < target && target < error && error < copy);
        let init = INSTALLER
            .split("Function .onInit")
            .nth(1)
            .unwrap()
            .split("FunctionEnd")
            .next()
            .unwrap();
        let valid = init
            .find("SemverCompare $R0 invalid")
            .expect("strict installed version check");
        let compare = init.find("SemverCompare \"${VERSION}\" $R0").unwrap();
        assert!(valid < compare);
        assert!(init.contains("UninstallString"));
        assert!(init.contains("${FileExists}"));
    }
}
