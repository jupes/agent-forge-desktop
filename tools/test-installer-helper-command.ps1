param(
  [Parameter(Mandatory)][string]$NsisRoot,
  [string]$RustCompiler='rustc'
)
$ErrorActionPreference='Stop'
if(!$IsWindows -or !$env:RUNNER_TEMP) { throw 'The helper-command test needs a private Windows runner scratch directory.' }
$compiler=Join-Path $NsisRoot 'Bin/makensis.exe'
$plugin=Join-Path $NsisRoot 'Plugins/x86-unicode/System.dll'
if((Get-FileHash -LiteralPath $compiler).Hash -ne '65343c225ec88393cc4453b0963caf63f763f42f48cb55736d51893ff2e29d4a' -or
   (Get-FileHash -LiteralPath $plugin).Hash -ne 'afe032f942e2ed0bf7494ec08ba813f5739fb522c640bde81d30ecaf9f894432') {
  throw 'Unexpected NSIS 3.13 compiler or x86 Unicode System plug-in.'
}
$template=Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot '../apps/desktop/src-tauri/installer/installer.nsi')
$functions=[regex]::Matches($template,'(?ms)^Function \$\{prefix\}ForgeLifecycle\r?\n.*?^FunctionEnd\r?$')
if($functions.Count -ne 1) { throw 'Expected one production helper function.' }
$function=$functions[0].Value.Replace('${prefix}','')
$variables=([regex]::Matches($template,'(?m)^Var Forge[A-Za-z]+\r?$').Value -join [Environment]::NewLine)
$scratchRoot=(Get-Item -LiteralPath $env:RUNNER_TEMP).FullName
$nonce=[guid]::NewGuid().ToString('N')
$scratch=Join-Path $scratchRoot ("forge helper "+$nonce)
if(Test-Path -LiteralPath $scratch) { throw 'Fixture directory already present.' }
$null=New-Item -ItemType Directory -Path $scratch
$bothHelpersConfirmed=$false

function Invoke-ProbeProcess([string]$Executable,[string[]]$Arguments,[int]$DeadlineMs) {
  $start=[Diagnostics.ProcessStartInfo]::new($Executable)
  $start.UseShellExecute=$false
  $start.CreateNoWindow=$true
  $start.WindowStyle='Hidden'
  $start.WorkingDirectory=$scratch
  $start.Environment.Clear()
  foreach($key in 'SystemRoot','WINDIR','PATH','ComSpec','SystemDrive','ProgramFiles','ProgramFiles(x86)','ProgramData','USERPROFILE','LOCALAPPDATA','APPDATA','LIB','LIBPATH','INCLUDE','CARGO_HOME','RUSTUP_HOME','RUSTUP_TOOLCHAIN','VCToolsInstallDir','WindowsSdkDir','WindowsSDKVersion') {
    $value=[Environment]::GetEnvironmentVariable($key)
    if($value) { $start.Environment[$key]=$value }
  }
  $start.Environment['TEMP']=$scratch
  $start.Environment['TMP']=$scratch
  $start.Environment['NSISDIR']=(Get-Item -LiteralPath $NsisRoot).FullName
  foreach($arg in $Arguments) { $start.ArgumentList.Add($arg) }
  $process=[Diagnostics.Process]::Start($start)
  try {
    if(!$process.WaitForExit($DeadlineMs)) {
      throw 'Fixture process did not settle within its deadline.'
    }
    if($process.ExitCode -ne 0) { throw 'Fixture process returned an unsuccessful result.' }
  } finally { $process.Dispose() }
}

try {
  # Match the installed helper's release subsystem and register decoding. The
  # only side effect of the child is a fixed witness next to its own binary.
  $childSource=@'
#![windows_subsystem = "windows"]
use std::{env, ffi::{c_void, OsStr}, fs};
type Handle = *mut c_void;
#[link(name="kernel32")]
unsafe extern "system" {
    fn GetStdHandle(which: u32) -> Handle;
    fn GetHandleInformation(handle: Handle, flags: *mut u32) -> i32;
    fn OpenMutexW(access: u32, inherit: i32, name: *const u16) -> Handle;
    fn SetHandleInformation(handle: Handle, mask: u32, flags: u32) -> i32;
    fn CloseHandle(handle: Handle) -> i32;
    fn GetModuleHandleW(name: *const u16) -> Handle;
    fn GetProcAddress(module: Handle, name: *const u8) -> Handle;
}
fn wide(text: &str) -> Vec<u16> { text.encode_utf16().chain(Some(0)).collect() }
fn main() {
    let exe = env::current_exe().unwrap();
    let dir = exe.parent().unwrap();
    let verb = dir.file_name().unwrap();
    assert!(verb == OsStr::new("activate") || verb == OsStr::new("retire"));
    let args: Vec<_> = env::args_os().skip(1).collect();
    assert!(args.len() == 2 && args[0] == OsStr::new("--startup-lifecycle") && args[1] == verb);
    unsafe {
        let input = GetStdHandle((-10i32) as u32);
        let mut flags = 0;
        assert!(GetHandleInformation(input, &mut flags) != 0 && flags & 1 != 0);
        let named = OpenMutexW(0x00100000, 0, wide(include_str!("mutex.txt")).as_ptr());
        assert!(!named.is_null());
        let module = GetModuleHandleW(wide("kernelbase.dll").as_ptr());
        let address = GetProcAddress(module, b"CompareObjectHandles\0".as_ptr());
        assert!(!address.is_null());
        let compare: unsafe extern "system" fn(Handle, Handle) -> i32 = std::mem::transmute(address);
        assert!(compare(input, named) != 0);
        assert!(CloseHandle(named) != 0 && SetHandleInformation(input, 1, 0) != 0);
    }
    fs::write(dir.join("confirmed"), b"exact argv and owned stdin").unwrap();
}
'@
  $name='Local\forge-inert-'+$nonce
  [IO.File]::WriteAllText((Join-Path $scratch 'mutex.txt'),$name)
  $rust=Join-Path $scratch 'child.rs'
  [IO.File]::WriteAllText($rust,$childSource)
  $child=Join-Path $scratch 'probe-child.exe'
  $rustc=(Get-Command $RustCompiler -CommandType Application -ErrorAction Stop).Source
  Invoke-ProbeProcess $rustc @('--edition=2021','-C','opt-level=2','-C','debug-assertions=no',$rust,'-o',$child) 60000

  $header=@'
Unicode true
SilentInstall silent
AutoCloseWindow true
RequestExecutionLevel user
Name "Helper command fixture"
OutFile "probe-VERB.exe"
!include "LogicLib.nsh"
!define MAINBINARYNAME "probe-child"
'@
  $section=@'
Section
  System::Call 'kernel32::CreateMutexW(p 0, i 0, w "FIXTURE_MUTEX") p.r0'
  StrCpy $ForgeGuard $0
  ${If} $ForgeGuard = 0
    SetErrorLevel 1
    Abort
  ${EndIf}
  StrCpy $INSTDIR "$EXEDIR\VERB"
  StrCpy $ForgeVerb "VERB"
  Call ForgeLifecycle
  SetErrorLevel 0
SectionEnd
'@
  foreach($verb in 'activate','retire') {
    $dir=Join-Path $scratch $verb
    $null=New-Item -ItemType Directory -Path $dir
    Copy-Item -LiteralPath $child -Destination $dir
    $script=($header.Replace('VERB',$verb),$variables,$function,$section.Replace('FIXTURE_MUTEX',$name).Replace('VERB',$verb)) -join [Environment]::NewLine
    $inputPath=Join-Path $scratch ($verb+'.nsi')
    [IO.File]::WriteAllText($inputPath,$script)
    Invoke-ProbeProcess $compiler @('/NOCONFIG','/V2',$inputPath) 20000
    Invoke-ProbeProcess (Join-Path $scratch ("probe-"+$verb+".exe")) @('/S') 35000
    if([IO.File]::ReadAllText((Join-Path $dir 'confirmed')) -cne 'exact argv and owned stdin') {
      throw 'Inert helper did not confirm its verb and inherited object.'
    }
    Write-Output ("Verified inert installer helper command: "+$verb)
  }
  $bothHelpersConfirmed=$true
} finally {
  $actual=Get-Item -LiteralPath $scratch -Force
  if($bothHelpersConfirmed -and $actual.Parent.FullName -ceq $scratchRoot -and $actual.Name -ceq ("forge helper "+$nonce) -and
     !($actual.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
    Remove-Item -LiteralPath $actual.FullName -Recurse -Force
  }
}
