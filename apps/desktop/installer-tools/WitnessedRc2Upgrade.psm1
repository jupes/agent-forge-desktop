#requires -Version 7.4
# The witness is deliberately session-scoped. Closing the session releases its handles.
$ErrorActionPreference = 'Stop'
$rc2SetupHash = 'bc68d615444cdbcc885d6ba400db0ffaa69df2ff3055484d20bcbcc33b3d24ab'
$rc2MainHash = '241e66375dbe9ed783c5a206abd43b71299816587874b404f3f6f9da4d4dcc54'

class ForgeWitnessedRc2Session : System.IDisposable {
    hidden [System.IDisposable] $Resource
    hidden [string] $Generation
    ForgeWitnessedRc2Session([System.IDisposable]$resource, [string]$generation) {
        $this.Resource = $resource
        $this.Generation = $generation
    }
    [void] Dispose() {
        if ($null -ne $this.Resource) {
            $this.Resource.Dispose()
            $this.Resource = $null
        }
    }
}

function Get-WitnessFields([Text.Json.JsonElement]$Element, [string[]]$Names) {
    $fields = [Collections.Generic.Dictionary[string,Text.Json.JsonElement]]::new([StringComparer]::Ordinal)
    foreach ($property in $Element.EnumerateObject()) {
        if ($property.Name -cnotin $Names -or !$fields.TryAdd($property.Name, $property.Value)) {
            throw 'Unexpected or duplicate generation field.'
        }
    }
    if ($fields.Count -ne $Names.Count) { throw 'Missing generation field.' }
    return $fields
}

function Assert-WitnessIdentity([Text.Json.JsonElement]$Identity, [string]$Principal, [string]$Command) {
    $i = Get-WitnessFields $Identity @('principal','command')
    if ($i['principal'].GetString() -cne $Principal -or $i['command'].GetString() -cne $Command) {
        throw 'Unexpected startup generation identity.'
    }
}

function Read-WitnessIntent([Text.Json.JsonElement]$Intent, $Principal, $Command, $Generation, $Operation) {
    $i = Get-WitnessFields $Intent @('operation_id','operation','identity','generation','prior_sha256')
    Assert-WitnessIdentity $i['identity'] $Principal $Command
    $operationId = $i['operation_id'].GetString()
    $prior = $i['prior_sha256'].GetString()
    if ($operationId -cnotmatch '\A[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\z' -or
        $i['generation'].GetString() -cne $Generation -or $i['operation'].GetString() -cne $Operation -or
        ($null -ne $prior -and $prior -cnotmatch '\A[0-9a-f]{64}\z')) {
        throw 'Unconfirmed startup operation.'
    }
    return @{operationId=$operationId; prior=$prior}
}

function Read-WitnessGeneration([scriptblock]$ReadRecord, [string]$Principal, [string]$Command, [switch]$BeforeInstall) {
    $marker = & $ReadRecord 'startup-generation.initialized' $BeforeInstall.IsPresent
    if ($null -eq $marker -and $BeforeInstall) { return }
    if ($null -eq $marker -or [Convert]::ToHexString($marker) -cne '737461727475702D67656E65726174696F6E732D76310A') {
        throw 'Unconfirmed startup initialization.'
    }
    [byte[]]$raw = & $ReadRecord 'startup-generations.json' $false
    if ($raw.Length -lt 1 -or $raw.Length -gt 131072) { throw 'Unbounded startup manifest.' }
    $options = [Text.Json.JsonDocumentOptions]@{MaxDepth=12}
    $document = [Text.Json.JsonDocument]::Parse([ReadOnlyMemory[byte]]::new($raw),$options)
    try {
        $m = Get-WitnessFields $document.RootElement @('version','revision','generations','pending')
        $revision = $m['revision'].GetInt64()
        $count = $m['generations'].GetArrayLength()
        if ($m['version'].GetInt64() -ne 1 -or $revision -lt 1 -or $revision -gt 9007199254740991 -or
            $m['pending'].ValueKind -ne [Text.Json.JsonValueKind]::Null -or $count -lt 1 -or $count -gt 64) {
            throw 'Unconfirmed startup generation history.'
        }
        $manifestHash = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($raw)).ToLowerInvariant()
        $seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
        $revisions = [Collections.Generic.HashSet[long]]::new()
        $active = $null
        foreach ($element in $m['generations'].EnumerateArray()) {
            $row = Get-WitnessFields $element @('identity','generation','state','receipt')
            Assert-WitnessIdentity $row['identity'] $Principal $Command
            $generation = $row['generation'].GetString()
            $state = $row['state'].GetString()
            if ($null -ne $active -or $state -cnotin @('active','retired') -or
                $generation -cnotmatch '\A[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\z' -or !$seen.Add($generation)) {
                throw 'Ambiguous startup generation.'
            }
            $operation = if ($state -ceq 'active') { 'activate' } else { 'retire' }
            $intent = Read-WitnessIntent $row['receipt'] $Principal $Command $generation $operation
            [byte[]]$bytes = & $ReadRecord ('startup-generation-'+$intent.operationId+'-terminal.json') $false
            if ($bytes.Length -lt 1 -or $bytes.Length -gt 8192) { throw 'Unbounded startup receipt.' }
            $receipt = [Text.Json.JsonDocument]::Parse([ReadOnlyMemory[byte]]::new($bytes),$options)
            try {
                $r = Get-WitnessFields $receipt.RootElement @('version','intent','phase','revision','manifest_sha256')
                $terminal = Read-WitnessIntent $r['intent'] $Principal $Command $generation $operation
                $n = $r['revision'].GetInt64()
                $hash = $r['manifest_sha256'].GetString()
                if ($r['version'].GetInt64() -ne 1 -or $r['phase'].GetString() -cne $state -or
                    $terminal.operationId -cne $intent.operationId -or $terminal.prior -cne $intent.prior -or
                    $n -lt 1 -or $n -gt $revision -or !$revisions.Add($n) -or $hash -cnotmatch '\A[a-f0-9]{64}\z' -or
                    ($n -eq $revision -and $hash -cne $manifestHash)) {
                    throw 'Unconfirmed terminal startup receipt.'
                }
            } finally { $receipt.Dispose() }
            if ($state -ceq 'active') { $active = $generation }
        }
        if (!$revisions.Contains($revision)) { throw 'Latest startup publication is missing.' }
        if ($BeforeInstall) {
            if ($null -ne $active) { throw 'An existing installation is active.' }
            return
        }
        if ($null -eq $active) { throw 'Confirmed activation is required.' }
        return $active
    } finally { $document.Dispose() }
}

function Get-WitnessActivation([string]$Version, [switch]$BeforeInstall) {
    $local = [Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)
    $dir = Join-Path $local 'Agent Forge Harness'
    $command = '"' + (Join-Path $dir 'agent-forge-desktop.exe') + '" --from-login'
    $principal = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $registration = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Software\Microsoft\Windows\CurrentVersion\Uninstall\Agent Forge Harness')
    try {
        if ($BeforeInstall) {
            if ($null -ne $registration -or (Test-Path -LiteralPath $dir -ErrorAction Stop)) { throw 'Witnessed installation needs an unused product location.' }
        } else {
            $expected = @{DisplayVersion=$Version; MainBinaryName='agent-forge-desktop.exe'; DisplayName='Agent Forge Harness';
                InstallLocation=('"'+$dir+'"'); UninstallString=('"'+(Join-Path $dir 'uninstall.exe')+'"')}
            foreach ($name in $expected.Keys) {
                if ($null -eq $registration -or $registration.GetValue($name,$null,[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames) -cne $expected[$name] -or
                    $registration.GetValueKind($name) -ne [Microsoft.Win32.RegistryValueKind]::String) {
                    throw 'Confirmed package registration is required.'
                }
            }
        }
    } finally { if ($null -ne $registration) { $registration.Dispose() } }

    try {
        Read-WitnessGeneration {
            param($Name,$AllowAbsentDirectory)
            $bytes = [AgentForge.Upgrade.Rc2Witness]::ReadStartupRecord($Name,$AllowAbsentDirectory)
            return ,$bytes
        } $principal $command -BeforeInstall:$BeforeInstall
    } catch { throw 'Unconfirmed private startup generation history.' }
}

function Enter-WitnessPackageGuard {
    $created = $false
    $guard = [Threading.Mutex]::new($false, 'Global\dev.agentforge.harness.package.v1', [ref]$created)
    if (!$created) {
        $guard.Dispose()
        throw 'Another package operation is active.'
    }
    return $guard
}

function Open-WitnessedSetup([string]$Path, [string]$Sha256) {
    # The caller retains the verified setup and its ancestors through process settlement.
    return [AgentForge.Upgrade.Rc2Witness]::PinSetup($Path, $Sha256)
}

function Invoke-WitnessedSetup([string]$Path) {
    $start = [Diagnostics.ProcessStartInfo]::new($Path)
    $start.ArgumentList.Add('/S')
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    $start.WorkingDirectory = [Environment]::GetFolderPath([Environment+SpecialFolder]::System)
    $start.Environment.Clear()
    foreach ($name in @('SystemRoot','WINDIR','TEMP','TMP','USERPROFILE','APPDATA','LOCALAPPDATA','ProgramData','ProgramFiles','ProgramFiles(x86)','CommonProgramFiles','ComSpec','USERDOMAIN','USERNAME')) {
        $value = [Environment]::GetEnvironmentVariable($name)
        if ($value) { $start.Environment[$name] = $value }
    }
    $start.Environment['PATH'] = $start.WorkingDirectory
    $elapsed = [Diagnostics.Stopwatch]::StartNew()
    $process = [Diagnostics.Process]::Start($start)
    try {
        $stdout = $process.StandardOutput.BaseStream.CopyToAsync([IO.Stream]::Null)
        $stderr = $process.StandardError.BaseStream.CopyToAsync([IO.Stream]::Null)
        $remaining = [int][Math]::Max(0, 75000L - $elapsed.ElapsedMilliseconds)
        if (!$process.WaitForExit($remaining)) { throw 'Setup completion is unknown.' }
        $remaining = [int][Math]::Max(0, 75000L - $elapsed.ElapsedMilliseconds)
        if (![Threading.Tasks.Task]::WaitAll([Threading.Tasks.Task[]]@($stdout,$stderr),$remaining)) { throw 'Setup output completion is unknown.' }
        if ($process.ExitCode -ne 0) { throw 'The selected installer did not complete successfully.' }
    } finally { $process.Dispose() }
}

function Initialize-WitnessNative {
    if ($script:nativeLoaded) { return }
    if ('AgentForge.Upgrade.Rc2Witness' -as [type]) { throw 'Use a fresh PowerShell session for the reviewed witness tools.' }
    $file = [IO.File]::Open((Join-Path $PSScriptRoot 'Rc2ResourceWitness.cs'), [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
    try {
        if ($file.Length -lt 1 -or $file.Length -gt 131072) { throw 'Unexpected native witness source size.' }
        $bytes = [byte[]]::new($file.Length)
        $file.ReadExactly($bytes)
    } finally { $file.Dispose() }
    $digest = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($bytes)).ToLowerInvariant()
    if ($digest -cne 'c15d1134ba801a0e5ab9e8909fa78d6c3742e3fc58c0201701a0ae80852b476b') { throw 'The native witness source differs from the reviewed version.' }
    Add-Type -TypeDefinition ([Text.UTF8Encoding]::new($false,$true).GetString($bytes)) -ErrorAction Stop
    $script:nativeLoaded = $true
}

function New-WitnessFailure([string]$Stage) {
    $failure = [InvalidOperationException]::new("Witnessed installation stopped at $Stage.")
    $failure.Data['ForgeWitnessStage'] = $Stage
    return $failure
}

function Start-ForgeWitnessedRc2Install {
    [CmdletBinding()]
    [OutputType([ForgeWitnessedRc2Session])]
    param([Parameter(Mandatory)][string]$SetupPath)
    if (!$IsWindows -or ![Environment]::Is64BitProcess) { throw 'A 64-bit Windows PowerShell 7 session is required.' }
    $stage = 'native-source'
    $approval = $null
    $resource = $null
    try {
        Initialize-WitnessNative
        $stage = 'prior-setup-identity'
        $setup = [IO.Path]::GetFullPath($SetupPath)
        $approval = Open-WitnessedSetup $setup $rc2SetupHash
        $stage = 'initial-state'
        $guard = Enter-WitnessPackageGuard
        try {
            Get-WitnessActivation -BeforeInstall
            $stage = 'original-file'
            $resource = [AgentForge.Upgrade.Rc2Witness]::Begin()
        } finally { $guard.Dispose() }
        $stage = 'prior-setup'
        Invoke-WitnessedSetup $setup
        $stage = 'prior-activation'
        $guard = Enter-WitnessPackageGuard
        try {
            $generation = Get-WitnessActivation '1.0.0-rc.2'
            $stage = 'prior-content'
            $resource.ConfirmPrior()
        } finally { $guard.Dispose() }
        $session = [ForgeWitnessedRc2Session]::new($resource,$generation)
        $resource = $null
        return $session
    } catch { throw (New-WitnessFailure $stage) } finally {
        if ($null -ne $resource) { $resource.Dispose() }
        if ($null -ne $approval) { $approval.Dispose() }
    }
}

function Complete-ForgeWitnessedRc2Upgrade {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][ForgeWitnessedRc2Session]$Session,
        [Parameter(Mandatory)][string]$SetupPath,
        [Parameter(Mandatory)][ValidatePattern('\A[a-f0-9]{64}\z')][string]$SetupSha256,
        [Parameter(Mandatory)][ValidatePattern('\A[a-f0-9]{64}\z')][string]$InstalledMainSha256
    )
    if ($null -eq $Session.Resource) { throw 'The original witnessed installation session is required.' }
    $stage = 'successor-identity'
    try {
        if ($SetupSha256 -ceq $rc2SetupHash -or $InstalledMainSha256 -ceq $rc2MainHash) { throw 'Distinct reviewed successor identities are required.' }
        $stage = 'prior-recheck'
        $guard = Enter-WitnessPackageGuard
        try {
            if ((Get-WitnessActivation '1.0.0-rc.2') -cne $Session.Generation) { throw 'The witnessed predecessor generation changed.' }
            $Session.Resource.VerifyConfirmedPrior()
        } finally { $guard.Dispose() }
        $setup = [IO.Path]::GetFullPath($SetupPath)
        $stage = 'successor-identity'
        $pin = Open-WitnessedSetup $setup $SetupSha256
        $stage = 'successor-setup'
        try { Invoke-WitnessedSetup $setup } finally { $pin.Dispose() }
        $stage = 'successor-activation'
        $guard = Enter-WitnessPackageGuard
        try {
            if ((Get-WitnessActivation '1.0.0-rc.4') -cne $Session.Generation) { throw 'The successor did not retain the witnessed active generation.' }
            $stage = 'resource-retirement'
            $Session.Resource.Commit($InstalledMainSha256)
        } finally { $guard.Dispose() }
    } catch { throw (New-WitnessFailure $stage) } finally { $Session.Dispose() }
}
Export-ModuleMember -Function Start-ForgeWitnessedRc2Install, Complete-ForgeWitnessedRc2Upgrade
