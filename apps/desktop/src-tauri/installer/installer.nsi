Unicode true
ManifestDPIAware true
; Add in `dpiAwareness` `PerMonitorV2` to manifest for Windows 10 1607+ (note this should not affect lower versions since they should be able to ignore this and pick up `dpiAware` `true` set by `ManifestDPIAware true`)
; Currently undocumented on NSIS's website but is in the Docs folder of source tree, see
; https://github.com/kichik/nsis/blob/5fc0b87b819a9eec006df4967d08e522ddd651c9/Docs/src/attributes.but#L286-L300
; https://github.com/tauri-apps/tauri/pull/10106
ManifestDPIAwareness PerMonitorV2

!if "{{compression}}" == "none"
  SetCompress off
!else
  ; Set the compression algorithm. We default to LZMA.
  SetCompressor /SOLID "{{compression}}"
!endif

; Keep above !include to stay ahead of any plugin command
; see https://github.com/tauri-apps/tauri/pull/15422#discussion_r3289239624
{{#if signed_plugins_path}}
!addplugindir "{{signed_plugins_path}}"
{{/if}}

!include MUI2.nsh
!include FileFunc.nsh
!include x64.nsh
!include WordFunc.nsh
!include "utils.nsh"
!include "FileAssociation.nsh"
!include "Win\COM.nsh"
!include "Win\Propkey.nsh"
!include "Win\RestartManager.nsh"
!include "StrFunc.nsh"
${StrCase}
${StrLoc}

{{#if installer_hooks}}
!include "{{installer_hooks}}"
{{/if}}

!define WEBVIEW2APPGUID "{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}"

!define MANUFACTURER "{{manufacturer}}"
!define PRODUCTNAME "{{product_name}}"
!define VERSION "{{version}}"
!define VERSIONWITHBUILD "{{version_with_build}}"
!define HOMEPAGE "{{homepage}}"
!define INSTALLMODE "{{install_mode}}"
!define LICENSE "{{license}}"
!define INSTALLERICON "{{installer_icon}}"
!define SIDEBARIMAGE "{{sidebar_image}}"
!define HEADERIMAGE "{{header_image}}"
!define UNINSTALLERICON "{{uninstaller_icon}}"
!define UNINSTALLERHEADERIMAGE "{{uninstaller_header_image}}"
!define MAINBINARYNAME "{{main_binary_name}}"
!define MAINBINARYSRCPATH "{{main_binary_path}}"
!define BUNDLEID "{{bundle_id}}"
!define COPYRIGHT "{{copyright}}"
!define OUTFILE "{{out_file}}"
!define ARCH "{{arch}}"
!define ADDITIONALPLUGINSPATH "{{additional_plugins_path}}"
!define ALLOWDOWNGRADES "{{allow_downgrades}}"
!define DISPLAYLANGUAGESELECTOR "{{display_language_selector}}"
!define INSTALLWEBVIEW2MODE "{{install_webview2_mode}}"
!define WEBVIEW2INSTALLERARGS "{{webview2_installer_args}}"
!define WEBVIEW2BOOTSTRAPPERPATH "{{webview2_bootstrapper_path}}"
!define WEBVIEW2INSTALLERPATH "{{webview2_installer_path}}"
!define MINIMUMWEBVIEW2VERSION "{{minimum_webview2_version}}"
!define UNINSTKEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\${PRODUCTNAME}"
!define MANUKEY "Software\${MANUFACTURER}"
!define MANUPRODUCTKEY "${MANUKEY}\${PRODUCTNAME}"
!define UNINSTALLERSIGNCOMMAND "{{uninstaller_sign_cmd}}"
!define ESTIMATEDSIZE "{{estimated_size}}"
!define STARTMENUFOLDER "{{start_menu_folder}}"

Var PassiveMode
Var UpdateMode
Var NoShortcutMode
Var WixMode
Var OldMainBinaryName

; Agent Forge's lifecycle supports one current-user installation location.
!if "${INSTALLMODE}" != "currentUser"
  !error "Agent Forge requires currentUser installation"
!endif
!if "${PRODUCTNAME}" != "Agent Forge Harness"
  !error "Unexpected Agent Forge installation directory"
!endif
!if "${MAINBINARYNAME}" != "agent-forge-desktop"
  !error "Unexpected Agent Forge executable"
!endif
!define FORGE_PACKAGE_GUARD "Global\dev.agentforge.harness.package.v1"
Var ForgeGuard
Var ForgeFixedDir
Var ForgeVerb
Var ForgeNull
Var ForgeAttributes
Var ForgeAttributeInitialized
Var ForgeHandleList
Var ForgeStartup
Var ForgeProcessInfo
Var ForgeProcess
Var ForgeThread
Var ForgeStarted
Var ForgeFlagsReset
Var ForgeResetOK
Var ForgeResult

!macro ForgePackageInit
  ; The pinned NSIS stub is x86 even when its payload is x64 or ARM64.
  System::Call '*0(p, &l.r0)'
  ${If} $0 != 4
    SetErrorLevel 1
    Abort "Unsupported installer pointer layout. No files were changed."
  ${EndIf}
  System::Call 'kernel32::SetLastError(i 0)'
  System::Call 'kernel32::CreateMutexW(p 0, i 0, w "${FORGE_PACKAGE_GUARD}") p.r0 ?e'
  Pop $1
  StrCpy $ForgeGuard $0
  ${If} $ForgeGuard = 0
  ${OrIf} $1 != 0
    SetErrorLevel 1
    Abort "Another Agent Forge package operation is active or unavailable."
  ${EndIf}
  ; Retain this presence handle until process exit, including every failure path.
  StrCpy $0 0
  StrCpy $3 1
  System::Call 'shell32::SHGetKnownFolderPath(g "{F1B32785-6FBA-4FCF-9D55-7B8E7F157091}", i 0, p 0, *p .r0) i.r1'
  ${If} $1 = 0
  ${AndIf} $0 <> 0
    System::Call 'kernel32::lstrlenW(p r0) i.r1'
    IntOp $4 ${NSIS_MAX_STRLEN} - 160
    ${If} $1 > 0
    ${AndIf} $1 <= $4
      System::Call 'kernel32::lstrcpynW(w .r2, p r0, i ${NSIS_MAX_STRLEN}) p'
      StrCpy $ForgeFixedDir "$2\Agent Forge Harness"
      StrCpy $3 0
    ${EndIf}
  ${EndIf}
  System::Call 'ole32::CoTaskMemFree(p r0)'
  StrCpy $1 $ForgeFixedDir 2 1
  StrCpy $2 $ForgeFixedDir 3
  System::Call 'kernel32::GetDriveTypeW(w r2) i.r4'
  ${If} $3 != 0
  ${OrIf} $1 != ":\"
  ${OrIf} $4 != 3
    SetErrorLevel 1
    Abort "The current Windows user's local installation directory is unavailable."
  ${EndIf}
  ${If} $INSTDIR != "${PLACEHOLDER_INSTALL_DIR}"
  ${AndIf} $INSTDIR != $ForgeFixedDir
    SetErrorLevel 1
    Abort "Agent Forge must use its fixed current-user installation directory."
  ${EndIf}
  StrCpy $INSTDIR $ForgeFixedDir
  ReadRegStr $4 HKCU "${MANUPRODUCTKEY}" ""
  ${If} $4 != ""
  ${AndIf} $4 != $ForgeFixedDir
    SetErrorLevel 1
    Abort "A different Agent Forge installation location is registered. Preserve it."
  ${EndIf}
!macroend

!macro ForgePackageFunctions prefix
Function ${prefix}ForgePreflight
  ; One batch, read-only query. A running app or any uncertainty stops the package.
  System::Call 'rstrtmgr::RmStartSession(*i .r0, i 0, w .r1) i.r2'
  ${If} $2 != 0
    SetErrorLevel 1
    Abort "Unable to check running Agent Forge processes. Preserve the installation."
  ${EndIf}
  StrCpy $R0 $0
  System::Call '*(&w${NSIS_MAX_STRLEN} "$INSTDIR\${MAINBINARYNAME}.exe") p.r3'
  System::Call '*(&w${NSIS_MAX_STRLEN} "$INSTDIR\desktop-host.exe") p.r4'
  System::Call '*(&w${NSIS_MAX_STRLEN} "$INSTDIR\hearth.exe") p.r5'
  System::Call '*(p r3, p r4, p r5) p.r6'
  StrCpy $7 1
  StrCpy $1 0
  StrCpy $2 0
  StrCpy $8 0
  ${If} $3 <> 0
  ${AndIf} $4 <> 0
  ${AndIf} $5 <> 0
  ${AndIf} $6 <> 0
    System::Call 'rstrtmgr::RmRegisterResources(i R0, i 3, p r6, i 0, p 0, i 0, p 0) i.r7'
    ${If} $7 = 0
      System::Call 'rstrtmgr::RmGetList(i R0, *i r1 r1, *i r2 r2, p 0, *i r8 r8) i.r7'
    ${EndIf}
  ${EndIf}
  System::Free $6
  System::Free $5
  System::Free $4
  System::Free $3
  System::Call 'rstrtmgr::RmEndSession(i R0) i.r9'
  ${If} $7 != 0
  ${OrIf} $1 != 0
  ${OrIf} $2 != 0
  ${OrIf} $8 != 0
  ${OrIf} $9 != 0
    SetErrorLevel 1
    Abort "Close Agent Forge and its owned sessions before changing the installation."
  ${EndIf}
FunctionEnd

Function ${prefix}ForgeLifecycle
  StrCpy $ForgeResult 1
  StrCpy $ForgeNull 0
  StrCpy $ForgeAttributes 0
  StrCpy $ForgeAttributeInitialized 0
  StrCpy $ForgeHandleList 0
  StrCpy $ForgeStartup 0
  StrCpy $ForgeProcessInfo 0
  StrCpy $ForgeProcess 0
  StrCpy $ForgeThread 0
  StrCpy $ForgeStarted 0
  StrCpy $ForgeFlagsReset 0
  StrCpy $ForgeResetOK 0
  ${If} $ForgeVerb != "activate"
  ${AndIf} $ForgeVerb != "retire"
    Goto forge_cleanup
  ${EndIf}
  System::Call 'kernel32::CreateFileW(w "NUL", i 0x40000000, i 3, p 0, i 3, i 0x80, p 0) p.r0'
  ${If} $0 = 0
  ${OrIf} $0 = -1
    Goto forge_cleanup
  ${EndIf}
  StrCpy $ForgeNull $0
  System::Call 'kernel32::SetHandleInformation(p $ForgeGuard, i 1, i 1) i.r0'
  System::Call 'kernel32::SetHandleInformation(p $ForgeNull, i 1, i 1) i.r1'
  ${If} $0 = 0
  ${OrIf} $1 = 0
    Goto forge_cleanup
  ${EndIf}
  System::Call 'kernel32::InitializeProcThreadAttributeList(p 0, i 1, i 0, *p .r0) i.r1 ?e'
  Pop $2
  ${If} $1 != 0
  ${OrIf} $2 != 122
  ${OrIf} $0 <= 0
  ${OrIf} $0 > 65536
    Goto forge_cleanup
  ${EndIf}
  System::Alloc $0
  Pop $ForgeAttributes
  ${If} $ForgeAttributes = 0
    Goto forge_cleanup
  ${EndIf}
  System::Call 'kernel32::InitializeProcThreadAttributeList(p $ForgeAttributes, i 1, i 0, *p r0 r0) i.r1'
  ${If} $1 = 0
    Goto forge_cleanup
  ${EndIf}
  StrCpy $ForgeAttributeInitialized 1
  System::Call '*(p $ForgeGuard, p $ForgeNull) p.s'
  Pop $ForgeHandleList
  ${If} $ForgeHandleList = 0
    Goto forge_cleanup
  ${EndIf}
  System::Call 'kernel32::UpdateProcThreadAttribute(p $ForgeAttributes, i 0, p 0x00020002, p $ForgeHandleList, p 8, p 0, p 0) i.r0'
  ${If} $0 = 0
    Goto forge_cleanup
  ${EndIf}
  ; STARTUPINFOEXW x86: cb=72, three pointers, eight DWORDs, two WORDs,
  ; lpReserved2, three standard handles, then the attribute-list pointer.
  System::Call '*(&l4, p 0, p 0, p 0, i 0, i 0, i 0, i 0, i 0, i 0, i 0, i 0x100, h 0, h 0, p 0, p $ForgeGuard, p $ForgeNull, p $ForgeNull, p $ForgeAttributes) p.s'
  Pop $ForgeStartup
  System::Call '*(p 0, p 0, i 0, i 0) p.s'
  Pop $ForgeProcessInfo
  ${If} $ForgeStartup = 0
  ${OrIf} $ForgeProcessInfo = 0
    Goto forge_cleanup
  ${EndIf}
  System::Call '*$ForgeStartup(i .r0)'
  ${If} $0 != 72
    Goto forge_cleanup
  ${EndIf}
  System::Call 'kernel32::CreateProcessW(w "$INSTDIR\${MAINBINARYNAME}.exe", w "$\"$INSTDIR\${MAINBINARYNAME}.exe$\" --startup-lifecycle $ForgeVerb", p 0, p 0, i 1, i 0x08080000, p 0, w "$INSTDIR", p $ForgeStartup, p $ForgeProcessInfo) i.r0'
  StrCpy $ForgeStarted $0
  System::Call 'kernel32::SetHandleInformation(p $ForgeGuard, i 1, i 0) i.r1'
  System::Call 'kernel32::SetHandleInformation(p $ForgeNull, i 1, i 0) i.r2'
  IntOp $ForgeResetOK $1 & $2
  StrCpy $ForgeFlagsReset 1
  ${If} $ForgeStarted = 0
    Goto forge_cleanup
  ${EndIf}
  System::Call '*$ForgeProcessInfo(p .r0, p .r1)'
  StrCpy $ForgeProcess $0
  StrCpy $ForgeThread $1
  ${If} $ForgeProcess = 0
  ${OrIf} $ForgeThread = 0
    Goto forge_cleanup
  ${EndIf}
  System::Call 'kernel32::WaitForSingleObject(p $ForgeProcess, i 30000) i.r0'
  ${If} $0 = 0
    System::Call 'kernel32::GetExitCodeProcess(p $ForgeProcess, *i .r1) i.r0'
    ${If} $0 <> 0
    ${AndIf} $1 = 0
    ${AndIf} $ForgeResetOK <> 0
      StrCpy $ForgeResult 0
    ${EndIf}
  ${EndIf}
forge_cleanup:
  ${If} $ForgeFlagsReset = 0
    System::Call 'kernel32::SetHandleInformation(p $ForgeGuard, i 1, i 0)'
    ${If} $ForgeNull <> 0
      System::Call 'kernel32::SetHandleInformation(p $ForgeNull, i 1, i 0)'
    ${EndIf}
  ${EndIf}
  ${If} $ForgeThread <> 0
    System::Call 'kernel32::CloseHandle(p $ForgeThread)'
  ${EndIf}
  ${If} $ForgeProcess <> 0
    System::Call 'kernel32::CloseHandle(p $ForgeProcess)'
  ${EndIf}
  ${If} $ForgeNull <> 0
    System::Call 'kernel32::CloseHandle(p $ForgeNull)'
  ${EndIf}
  ${If} $ForgeAttributeInitialized = 1
    System::Call 'kernel32::DeleteProcThreadAttributeList(p $ForgeAttributes)'
  ${EndIf}
  System::Free $ForgeProcessInfo
  System::Free $ForgeStartup
  System::Free $ForgeHandleList
  System::Free $ForgeAttributes
  ${If} $ForgeResult != 0
    SetErrorLevel 1
    Abort "Startup lifecycle was not confirmed. Preserve the installation and original state; do not repeat an unknown operation."
  ${EndIf}
FunctionEnd
!macroend
!insertmacro ForgePackageFunctions ""
!insertmacro ForgePackageFunctions "un."

Name "${PRODUCTNAME}"
BrandingText "${COPYRIGHT}"
OutFile "${OUTFILE}"

; We don't actually use this value as default install path,
; it's just for nsis to append the product name folder in the directory selector
; https://nsis.sourceforge.io/Reference/InstallDir
!define PLACEHOLDER_INSTALL_DIR "placeholder\${PRODUCTNAME}"
InstallDir "${PLACEHOLDER_INSTALL_DIR}"

VIProductVersion "${VERSIONWITHBUILD}"
VIAddVersionKey "ProductName" "${PRODUCTNAME}"
VIAddVersionKey "FileDescription" "${PRODUCTNAME}"
VIAddVersionKey "LegalCopyright" "${COPYRIGHT}"
VIAddVersionKey "FileVersion" "${VERSION}"
VIAddVersionKey "ProductVersion" "${VERSION}"

# additional plugins
!addplugindir "${ADDITIONALPLUGINSPATH}"

; Uninstaller signing command
!if "${UNINSTALLERSIGNCOMMAND}" != ""
  !uninstfinalize '${UNINSTALLERSIGNCOMMAND}'
!endif

; Handle install mode, `perUser`, `perMachine` or `both`
!if "${INSTALLMODE}" == "perMachine"
  RequestExecutionLevel admin
!endif

!if "${INSTALLMODE}" == "currentUser"
  RequestExecutionLevel user
!endif

!if "${INSTALLMODE}" == "both"
  !define MULTIUSER_MUI
  !define MULTIUSER_INSTALLMODE_INSTDIR "${PRODUCTNAME}"
  !define MULTIUSER_INSTALLMODE_COMMANDLINE
  !if "${ARCH}" == "x64"
    !define MULTIUSER_USE_PROGRAMFILES64
  !else if "${ARCH}" == "arm64"
    !define MULTIUSER_USE_PROGRAMFILES64
  !endif
  !define MULTIUSER_INSTALLMODE_DEFAULT_REGISTRY_KEY "${UNINSTKEY}"
  !define MULTIUSER_INSTALLMODE_DEFAULT_REGISTRY_VALUENAME "CurrentUser"
  !define MULTIUSER_INSTALLMODEPAGE_SHOWUSERNAME
  !define MULTIUSER_INSTALLMODE_FUNCTION RestorePreviousInstallLocation
  !define MULTIUSER_EXECUTIONLEVEL Highest
  !include MultiUser.nsh
!endif

; Installer icon
!if "${INSTALLERICON}" != ""
  !define MUI_ICON "${INSTALLERICON}"
!endif

; Installer sidebar image
!if "${SIDEBARIMAGE}" != ""
  !define MUI_WELCOMEFINISHPAGE_BITMAP "${SIDEBARIMAGE}"
!endif

; Enable header images for installer and uninstaller pages when either image is configured.
!if "${HEADERIMAGE}" != ""
  !define MUI_HEADERIMAGE
!else if "${UNINSTALLERHEADERIMAGE}" != ""
  !define MUI_HEADERIMAGE
!endif

; Installer header image
!if "${HEADERIMAGE}" != ""
  !define MUI_HEADERIMAGE_BITMAP "${HEADERIMAGE}"
!endif

; Uninstaller header image
!if "${UNINSTALLERHEADERIMAGE}" != ""
  !define MUI_HEADERIMAGE_UNBITMAP "${UNINSTALLERHEADERIMAGE}"
!endif

; Uninstaller icon
!if "${UNINSTALLERICON}" != ""
  !define MUI_UNICON "${UNINSTALLERICON}"
!endif

; Define registry key to store installer language
!define MUI_LANGDLL_REGISTRY_ROOT "HKCU"
!define MUI_LANGDLL_REGISTRY_KEY "${MANUPRODUCTKEY}"
!define MUI_LANGDLL_REGISTRY_VALUENAME "Installer Language"

; Installer pages, must be ordered as they appear
; 1. Welcome Page
!define MUI_PAGE_CUSTOMFUNCTION_PRE SkipIfPassive
!insertmacro MUI_PAGE_WELCOME

; 2. License Page (if defined)
!if "${LICENSE}" != ""
  !define MUI_PAGE_CUSTOMFUNCTION_PRE SkipIfPassive
  !insertmacro MUI_PAGE_LICENSE "${LICENSE}"
!endif

; 3. Install mode (if it is set to `both`)
!if "${INSTALLMODE}" == "both"
  !define MUI_PAGE_CUSTOMFUNCTION_PRE SkipIfPassive
  !insertmacro MULTIUSER_PAGE_INSTALLMODE
!endif

; Fixed-location in-place updates have no nested uninstaller or directory selector.

; 6. Start menu shortcut page
Var AppStartMenuFolder
!if "${STARTMENUFOLDER}" != ""
  !define MUI_PAGE_CUSTOMFUNCTION_PRE SkipIfPassive
  !define MUI_STARTMENUPAGE_DEFAULTFOLDER "${STARTMENUFOLDER}"
!else
  !define MUI_PAGE_CUSTOMFUNCTION_PRE Skip
!endif
!insertmacro MUI_PAGE_STARTMENU Application $AppStartMenuFolder

; 7. Installation page
!insertmacro MUI_PAGE_INSTFILES

; 8. Finish page
;
; Don't auto jump to finish page after installation page,
; because the installation page has useful info that can be used debug any issues with the installer.
!define MUI_FINISHPAGE_NOAUTOCLOSE
; Use show readme button in the finish page as a button create a desktop shortcut
!define MUI_FINISHPAGE_SHOWREADME
!define MUI_FINISHPAGE_SHOWREADME_TEXT "$(createDesktop)"
!define MUI_FINISHPAGE_SHOWREADME_FUNCTION CreateOrUpdateDesktopShortcut
; Show run app after installation.
!define MUI_FINISHPAGE_RUN
!define MUI_FINISHPAGE_RUN_FUNCTION RunMainBinary
!define MUI_PAGE_CUSTOMFUNCTION_PRE SkipIfPassive
!insertmacro MUI_PAGE_FINISH

Function RunMainBinary
  nsis_tauri_utils::RunAsUser "$INSTDIR\${MAINBINARYNAME}.exe" ""
FunctionEnd

; Uninstaller Pages
; 1. Confirm uninstall page
!define MUI_PAGE_CUSTOMFUNCTION_PRE un.SkipIfPassive
!insertmacro MUI_UNPAGE_CONFIRM

; 2. Uninstalling Page
!insertmacro MUI_UNPAGE_INSTFILES

;Languages
{{#each languages}}
!insertmacro MUI_LANGUAGE "{{this}}"
{{/each}}
!insertmacro MUI_RESERVEFILE_LANGDLL
{{#each language_files}}
  !include "{{this}}"
{{/each}}

Function .onInit
  !insertmacro SetContext
  !insertmacro ForgePackageInit
  StrCpy $WixMode 0
  ${GetOptions} $CMDLINE "/P" $PassiveMode
  ${IfNot} ${Errors}
    StrCpy $PassiveMode 1
  ${EndIf}
  ${GetOptions} $CMDLINE "/NS" $NoShortcutMode
  ${IfNot} ${Errors}
    StrCpy $NoShortcutMode 1
  ${EndIf}
  ${GetOptions} $CMDLINE "/UPDATE" $UpdateMode
  ${IfNot} ${Errors}
    StrCpy $UpdateMode 1
  ${EndIf}
  SetRegView 32
  Call ForgeRefuseMachineInstall
  SetRegView 64
  Call ForgeRefuseMachineInstall
  ReadRegStr $R0 HKCU "${UNINSTKEY}" "DisplayVersion"
  ReadRegStr $R2 HKCU "${UNINSTKEY}" "UninstallString"
  ${If} $R0 == ""
    ${If} $R2 != ""
    ${OrIf} ${FileExists} "$INSTDIR\${MAINBINARYNAME}.exe"
      SetErrorLevel 1
      Abort "The installed version is unknown. Preserve the installation."
    ${EndIf}
  ${Else}
    ; Pinned plugin0.5.3 orders valid versions above an invalid sentinel.
    ; Comparing the incoming version alone would accept malformed old metadata.
    nsis_tauri_utils::SemverCompare $R0 invalid
    Pop $R1
    ${If} $R1 != 1
      SetErrorLevel 1
      Abort "The installed version is malformed. Preserve the installation."
    ${EndIf}
    nsis_tauri_utils::SemverCompare "${VERSION}" $R0
    Pop $R1
    ${If} $R1 != 0
    ${AndIf} $R1 != 1
      SetErrorLevel 1
      Abort "Downgrades or unrecognized installed versions are not supported."
    ${EndIf}
  ${EndIf}
FunctionEnd

Function ForgeRefuseMachineInstall
  StrCpy $0 0
forge_machine_loop:
  EnumRegKey $1 HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall" $0
  StrCmp $1 "" forge_machine_done
  IntOp $0 $0 + 1
  ReadRegStr $R0 HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\$1" "DisplayName"
  ReadRegStr $R1 HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\$1" "Publisher"
  ${If} $R0 == "${PRODUCTNAME}"
  ${AndIf} $R1 == "${MANUFACTURER}"
    SetErrorLevel 1
    Abort "A machine-wide installation is registered. Automatic migration is not supported."
  ${EndIf}
  Goto forge_machine_loop
forge_machine_done:
FunctionEnd

Section WebView2
  ; Check if Webview2 is already installed and skip this section
  ${If} ${RunningX64}
    ReadRegStr $4 HKLM "SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\${WEBVIEW2APPGUID}" "pv"
  ${Else}
    ReadRegStr $4 HKLM "SOFTWARE\Microsoft\EdgeUpdate\Clients\${WEBVIEW2APPGUID}" "pv"
  ${EndIf}
  ${If} $4 == ""
    ReadRegStr $4 HKCU "SOFTWARE\Microsoft\EdgeUpdate\Clients\${WEBVIEW2APPGUID}" "pv"
  ${EndIf}

  ${If} $4 == ""
    ; Webview2 installation
    ;
    ; Skip if updating
    ${If} $UpdateMode <> 1
      !if "${INSTALLWEBVIEW2MODE}" == "downloadBootstrapper"
        Delete "$TEMP\MicrosoftEdgeWebview2Setup.exe"
        DetailPrint "$(webview2Downloading)"
        NSISdl::download "https://go.microsoft.com/fwlink/p/?LinkId=2124703" "$TEMP\MicrosoftEdgeWebview2Setup.exe"
        Pop $0
        ${If} $0 == "success"
          DetailPrint "$(webview2DownloadSuccess)"
        ${Else}
          DetailPrint "$(webview2DownloadError)"
          Abort "$(webview2AbortError)"
        ${EndIf}
        StrCpy $6 "$TEMP\MicrosoftEdgeWebview2Setup.exe"
        Goto install_webview2
      !endif

      !if "${INSTALLWEBVIEW2MODE}" == "embedBootstrapper"
        Delete "$TEMP\MicrosoftEdgeWebview2Setup.exe"
        File "/oname=$TEMP\MicrosoftEdgeWebview2Setup.exe" "${WEBVIEW2BOOTSTRAPPERPATH}"
        DetailPrint "$(installingWebview2)"
        StrCpy $6 "$TEMP\MicrosoftEdgeWebview2Setup.exe"
        Goto install_webview2
      !endif

      !if "${INSTALLWEBVIEW2MODE}" == "offlineInstaller"
        Delete "$TEMP\MicrosoftEdgeWebView2RuntimeInstaller.exe"
        File "/oname=$TEMP\MicrosoftEdgeWebView2RuntimeInstaller.exe" "${WEBVIEW2INSTALLERPATH}"
        DetailPrint "$(installingWebview2)"
        StrCpy $6 "$TEMP\MicrosoftEdgeWebView2RuntimeInstaller.exe"
        Goto install_webview2
      !endif

      Goto webview2_done

      install_webview2:
        DetailPrint "$(installingWebview2)"
        ; $6 holds the path to the webview2 installer
        ExecWait "$6 ${WEBVIEW2INSTALLERARGS} /install" $1
        ${If} $1 = 0
          DetailPrint "$(webview2InstallSuccess)"
        ${Else}
          DetailPrint "$(webview2InstallError)"
          Abort "$(webview2AbortError)"
        ${EndIf}
      webview2_done:
    ${EndIf}
  ${Else}
    !if "${MINIMUMWEBVIEW2VERSION}" != ""
      ${VersionCompare} "${MINIMUMWEBVIEW2VERSION}" "$4" $R0
      ${If} $R0 = 1
        update_webview:
          DetailPrint "$(installingWebview2)"
          ${If} ${RunningX64}
            ReadRegStr $R1 HKLM "SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate" "path"
          ${Else}
            ReadRegStr $R1 HKLM "SOFTWARE\Microsoft\EdgeUpdate" "path"
          ${EndIf}
          ${If} $R1 == ""
            ReadRegStr $R1 HKCU "SOFTWARE\Microsoft\EdgeUpdate" "path"
          ${EndIf}
          ${If} $R1 != ""
            ; Chromium updater docs: https://source.chromium.org/chromium/chromium/src/+/main:docs/updater/user_manual.md
            ; Modified from "HKEY_LOCAL_MACHINE\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\Microsoft EdgeWebView\ModifyPath"
            ExecWait `"$R1" /install appguid=${WEBVIEW2APPGUID}&needsadmin=true` $1
            ${If} $1 = 0
              DetailPrint "$(webview2InstallSuccess)"
            ${Else}
              MessageBox MB_ICONEXCLAMATION|MB_ABORTRETRYIGNORE "$(webview2InstallError)" IDIGNORE ignore IDRETRY update_webview
              Quit
              ignore:
            ${EndIf}
          ${EndIf}
      ${EndIf}
    !endif
  ${EndIf}
SectionEnd

Section Install
  Call ForgePreflight
  ClearErrors
  SetOutPath $INSTDIR
  ${If} ${Errors}
    SetErrorLevel 1
    Abort "Cannot open the installation directory. Preserve the installation."
  ${EndIf}

  !ifmacrodef NSIS_HOOK_PREINSTALL
    !insertmacro NSIS_HOOK_PREINSTALL
  !endif


  ; Copy main executable
  File "${MAINBINARYSRCPATH}"

  ; Copy resources
  {{#each resources_dirs}}
    CreateDirectory "$INSTDIR\\{{this}}"
  {{/each}}
  {{#each resources}}
    File /a "/oname={{this.[1]}}" "{{no-escape @key}}"
  {{/each}}

  ; Copy external binaries
  {{#each binaries}}
    File /a "/oname={{this}}" "{{no-escape @key}}"
  {{/each}}

  ${If} ${Errors}
    SetErrorLevel 1
    Abort "The payload could not be copied completely. Startup activation was not attempted."
  ${EndIf}
  StrCpy $ForgeVerb "activate"
  Call ForgeLifecycle

  ; Create file associations
  {{#each file_associations as |association| ~}}
    {{#each association.ext as |ext| ~}}
       !insertmacro APP_ASSOCIATE "{{ext}}" "{{or association.name ext}}" "{{association-description association.description ext}}" "$INSTDIR\${MAINBINARYNAME}.exe,0" "Open with ${PRODUCTNAME}" "$INSTDIR\${MAINBINARYNAME}.exe $\"%1$\""
    {{/each}}
  {{/each}}

  ; Register deep links
  {{#each deep_link_protocols as |protocol| ~}}
    WriteRegStr SHCTX "Software\Classes\\{{protocol}}" "URL Protocol" ""
    WriteRegStr SHCTX "Software\Classes\\{{protocol}}" "" "URL:${BUNDLEID} protocol"
    WriteRegStr SHCTX "Software\Classes\\{{protocol}}\DefaultIcon" "" "$\"$INSTDIR\${MAINBINARYNAME}.exe$\",0"
    WriteRegStr SHCTX "Software\Classes\\{{protocol}}\shell\open\command" "" "$\"$INSTDIR\${MAINBINARYNAME}.exe$\" $\"%1$\""
  {{/each}}

  ; Create uninstaller
  WriteUninstaller "$INSTDIR\uninstall.exe"

  ; Save $INSTDIR in registry for future installations
  WriteRegStr SHCTX "${MANUPRODUCTKEY}" "" $INSTDIR

  !if "${INSTALLMODE}" == "both"
    ; Save install mode to be selected by default for the next installation such as updating
    ; or when uninstalling
    WriteRegStr SHCTX "${UNINSTKEY}" $MultiUser.InstallMode 1
  !endif

  ; Preserve obsolete payload files; registry text never authorizes their deletion.
  ReadRegStr $OldMainBinaryName HKCU "${UNINSTKEY}" "MainBinaryName"

  ; Save current MAINBINARYNAME for future updates
  WriteRegStr SHCTX "${UNINSTKEY}" "MainBinaryName" "${MAINBINARYNAME}.exe"

  ; Registry information for add/remove programs
  WriteRegStr SHCTX "${UNINSTKEY}" "DisplayName" "${PRODUCTNAME}"
  WriteRegStr SHCTX "${UNINSTKEY}" "DisplayIcon" "$\"$INSTDIR\${MAINBINARYNAME}.exe$\""
  WriteRegStr SHCTX "${UNINSTKEY}" "DisplayVersion" "${VERSION}"
  WriteRegStr SHCTX "${UNINSTKEY}" "Publisher" "${MANUFACTURER}"
  WriteRegStr SHCTX "${UNINSTKEY}" "InstallLocation" "$\"$INSTDIR$\""
  WriteRegStr SHCTX "${UNINSTKEY}" "UninstallString" "$\"$INSTDIR\uninstall.exe$\""
  WriteRegDWORD SHCTX "${UNINSTKEY}" "NoModify" "1"
  WriteRegDWORD SHCTX "${UNINSTKEY}" "NoRepair" "1"

  ${GetSize} "$INSTDIR" "/M=uninstall.exe /S=0K /G=0" $0 $1 $2
  IntOp $0 $0 + ${ESTIMATEDSIZE}
  IntFmt $0 "0x%08X" $0
  WriteRegDWORD SHCTX "${UNINSTKEY}" "EstimatedSize" "$0"

  !if "${HOMEPAGE}" != ""
    WriteRegStr SHCTX "${UNINSTKEY}" "URLInfoAbout" "${HOMEPAGE}"
    WriteRegStr SHCTX "${UNINSTKEY}" "URLUpdateInfo" "${HOMEPAGE}"
    WriteRegStr SHCTX "${UNINSTKEY}" "HelpLink" "${HOMEPAGE}"
  !endif

  ; Create start menu shortcut
  !insertmacro MUI_STARTMENU_WRITE_BEGIN Application
    Call CreateOrUpdateStartMenuShortcut
  !insertmacro MUI_STARTMENU_WRITE_END

  ; Create desktop shortcut for silent and passive installers
  ; because finish page will be skipped
  ${If} $PassiveMode = 1
  ${OrIf} ${Silent}
    Call CreateOrUpdateDesktopShortcut
  ${EndIf}

  !ifmacrodef NSIS_HOOK_POSTINSTALL
    !insertmacro NSIS_HOOK_POSTINSTALL
  !endif

  ; Auto close this page for passive mode
  ${If} $PassiveMode = 1
    SetAutoClose true
  ${EndIf}
SectionEnd

Function .onInstSuccess
  ; Check for `/R` flag only in silent and passive installers because
  ; GUI installer has a toggle for the user to (re)start the app
  ${If} $PassiveMode = 1
  ${OrIf} ${Silent}
    ${GetOptions} $CMDLINE "/R" $R0
    ${IfNot} ${Errors}
      ${GetOptions} $CMDLINE "/ARGS" $R0
      nsis_tauri_utils::RunAsUser "$INSTDIR\${MAINBINARYNAME}.exe" "$R0"
    ${EndIf}
  ${EndIf}
FunctionEnd

Function un.onInit
  !insertmacro SetContext
  !insertmacro ForgePackageInit

  !if "${INSTALLMODE}" == "both"
    !insertmacro MULTIUSER_UNINIT
  !endif

  !insertmacro MUI_UNGETLANGUAGE

  ${GetOptions} $CMDLINE "/P" $PassiveMode
  ${IfNot} ${Errors}
    StrCpy $PassiveMode 1
  ${EndIf}

  ${GetOptions} $CMDLINE "/UPDATE" $UpdateMode
  ${IfNot} ${Errors}
    StrCpy $UpdateMode 1
  ${EndIf}
FunctionEnd

Section Uninstall
  Call un.ForgePreflight

  !ifmacrodef NSIS_HOOK_PREUNINSTALL
    !insertmacro NSIS_HOOK_PREUNINSTALL
  !endif

  StrCpy $ForgeVerb "retire"
  Call un.ForgeLifecycle

  ; Delete the app directory and its content from disk
  ; Copy main executable
  Delete "$INSTDIR\${MAINBINARYNAME}.exe"

  ; Delete resources
  {{#each resources}}
    Delete "$INSTDIR\\{{this.[1]}}"
  {{/each}}

  ; Delete external binaries
  {{#each binaries}}
    Delete "$INSTDIR\\{{this}}"
  {{/each}}

  ; Delete app associations
  {{#each file_associations as |association| ~}}
    {{#each association.ext as |ext| ~}}
      !insertmacro APP_UNASSOCIATE "{{ext}}" "{{or association.name ext}}"
    {{/each}}
  {{/each}}

  ; Delete deep links
  {{#each deep_link_protocols as |protocol| ~}}
    ReadRegStr $R7 SHCTX "Software\Classes\\{{protocol}}\shell\open\command" ""
    ${If} $R7 == "$\"$INSTDIR\${MAINBINARYNAME}.exe$\" $\"%1$\""
      DeleteRegKey SHCTX "Software\Classes\\{{protocol}}"
    ${EndIf}
  {{/each}}


  ; Delete uninstaller
  Delete "$INSTDIR\uninstall.exe"

  {{#each resources_ancestors}}
  RMDir "$INSTDIR\\{{this}}"
  {{/each}}
  RMDir "$INSTDIR"

  ; Remove shortcuts if not updating
  ${If} $UpdateMode <> 1
    !insertmacro DeleteAppUserModelId

    ; Remove start menu shortcut
    !insertmacro MUI_STARTMENU_GETFOLDER Application $AppStartMenuFolder
    !insertmacro IsShortcutTarget "$SMPROGRAMS\$AppStartMenuFolder\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
    Pop $0
    ${If} $0 = 1
      !insertmacro UnpinShortcut "$SMPROGRAMS\$AppStartMenuFolder\${PRODUCTNAME}.lnk"
      Delete "$SMPROGRAMS\$AppStartMenuFolder\${PRODUCTNAME}.lnk"
      RMDir "$SMPROGRAMS\$AppStartMenuFolder"
    ${EndIf}
    !insertmacro IsShortcutTarget "$SMPROGRAMS\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
    Pop $0
    ${If} $0 = 1
      !insertmacro UnpinShortcut "$SMPROGRAMS\${PRODUCTNAME}.lnk"
      Delete "$SMPROGRAMS\${PRODUCTNAME}.lnk"
    ${EndIf}

    ; Remove desktop shortcuts
    !insertmacro IsShortcutTarget "$DESKTOP\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
    Pop $0
    ${If} $0 = 1
      !insertmacro UnpinShortcut "$DESKTOP\${PRODUCTNAME}.lnk"
      Delete "$DESKTOP\${PRODUCTNAME}.lnk"
    ${EndIf}
  ${EndIf}

  ; Remove registry information for add/remove programs
  !if "${INSTALLMODE}" == "both"
    DeleteRegKey SHCTX "${UNINSTKEY}"
  !else if "${INSTALLMODE}" == "perMachine"
    DeleteRegKey HKLM "${UNINSTKEY}"
  !else
    DeleteRegKey HKCU "${UNINSTKEY}"
  !endif

  ; Keep startup receipts and all profile data. Only native retirement removes
  ; the exact generation-owned Run value.

  !ifmacrodef NSIS_HOOK_POSTUNINSTALL
    !insertmacro NSIS_HOOK_POSTUNINSTALL
  !endif

  ; Auto close if passive mode or updating
  ${If} $PassiveMode = 1
  ${OrIf} $UpdateMode = 1
    SetAutoClose true
  ${EndIf}
SectionEnd

Function Skip
  Abort
FunctionEnd

Function SkipIfPassive
  ${IfThen} $PassiveMode = 1  ${|} Abort ${|}
FunctionEnd
Function un.SkipIfPassive
  ${IfThen} $PassiveMode = 1  ${|} Abort ${|}
FunctionEnd

Function CreateOrUpdateStartMenuShortcut
  ; We used to use product name as MAINBINARYNAME
  ; migrate old shortcuts to target the new MAINBINARYNAME
  StrCpy $R0 0

  !insertmacro IsShortcutTarget "$SMPROGRAMS\$AppStartMenuFolder\${PRODUCTNAME}.lnk" "$INSTDIR\$OldMainBinaryName"
  Pop $0
  ${If} $0 = 1
    !insertmacro SetShortcutTarget "$SMPROGRAMS\$AppStartMenuFolder\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
    StrCpy $R0 1
  ${EndIf}

  !insertmacro IsShortcutTarget "$SMPROGRAMS\${PRODUCTNAME}.lnk" "$INSTDIR\$OldMainBinaryName"
  Pop $0
  ${If} $0 = 1
    !insertmacro SetShortcutTarget "$SMPROGRAMS\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
    StrCpy $R0 1
  ${EndIf}

  ${If} $R0 = 1
    Return
  ${EndIf}

  ; Skip creating shortcut if in update mode or no shortcut mode
  ; but always create if migrating from wix
  ${If} $WixMode = 0
    ${If} $UpdateMode = 1
    ${OrIf} $NoShortcutMode = 1
      Return
    ${EndIf}
  ${EndIf}

  !if "${STARTMENUFOLDER}" != ""
    CreateDirectory "$SMPROGRAMS\$AppStartMenuFolder"
    CreateShortcut "$SMPROGRAMS\$AppStartMenuFolder\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
    !insertmacro SetLnkAppUserModelId "$SMPROGRAMS\$AppStartMenuFolder\${PRODUCTNAME}.lnk"
  !else
    CreateShortcut "$SMPROGRAMS\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
    !insertmacro SetLnkAppUserModelId "$SMPROGRAMS\${PRODUCTNAME}.lnk"
  !endif
FunctionEnd

Function CreateOrUpdateDesktopShortcut
  ; We used to use product name as MAINBINARYNAME
  ; migrate old shortcuts to target the new MAINBINARYNAME
  !insertmacro IsShortcutTarget "$DESKTOP\${PRODUCTNAME}.lnk" "$INSTDIR\$OldMainBinaryName"
  Pop $0
  ${If} $0 = 1
    !insertmacro SetShortcutTarget "$DESKTOP\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
    Return
  ${EndIf}

  ; Skip creating shortcut if in update mode or no shortcut mode
  ; but always create if migrating from wix
  ${If} $WixMode = 0
    ${If} $UpdateMode = 1
    ${OrIf} $NoShortcutMode = 1
      Return
    ${EndIf}
  ${EndIf}

  CreateShortcut "$DESKTOP\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
  !insertmacro SetLnkAppUserModelId "$DESKTOP\${PRODUCTNAME}.lnk"
FunctionEnd
