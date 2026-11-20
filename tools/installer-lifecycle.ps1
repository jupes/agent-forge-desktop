param([ValidateSet('Library','Select','Verify','Exercise')][string]$Mode='Library')
$ErrorActionPreference='Stop'
$lifecycleMode=$Mode
$script:lifecyclePhase='context'
$script:lifecycleCheck='identity'
. (Join-Path $PSScriptRoot 'release-draft.ps1') -Mode Library

function Assert-LifecycleVersions([string]$Prior,[string]$Current) {
  foreach($version in @($Prior,$Current)) {
    if($version -cnotmatch '^1[.]0[.]0-rc[.][1-9][0-9]*$') { throw 'Unsupported candidate version.' }
  }
  if([semver]$Prior -ge [semver]$Current) { throw 'Upgrade requires a strictly earlier version.' }
}
function Assert-SingleLifecycleAttempt($History,[string]$Head,[string]$RunId) {
  if($History.total_count -lt 1 -or $History.total_count -gt 100 -or @($History.workflow_runs).Count -ne $History.total_count) { throw 'Incomplete lifecycle run history.' }
  $self=0
  foreach($run in $History.workflow_runs) {
    if($run.head_sha -cne $Head -or [string]$run.id -cnotmatch '^[1-9][0-9]*$') { throw 'Unrecognized lifecycle history.' }
    if([long]$run.id -lt [long]$RunId) { throw 'Lifecycle already attempted on this exact main commit.' }
    if([string]$run.id -ceq $RunId) { $self++ }
  }
  if($self -ne 1) { throw 'Current lifecycle dispatch missing.' }
}
function Get-CommitFile([string]$Sha,[string]$Name) {
  $content = & git show "$($Sha):$Name"
  if($LASTEXITCODE -ne 0) { throw 'Selected commit metadata unavailable.' }
  return (($content -join [Environment]::NewLine) | ConvertFrom-Json -AsHashtable)
}
function Select-LifecycleSources {
  $script:lifecyclePhase='quality-selection'
  $head=$env:GITHUB_SHA
  $ref=Invoke-ForgeApi 'git/ref/heads/main'
  if($ref.object.sha -cne $head) { throw 'Main moved.' }
  $history=Invoke-ForgeApi ("actions/workflows/installer-lifecycle.yml/runs?event=workflow_dispatch&branch=main&head_sha="+$head+'&per_page=100')
  Assert-SingleLifecycleAttempt $history $head $env:GITHUB_RUN_ID
  $commits=@()
  foreach($id in @($env:CURRENT_QUALITY_RUN,$env:PRIOR_QUALITY_RUN)) {
    $run=Invoke-ForgeApi ("actions/runs/"+$id)
    $jobs=Invoke-ForgeApi ("actions/runs/"+$id+'/attempts/1/jobs?per_page=100')
    if($jobs.total_count -ne 7 -or $run.head_repository.full_name -cne $env:GITHUB_REPOSITORY) { throw 'Unexpected Quality source.' }
    Assert-ForgeQuality $run $jobs.jobs @{runId=$id;sha=$run.head_sha}
    $commits+= $run.head_sha
  }
  if($commits[0] -cne $head -or $commits[1] -ceq $head) { throw 'Wrong Quality selection.' }
  & git merge-base --is-ancestor $commits[1] $head
  if($LASTEXITCODE -ne 0) { throw 'Earlier source is not an ancestor of current main.' }
  # PR 11 is the first accepted main source with independent portable and NSIS main hashes.
  & git merge-base --is-ancestor 477d5ceab71a11ec8706338a6971eefd70268d6e $commits[1]
  if($LASTEXITCODE -ne 0) { throw 'Earlier source predates verifiable NSIS payloads.' }
  Assert-LifecycleVersions (Get-CommitFile $commits[1] 'package.json').version (Get-CommitFile $head 'package.json').version
  "prior_sha=$($commits[1])" | Add-Content -LiteralPath $env:GITHUB_OUTPUT
}
function Save-VerifiedPackages([string]$Stage) {
  $current=Get-ForgeReleaseContext $env:CURRENT_QUALITY_RUN
  Push-Location -LiteralPath 'prior-candidate-source'
  try {
    $sha=& git rev-parse HEAD
    if($LASTEXITCODE -ne 0) { throw 'Earlier checkout unavailable.' }
    $tree=& git rev-parse 'HEAD^{tree}'
    if($LASTEXITCODE -ne 0) { throw 'Earlier source tree unavailable.' }
    $prior=Get-ForgeQualifiedSource $env:PRIOR_QUALITY_RUN $sha $tree
  } finally { Pop-Location }
  Assert-LifecycleVersions $prior.version $current.version
  if(Test-Path -LiteralPath $Stage) { throw 'Existing stage must be preserved.' }
  $null=New-Item -ItemType Directory -Path $Stage
  foreach($name in @('prior','current')) {
    $expected=if($name -ceq 'prior') {$prior} else {$current}
    $dir=Join-Path $Stage $name
    $script:lifecyclePhase='verify-'+$name
    if($name -ceq 'prior') {
      $verified=Export-ForgeCandidatePair $expected $dir -ApprovedInstallerArchiveSha256 $env:PRIOR_ARCHIVE_SHA256
      "prior_setup_sha256=$($verified.pair.installer.installer.sha256)" | Add-Content -LiteralPath $env:GITHUB_OUTPUT
    } else {
      $verified=Export-ForgeCandidatePair $expected $dir
      if($verified.pair.installer.installer.sha256 -cne $env:CURRENT_SETUP_SHA256) { throw 'Current setup differs from independently reviewed bytes.' }
    }
    Write-ForgeJson (Join-Path $dir 'verified-payload.json') $verified.pair
  }
  $final=Invoke-ForgeApi 'git/ref/heads/main'
  if($final.object.sha -cne $current.sha) { throw 'Main changed while preparing the test.' }
}
function Get-PackageReceipt([string]$Stage,[string]$Role,[string]$Approved) {
  $dir=Join-Path $Stage $Role
  $pair=Get-Content -LiteralPath (Join-Path $dir 'verified-payload.json') -Raw | ConvertFrom-Json -AsHashtable
  $installer=$pair.installer
  $name='Agent-Forge-Harness-'+$installer.productVersion+'-windows-x64-setup.exe'
  if($installer.installer.path -cne $name -or $installer.installer.sha256 -cne $Approved) { throw 'Changed setup identity.' }
  $path=Join-Path $dir $name
  if((Get-ForgeHash $path) -cne $Approved) { throw 'Setup changed after verification.' }
  return @{path=$path;setupHash=$Approved;version=$installer.productVersion;main=$installer.mainBinarySha256;files=$pair.portable.files}
}
function Assert-InstalledFiles($Package,[string]$Directory) {
  foreach($file in $Package.files) {
    if($file.path -ceq 'MANUAL-TESTING.md') { continue }
    Assert-ForgeArchivePath $file.path
    $path=Join-Path $Directory $file.path
    $expected=if($file.path -ceq 'agent-forge-desktop.exe') {$Package.main} else {$file.sha256}
    if((Get-ForgeHash $path) -cne $expected) { throw 'Installed payload mismatch.' }
  }
}
function Invoke-GuestPackage([string]$Path) {
  $start=[Diagnostics.ProcessStartInfo]::new($Path)
  $start.ArgumentList.Add('/S')
  $start.UseShellExecute=$false
  $start.CreateNoWindow=$true
  $start.RedirectStandardOutput=$true
  $start.RedirectStandardError=$true
  $start.WorkingDirectory=$env:RUNNER_TEMP
  $start.Environment.Clear()
  foreach($key in @('SystemRoot','WINDIR','TEMP','TMP','USERPROFILE','APPDATA','LOCALAPPDATA','ProgramData','ProgramFiles','ProgramFiles(x86)','CommonProgramFiles','ComSpec','USERDOMAIN','USERNAME')) {
    $value=[Environment]::GetEnvironmentVariable($key)
    if($value) { $start.Environment[$key]=$value }
  }
  $start.Environment['PATH'] = Join-Path $env:SystemRoot 'System32'
  $script:lifecycleCheck='silent-package-process'
  $elapsed=[Diagnostics.Stopwatch]::StartNew()
  $process=[Diagnostics.Process]::Start($start)
  try {
    $stdout=$process.StandardOutput.BaseStream.CopyToAsync([IO.Stream]::Null)
    $stderr=$process.StandardError.BaseStream.CopyToAsync([IO.Stream]::Null)
    if(!$process.WaitForExit(75000)) { throw 'Package outcome unknown; stop and dispose of this runner.' }
    $remaining=[int][Math]::Max(0,75000-$elapsed.ElapsedMilliseconds)
    if(![Threading.Tasks.Task]::WaitAll([Threading.Tasks.Task[]]@($stdout,$stderr),$remaining)) { throw 'Package output completion unknown.' }
    if($process.ExitCode -ne 0) { throw 'Package refused or failed.' }
  } finally { $process.Dispose() }
}
function Get-ActiveGeneration([string]$StateDirectory,[string]$Phase,[string]$ExpectedGeneration,[string]$ExpectedCommand,[string]$ExpectedPrincipal,[string[]]$RequiredRetired) {
  $path=Join-Path $StateDirectory 'startup-generations.json'
  if((Get-Item -LiteralPath $path).Length -gt 131072) { throw 'Oversize generation manifest.' }
  $manifest=Get-Content -LiteralPath $path -Raw | ConvertFrom-Json -AsHashtable
  if($manifest.version -ne 1 -or $null -ne $manifest.pending) { throw 'Unconfirmed generation.' }
  $rows=@($manifest.generations)
  $active=@($rows | Where-Object { $_.state -ceq 'active' })
  if($ExpectedCommand -and @($rows | Where-Object { $_.identity.command -cne $ExpectedCommand }).Count) { throw 'Unexpected generation owner.' }
  if($ExpectedPrincipal -and @($rows | Where-Object { $_.identity.principal -cne $ExpectedPrincipal }).Count) { throw 'Unexpected generation principal.' }
  foreach($id in $RequiredRetired) {
    if(@($rows | Where-Object { $_.generation -ceq $id -and $_.state -ceq 'retired' }).Count -ne 1) { throw 'Earlier retirement missing.' }
  }
  if($Phase -ceq 'retired') {
    if(@($rows | Where-Object {$_.generation -ceq $ExpectedGeneration}).Count -ne 1 -or $active.Count -ne 0 -or @($rows | Where-Object {$_.state -cne 'retired'}).Count) { throw 'Retirement missing.' }
    return
  }
  if($active.Count -ne 1 -or $active[0].generation -cnotmatch '^[a-f0-9-]{36}$') { throw 'Activation missing.' }
  return $active[0].generation
}
function Assert-RunSlot($Value,$Kind,$Expected) {
  if($null -eq $Expected) {
    if($null -ne $Value) { throw 'Expected an absent Run value.' }
  } elseif($Value -isnot [string] -or $Kind -ne [Microsoft.Win32.RegistryValueKind]::String -or ![string]::Equals($Value,$Expected,[StringComparison]::Ordinal)) {
    throw 'Unexpected Run value data or registry type.'
  }
}
function Assert-GuestRunSlot($Guest,$Expected) {
  $key=Get-Item -LiteralPath $Guest.runKey
  try {
    $value=$key.GetValue('dev.agentforge.harness',$null,[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
    $kind=if($null -ne $value) { $key.GetValueKind('dev.agentforge.harness') }
    Assert-RunSlot $value $kind $Expected
  } finally { $key.Close() }
}
function Add-GuestRunFixture($Guest,[string]$Value) {
  Assert-GuestRunSlot $Guest $null
  $null=New-ItemProperty -LiteralPath $Guest.runKey -Name 'dev.agentforge.harness' -Value $Value -PropertyType String
  Assert-GuestRunSlot $Guest $Value
}
function Assert-PreservedGuest($Guest,$ExpectedRun) {
  if((Get-ForgeHash $Guest.marker) -cne $Guest.markerHash -or (Get-ItemPropertyValue -LiteralPath $Guest.runKey -Name $Guest.foreignName) -cne $Guest.foreignValue) { throw 'Synthetic profile or unrelated startup value changed.' }
  Assert-GuestRunSlot $Guest $ExpectedRun
}
function Install-GuestPackage($Package,$Guest,$ExpectedRun) {
  if((Get-ForgeHash $Package.path) -cne $Package.setupHash) { throw 'Selected setup changed before launch.' }
  Invoke-GuestPackage $Package.path
  $script:lifecycleCheck='installed-registration'
  $reg=Get-ItemProperty -LiteralPath $Guest.uninstall
  if($reg.InstallLocation -cne ('"'+$Guest.dir+'"') -or $reg.MainBinaryName -cne 'agent-forge-desktop.exe' -or $reg.DisplayName -cne 'Agent Forge Harness' -or $reg.DisplayVersion -cne $Package.version -or $reg.UninstallString -cne ('"'+$Guest.uninstaller+'"') -or !(Test-Path -LiteralPath $Guest.uninstaller -PathType Leaf)) { throw 'Unexpected installed package registration.' }
  $script:lifecycleCheck='installed-payload'
  Assert-InstalledFiles $Package $Guest.dir
  $script:lifecycleCheck='synthetic-profile-and-run-key'
  Assert-PreservedGuest $Guest $ExpectedRun
  $script:lifecycleCheck='active-generation'
  return Get-ActiveGeneration $Guest.state 'active' '' $Guest.ownedCommand $Guest.principal
}
function Get-RemovalFacts([string]$Directory,$Current,$Prior) {
  $facts=[ordered]@{targetPresent=(Test-Path -LiteralPath $Directory);currentExact=0;currentChanged=0;priorOnlyExact=0;priorOnlyChanged=0;foreignFiles=0;priorDirectories=0;foreignDirectories=0;links=0}
  if(!$facts.targetPresent) { return $facts }
  $target=Get-Item -LiteralPath $Directory -Force
  if(!$target.PSIsContainer -or ($target.Attributes -band [IO.FileAttributes]::ReparsePoint)) { $facts.links++; return $facts }
  $currentFiles=@{}; $priorFiles=@{}
  $priorDirectories=[Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
  foreach($file in $Current.files) {
    if($file.path -cne 'MANUAL-TESTING.md') { $currentFiles[$file.path]=$file }
  }
  foreach($file in $Prior.files) {
    if($file.path -ceq 'MANUAL-TESTING.md' -or $currentFiles.ContainsKey($file.path)) { continue }
    $priorFiles[$file.path]=$file
    $parts=$file.path.Split('/')
    for($i=1;$i -lt $parts.Length;$i++) { $null=$priorDirectories.Add(($parts[0..($i-1)] -join '/')) }
  }
  $directories=[Collections.Generic.Stack[string]]::new()
  $directories.Push($Directory); $entries=0
  while($directories.Count) {
    $parent=$directories.Pop()
    foreach($item in [IO.DirectoryInfo]::new($parent).EnumerateFileSystemInfos()) {
      if(++$entries -gt 24000) { throw 'Residual entry count exceeds both accepted archive bounds.' }
      $rel=[IO.Path]::GetRelativePath($Directory,$item.FullName).Replace('\','/')
      if($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { $facts.links++; continue }
      if($item.Attributes -band [IO.FileAttributes]::Directory) {
        if($priorDirectories.Contains($rel)) { $facts.priorDirectories++ } else { $facts.foreignDirectories++ }
        $directories.Push($item.FullName)
      } elseif($currentFiles.ContainsKey($rel)) {
        $row=$currentFiles[$rel]
        $hash=if($rel -ceq 'agent-forge-desktop.exe') { $Current.main } else { $row.sha256 }
        if($item.Length -eq $row.bytes -and (Get-ForgeHash $item.FullName) -ceq $hash) { $facts.currentExact++ } else { $facts.currentChanged++ }
      } elseif($priorFiles.ContainsKey($rel)) {
        $row=$priorFiles[$rel]
        if($item.Length -eq $row.bytes -and (Get-ForgeHash $item.FullName) -ceq $row.sha256) { $facts.priorOnlyExact++ } else { $facts.priorOnlyChanged++ }
      } else { $facts.foreignFiles++ }
    }
  }
  return $facts
}
function Assert-RemovalFacts($Facts,[bool]$Upgraded) {
  if($Facts.registrationPresent -or $Facts.currentExact -or $Facts.currentChanged -or $Facts.priorOnlyChanged -or $Facts.foreignFiles -or $Facts.foreignDirectories -or $Facts.links) { throw 'Unexpected residual installation state.' }
  if($Facts.targetPresent -and (!$Upgraded -or !$Facts.priorOnlyExact)) { throw 'Install target remained without an identified earlier payload.' }
}
function Uninstall-GuestPackage($Guest,[string]$ExpectedGeneration,$ExpectedRun,$Current,$Prior,[string[]]$EarlierRetired) {
  Invoke-GuestPackage $Guest.uninstaller
  # NSIS may finish uninstall from its temporary copy after its original process exits.
  $script:lifecycleCheck='owned-installation-removal'
  $deadline=[Diagnostics.Stopwatch]::StartNew()
  while((Test-Path -LiteralPath $Guest.uninstall) -or (Test-Path -LiteralPath $Guest.uninstaller)) {
    if($deadline.Elapsed.TotalSeconds -ge 30) { break }
    Start-Sleep -Milliseconds 150
  }
  $facts=Get-RemovalFacts $Guest.dir $Current $Prior
  $facts.registrationPresent=Test-Path -LiteralPath $Guest.uninstall
  $report=$script:lifecyclePhase+' residual counts '+($facts | ConvertTo-Json -Compress)
  Write-Host $report
  $report | Add-Content -LiteralPath $env:GITHUB_STEP_SUMMARY
  if($facts.priorOnlyExact) { 'Complete file removal remains open for the observed prior-only payload.' | Add-Content -LiteralPath $env:GITHUB_STEP_SUMMARY }
  Assert-RemovalFacts $facts ($null -ne $Prior)
  $script:lifecycleCheck='retired-generation'
  Get-ActiveGeneration $Guest.state 'retired' $ExpectedGeneration $Guest.ownedCommand $Guest.principal $EarlierRetired
  $script:lifecycleCheck='synthetic-profile-and-run-key'
  Assert-PreservedGuest $Guest $ExpectedRun
}
function Test-GuestLifecycle([string]$Stage) {
  $script:lifecyclePhase='verified-receipts'
  if($env:VERIFIED_PRIOR_SETUP_SHA256 -cnotmatch '^[a-f0-9]{64}$' -or $env:VERIFIED_PRIOR_SETUP_SHA256 -ceq $env:CURRENT_SETUP_SHA256) { throw 'Missing or duplicate verified prior setup.' }
  $prior=Get-PackageReceipt $Stage prior $env:VERIFIED_PRIOR_SETUP_SHA256
  $current=Get-PackageReceipt $Stage current $env:CURRENT_SETUP_SHA256
  Assert-LifecycleVersions $prior.version $current.version
  $script:lifecyclePhase='clean-guest'
  $local=[Environment]::GetFolderPath('LocalApplicationData')
  $dir=Join-Path $local 'Agent Forge Harness'
  $guest=@{dir=$dir;uninstaller=(Join-Path $dir 'uninstall.exe');state=(Join-Path $local '.agent-forge-startup-v1');uninstall='HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\Agent Forge Harness';runKey='HKCU:\Software\Microsoft\Windows\CurrentVersion\Run';foreignName='AgentForgeLifecycleForeignFixture';foreignValue='inert-foreign-marker'}
  $guest.principal=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  $guest.ownedCommand='"'+(Join-Path $dir 'agent-forge-desktop.exe')+'" --from-login'
  $profileDir=Join-Path ([Environment]::GetFolderPath('UserProfile')) '.agent-forge'
  foreach($path in @($dir,$guest.state,$guest.uninstall,$profileDir)) { if(Test-Path -LiteralPath $path) { throw 'Disposable guest already contains product state.' } }
  $webView='Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}'
  if(!(Get-ItemPropertyValue -LiteralPath ('HKLM:\Software\WOW6432Node\'+$webView) -Name pv -ErrorAction SilentlyContinue) -and !(Get-ItemPropertyValue -LiteralPath ('HKCU:\Software\'+$webView) -Name pv -ErrorAction SilentlyContinue)) { throw 'Guest requires preinstalled WebView2.' }
  if(!(Test-Path -LiteralPath $guest.runKey)) { $null=New-Item -Path $guest.runKey }
  $run=Get-Item -LiteralPath $guest.runKey
  if($null -ne $run.GetValue($guest.foreignName) -or $null -ne $run.GetValue('dev.agentforge.harness')) { throw 'Guest has conflicting startup state.' }
  $null=New-Item -ItemType Directory -Path $profileDir
  $guest.marker=Join-Path $profileDir 'hosted-lifecycle-profile.txt'
  [IO.File]::WriteAllText($guest.marker,[guid]::NewGuid().ToString())
  $guest.markerHash=Get-ForgeHash $guest.marker
  $null=New-ItemProperty -LiteralPath $guest.runKey -Name $guest.foreignName -Value $guest.foreignValue -PropertyType String
  Write-Output 'Checking current fresh installation and retirement.'
  $script:lifecyclePhase='current-fresh'
  $first=Install-GuestPackage $current $guest
  $script:lifecyclePhase='current-fresh-uninstall'
  Add-GuestRunFixture $guest $guest.ownedCommand
  Uninstall-GuestPackage $guest $first $null $current $null
  Write-Output 'Checking the approved prior installation and upgrade.'
  $script:lifecyclePhase='prior-fresh'
  $before=Install-GuestPackage $prior $guest
  if($first -ceq $before) { throw 'Reinstallation reused a retired generation.' }
  $script:lifecyclePhase='upgrade'
  $foreignRun='inert-foreign-command-'+[guid]::NewGuid().ToString('N')
  Add-GuestRunFixture $guest $foreignRun
  $after=Install-GuestPackage $current $guest $foreignRun
  if($before -cne $after) { throw 'Upgrade changed active startup generation.' }
  $script:lifecyclePhase='upgrade-uninstall'
  Uninstall-GuestPackage $guest $after $foreignRun $current $prior @($first)
  "Current Quality $env:CURRENT_QUALITY_RUN, setup SHA256 $env:CURRENT_SETUP_SHA256. Earlier Quality $env:PRIOR_QUALITY_RUN, installer archive SHA256 $env:PRIOR_ARCHIVE_SHA256, verified setup SHA256 $env:VERIFIED_PRIOR_SETUP_SHA256." | Add-Content -LiteralPath $env:GITHUB_STEP_SUMMARY
  'Verified NSIS current fresh install, prior-to-current upgrade, uninstall, generation retirement, exact owned Run removal, foreign Run preservation, and synthetic profile preservation.' | Add-Content -LiteralPath $env:GITHUB_STEP_SUMMARY
}

if($lifecycleMode -ne 'Library') {
  try {
    if($env:GITHUB_ACTIONS -cne 'true' -or $env:GITHUB_REPOSITORY -cne 'jupes/agent-forge-desktop' -or $env:GITHUB_WORKFLOW -cne 'Check Windows installer lifecycle' -or $env:GITHUB_EVENT_NAME -cne 'workflow_dispatch' -or $env:GITHUB_REF -cne 'refs/heads/main' -or $env:GITHUB_RUN_ATTEMPT -cne '1' -or $env:RUNNER_OS -cne 'Windows' -or $env:RUNNER_ARCH -cne 'X64' -or $env:RUNNER_ENVIRONMENT -cne 'github-hosted') { throw 'Unexpected runner context.' }
    foreach($id in @($env:CURRENT_QUALITY_RUN,$env:PRIOR_QUALITY_RUN,$env:GITHUB_RUN_ID)) { if($id -cnotmatch '^[1-9][0-9]{0,18}$') { throw 'Malformed run identifier.' } }
    foreach($sha in @($env:CURRENT_SETUP_SHA256,$env:PRIOR_ARCHIVE_SHA256)) { if($sha -cnotmatch '^[a-f0-9]{64}$') { throw 'Malformed public installer identity.' } }
    if($env:GITHUB_SHA -cnotmatch '^[a-f0-9]{40}$' -or $env:CURRENT_QUALITY_RUN -ceq $env:PRIOR_QUALITY_RUN) { throw 'Duplicate or invalid selection.' }
    $stage=Join-Path $env:RUNNER_TEMP 'agent-forge-installer-lifecycle'
    switch($lifecycleMode) {
      Select { Select-LifecycleSources }
      Verify { Save-VerifiedPackages $stage }
      Exercise {
        if($env:GH_TOKEN -or $env:GITHUB_TOKEN) { throw 'Execution step has a GitHub credential.' }
        Test-GuestLifecycle $stage
      }
    }
  } catch {
    # Candidate bytes, user state and platform error strings never enter the log.
    Write-Output ("Installer lifecycle stopped during {0}, phase {1}, check {2} ({3})." -f $lifecycleMode,$script:lifecyclePhase,$script:lifecycleCheck,$_.Exception.GetType().Name)
    exit 1
  }
}
