$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'installer-lifecycle.ps1') -Mode Library

function Assert-Fails([scriptblock]$Action) {
  try { & $Action } catch { return }
  throw 'Expected lifecycle assertion to reject the fixture.'
}
# Only a single old-only, strictly generated dashboard asset may be named in public evidence.
& {
  $old=@{path='dashboard/assets/index-AbC123_-.js';bytes=123;sha256='a'*64;extra='DO-NOT-PRINT'}
  $new=@{path='dashboard/assets/index-XyZ987_-.js';bytes=129;sha256='b'*64}
  $pairs=@{}
  foreach($role in @('prior','current')) {
    $c=if($role -ceq 'prior') {'c'} else {'d'}
    $row=if($role -ceq 'prior') {$old} else {$new}
    $pairs[$role]=@{installer=@{sourceCommit=$c*40;sourceTree='e'*40;engineCommit='f'*40;desktopSourceDigest='0'*64;mainBinarySha256=$c*64;installer=@{sha256='1'*64};unrelated='DO-NOT-PRINT'};portable=@{files=@($row)}}
  }
  $facts=Get-VerifiedManifestFacts $pairs
  $asset=$facts.priorOnlyPortableFiles.asset
  if($facts.prior.sourceCommit -cne ('c'*40) -or $facts.current.sourceCommit -cne ('d'*40) -or $facts.prior.nsisMainSha256 -cne ('c'*64) -or $facts.current.nsisMainSha256 -cne ('d'*64) -or $facts.prior.setupSha256 -cne ('1'*64) -or $facts.current.setupSha256 -cne ('1'*64)) { throw 'Missing public source or package identity.' }
  if($facts.priorOnlyPortableFiles.status -cne 'single-generated-asset' -or $asset.basename -cne 'index-AbC123_-.js' -or $asset.bytes -ne 123 -or $asset.sha256 -cne $old.sha256) { throw 'Missing single verified asset identity.' }
  if(($facts|ConvertTo-Json -Depth 6 -Compress) -cmatch 'DO-NOT-PRINT|dashboard/') { throw 'Unprojected manifest data escaped.' }
  $pairs.current.portable.files=@(@{path=$old.path.ToUpperInvariant();bytes=234;sha256='2'*64})
  if((Get-VerifiedManifestFacts $pairs).priorOnlyPortableFiles.status -cne 'none') { throw 'Changed or differently cased current file considered absent.' }
  $pairs.current.portable.files=@($new)
  foreach($path in @('dashboard/assets/index-DO-NOT-PRINT!.js','other/index-AbC123_-.js',("dashboard/assets/index-AbC123_-.js"+[char]10))) {
    $old.path=$path
    $inventory=(Get-VerifiedManifestFacts $pairs).priorOnlyPortableFiles
    if($inventory.status -cne 'ineligible' -or $null -ne $inventory.asset -or ($inventory|ConvertTo-Json -Compress).Contains($path)) { throw 'Arbitrary path escaped suppression.' }
  }
  $old.path='dashboard/assets/index-AbC123_-.js'
  $old.sha256='DO-NOT-PRINT'
  if((Get-VerifiedManifestFacts $pairs).priorOnlyPortableFiles.status -cne 'ineligible') { throw 'Invalid fingerprint escaped suppression.' }
  $old.sha256='a'*64
  foreach($extra in @('dashboard/assets/index-Qwerty.js','private/path/DO-NOT-PRINT')) {
    $pairs.prior.portable.files=@($old,@{path=$extra;bytes=9;sha256='3'*64})
    $inventory=(Get-VerifiedManifestFacts $pairs).priorOnlyPortableFiles
    if($inventory.status -cne 'multiple-ineligible' -or $inventory.count -ne 2 -or $null -ne $inventory.asset) { throw 'Ambiguous inventory exposed a candidate.' }
  }
  $pairs.prior.installer.mainBinarySha256="DO-NOT-PRINT"
  Assert-Fails { Get-VerifiedManifestFacts $pairs }
}
Assert-LifecycleVersions '1.0.0-rc.2' '1.0.0-rc.10'
foreach($prior in @('1.0.0-rc.2','1.0.0-rc.3','1.0.0','malformed')) {
  Assert-Fails { Assert-LifecycleVersions $prior '1.0.0-rc.2' }
}
Assert-RunSlot $null $null $null
Assert-RunSlot 'unchanged foreign data' ([Microsoft.Win32.RegistryValueKind]::String) 'unchanged foreign data'
Assert-Fails { Assert-RunSlot 'unremoved' ([Microsoft.Win32.RegistryValueKind]::String) $null }
Assert-Fails { Assert-RunSlot $null $null 'foreign' }
Assert-Fails { Assert-RunSlot 'Foreign' ([Microsoft.Win32.RegistryValueKind]::String) 'foreign' }
Assert-Fails { Assert-RunSlot 'foreign' ([Microsoft.Win32.RegistryValueKind]::ExpandString) 'foreign' }
$head='a'*40
$archiveHash='f'*64
$expected=@{sha=$head;version='1.0.0-rc.1';runId='12'}
$artifact=@{name=('agent-forge-installer-1.0.0-rc.1-windows-x64-'+$head);workflow_run=@{head_sha=$head};digest=('sha256:'+$archiveHash);expired=$false}
$catalog=@{total_count=1;artifacts=@($artifact)}
Assert-ForgeArchiveApproval (Get-ForgeCandidateArtifact $catalog installer $expected) $archiveHash
Assert-Fails { Assert-ForgeArchiveApproval $artifact ('e'*64) }
Assert-Fails { Assert-ForgeArchiveApproval $artifact '' }
$artifact.expired=$true
Assert-Fails { Assert-ForgeArchiveApproval $artifact $archiveHash }
$artifact.expired=$false
$artifact.workflow_run.head_sha='b'*40
Assert-Fails { Get-ForgeCandidateArtifact $catalog installer $expected }
$artifact.workflow_run.head_sha=$head
$history=@{total_count=1;workflow_runs=@(@{head_sha=$head;id=10})}
Assert-SingleLifecycleAttempt $history $head '10'
Assert-Fails { Assert-SingleLifecycleAttempt $history $head '11' }
Assert-Fails { Assert-SingleLifecycleAttempt $history ('b'*40) '10' }
$history.total_count=2
Assert-Fails { Assert-SingleLifecycleAttempt $history $head '10' }
$history.workflow_runs+=@{head_sha=$head;id=11}
Assert-SingleLifecycleAttempt $history $head '10'
Assert-Fails { Assert-SingleLifecycleAttempt $history $head '11' }

$parent=[IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd([IO.Path]::DirectorySeparatorChar)
$dir=Join-Path $parent ('forge-lifecycle-fixture-'+[guid]::NewGuid().ToString('N'))
$null=New-Item -ItemType Directory -Path $dir
try {
  # The source selector must refuse the faulty helper template in either package before publishing a selection.
  & {
    $head='a'*40; $earlier='b'*40; $bad='657c6760837d9f4e90a08036864fc03092dba5a6'
    $template='apps/desktop/src-tauri/installer/installer.nsi'
    $prev=@($env:GITHUB_SHA,$env:GITHUB_RUN_ID,$env:GITHUB_REPOSITORY,$env:CURRENT_QUALITY_RUN,$env:PRIOR_QUALITY_RUN,$env:GITHUB_OUTPUT)
    function Invoke-ForgeApi([string]$Path) {
      if($Path -ceq 'git/ref/heads/main') { return @{object=@{sha=$head}} }
      if($Path.StartsWith('actions/workflows/installer-lifecycle.yml/runs?')) { return @{total_count=1;workflow_runs=@(@{id=30;head_sha=$head})} }
      if($Path -cmatch '\Aactions/runs/(20|10)\z') { return @{head_sha=if($Matches[1] -ceq '20') {$head} else {$earlier};head_repository=@{full_name=$env:GITHUB_REPOSITORY}} }
      if($Path -cmatch '\Aactions/runs/(20|10)/attempts/1/jobs\?per_page=100\z') { return @{total_count=7} }
      throw 'Unexpected fixture API request.'
    }
    function Assert-ForgeQuality { }
    function Get-CommitFile([string]$Sha) { return @{version=if($Sha -ceq $head) {'1.0.0-rc.3'} else {'1.0.0-rc.2'}} }
    function git {
      $global:LASTEXITCODE=0
      if($args[0] -ceq 'merge-base') { return }
      if($args[0] -ceq 'ls-tree' -and $args[-1] -ceq $template) {
        $commit=$args[-2]
        if($commit -cnotin @($head,$earlier)) { throw 'Unexpected fixture commit.' }
        $slot=if($commit -ceq $head) {'current'} else {'prior'}
        $seen.Add($slot)
        if($case -ceq "$slot-missing") { return }
        if($case -ceq "$slot-unsafe") { return "100644 blob $bad" }
        if($case -ceq "$slot-link") { return ('120000 blob '+('c'*40)) }
        if($case -ceq "$slot-dangling") { return ('100644 blob '+('f'*40)) }
        return ('100644 blob '+('c'*40))
      }
      if($args[0] -ceq 'cat-file' -and $args[1] -ceq '-e') {
        if($args[2] -ceq (('f'*40)+'^{blob}')) { $global:LASTEXITCODE=1 }
        return
      }
      throw 'Unexpected fixture Git operation.'
    }
    try {
      $env:GITHUB_SHA=$head; $env:GITHUB_RUN_ID='30'; $env:GITHUB_REPOSITORY='jupes/agent-forge-desktop'
      $env:CURRENT_QUALITY_RUN='20'; $env:PRIOR_QUALITY_RUN='10'
      foreach($case in @('current-unsafe','prior-unsafe','current-missing','prior-missing','prior-link','prior-dangling','eligible')) {
        $seen=[Collections.Generic.List[string]]::new()
        $env:GITHUB_OUTPUT=Join-Path $dir ('selection-'+$case)
        if($case -ceq 'eligible') {
          Select-LifecycleSources
          if(($seen -join ',') -cne 'current,prior' -or (Get-Content -LiteralPath $env:GITHUB_OUTPUT -Raw).TrimEnd() -cne "prior_sha=$earlier") { throw 'Missing eligible source selection.' }
        } else {
          $slot,$reason=$case.Split('-')
          $check=if($reason -ceq 'unsafe') {"$slot-template-helper-defect"} else {"$slot-template-identity"}
          Assert-Fails { Select-LifecycleSources }
          if($script:lifecycleCheck -cne $check -or (Test-Path -LiteralPath $env:GITHUB_OUTPUT)) { throw "Wrong template refusal stage or premature selection output for $case ($script:lifecycleCheck)." }
        }
      }
    } finally { $env:GITHUB_SHA,$env:GITHUB_RUN_ID,$env:GITHUB_REPOSITORY,$env:CURRENT_QUALITY_RUN,$env:PRIOR_QUALITY_RUN,$env:GITHUB_OUTPUT=$prev }
  }
  # No executable exists here. A start failure must never imply that the package ran.
  & {
    $prev=@($env:RUNNER_TEMP,$env:SystemRoot)
    try {
      $env:RUNNER_TEMP=$dir
      if(!$env:SystemRoot) { $env:SystemRoot=$dir }
      Assert-Fails { Invoke-GuestPackage (Join-Path $dir 'absent-setup.exe') }
      if($script:lifecycleCheck -cne 'silent-package-start') { throw 'Missing distinct package start refusal.' }
    } finally { $env:RUNNER_TEMP,$env:SystemRoot=$prev }
  }
  # Synthetic process and redirected streams. A deadline or drain failure cannot establish an exit result.
  & {
    $codes=@('pointer-layout','guard','known-folder','install-location','version','machine-install','running-check',
      'target-directory','payload-copy','helper-setup','helper-start','helper-wait','helper-result','handle-reset')
    $template=Get-Content -LiteralPath (Join-Path $PSScriptRoot '../apps/desktop/src-tauri/installer/installer.nsi') -Raw
    $assigned=@([regex]::Matches($template,'(?m)^\s*(?:SetErrorLevel|StrCpy \$ForgeResult) ([0-9]+)\b') |
      ForEach-Object { [int]$_.Groups[1].Value } | Where-Object { $_ -ge 40 } | Sort-Object -Unique)
    if(Compare-Object $assigned (40..53)) { throw 'Package exit assignments and verifier contract differ.' }
    $stream=[pscustomobject]@{task=[Threading.Tasks.Task]::CompletedTask}
    $stream | Add-Member ScriptMethod CopyToAsync { param($destination)
      if(![object]::ReferenceEquals($destination,[IO.Stream]::Null)) { throw 'Unexpected stream destination.' }
      return $this.task
    }
    $process=[pscustomobject]@{StandardOutput=@{BaseStream=$stream};StandardError=@{BaseStream=$stream};
      code=0;reads=0;waits=0;completed=$true;waitBudget=-1}
    $process | Add-Member ScriptMethod WaitForExit { param($budget)
      $this.waits++; $this.waitBudget=$budget; return $this.completed
    }
    $process | Add-Member ScriptProperty ExitCode { $this.reads++; return $this.code }
    # Starting/waiting already consumed the shared budget. No fixture sleeps or starts a process.
    $clock=@{ElapsedMilliseconds=75000L}
    function Assert-ProcessRefusal([bool]$current,[string]$check,[int]$reads) {
      $process.reads=0; $process.waits=0
      Assert-Fails { Wait-GuestPackageExit $process $clock $current }
      if($script:lifecycleCheck -cne $check -or $process.reads -ne $reads -or $process.waits -ne 1 -or $process.waitBudget -ne 0) { throw 'Wrong package refusal or settlement order.' }
    }
    for($i=0;$i -lt $codes.Length;$i++) {
      $process.code=40+$i
      Assert-ProcessRefusal $true ('package-'+$codes[$i]) 1
      Assert-ProcessRefusal $false 'silent-package-nonzero' 1
    }
    foreach($code in @([int]::MinValue,-1,1,2,39,54,55,56,[int]::MaxValue)) {
      $process.code=$code
      Assert-ProcessRefusal $true 'silent-package-nonzero' 1
    }
    $process.code=50
    $process.completed=$false
    Assert-ProcessRefusal $true 'silent-package-wait' 0
    $process.completed=$true
    $stream.task=[Threading.Tasks.TaskCompletionSource[bool]]::new().Task
    Assert-ProcessRefusal $true 'silent-package-drain' 0
    $stream.task=[Threading.Tasks.Task]::FromException([Exception]::new('untrusted fixture text'))
    Assert-ProcessRefusal $true 'silent-package-drain' 0
    $stream.task=[Threading.Tasks.Task]::CompletedTask
    foreach($unconfirmed in @($null,'40','untrusted fixture text')) {
      $process.code=$unconfirmed
      Assert-ProcessRefusal $true 'silent-package-exit-status' 1
    }
    $process.code=0; $process.reads=0
    Wait-GuestPackageExit $process $clock $true
    if($process.reads -ne 1) { throw 'Missing confirmed success.' }
  }
  # A mismatched prior approval must stop before even the portable transfer.
  & {
    $calls=@{downloads=0;catalog=0}
    function Invoke-ForgeApi([string]$Path) {
      $calls.catalog++
      if($Path -cne 'actions/runs/12/artifacts?per_page=100') { throw 'Bad fixture query.' }
      return $catalog
    }
    function Receive-ForgeArtifact { $calls.downloads++; throw 'Unexpected transfer.' }
    Assert-Fails { Export-ForgeCandidatePair $expected (Join-Path $dir 'refused-prior') -ApprovedInstallerArchiveSha256 ('e'*64) }
    if($calls.catalog -ne 1 -or $calls.downloads -ne 0) { throw 'Wrong prior packet consumed a transfer.' }
  }
  # The normal Verify path publishes evidence only after both exports, the approved setup, and the main recheck.
  & {
    $calls=@{exports=0;projections=0}
    function Get-ForgeReleaseContext { @{sha='a'*40;version='1.0.0-rc.2'} }
    function Get-ForgeQualifiedSource { @{sha='b'*40;version='1.0.0-rc.1'} }
    function git { $global:LASTEXITCODE=0; 'b'*40 }
    function Export-ForgeCandidatePair($Expected,$Directory,$ApprovedInstallerArchiveSha256) {
      $calls.exports++
      if($case -ceq 'prior-refused') { throw 'Prior pair refused.' }
      $hash=if($Expected.version -ceq '1.0.0-rc.1') {'2'*64} elseif($case -ceq 'current-mismatch') {'e'*64} else {$env:CURRENT_SETUP_SHA256}
      @{pair=@{installer=@{installer=@{sha256=$hash}}}}
    }
    function Write-ForgeJson { }
    function Invoke-ForgeApi { @{object=@{sha=if($case -ceq 'main-moved') {'c'*40} else {'a'*40}}} }
    function Get-VerifiedManifestFacts($Pairs) { $calls.projections++; @{prior=@{setupSha256=$Pairs.prior.installer.installer.sha256}} }
    $prev=@($env:GITHUB_OUTPUT,$env:GITHUB_STEP_SUMMARY,$env:CURRENT_SETUP_SHA256)
    $null=New-Item -ItemType Directory -Path (Join-Path $dir 'prior-candidate-source')
    Push-Location -LiteralPath $dir
    try {
      $env:CURRENT_SETUP_SHA256='1'*64
      $env:GITHUB_OUTPUT=Join-Path $dir 'synthetic-output'
      $env:GITHUB_STEP_SUMMARY=Join-Path $dir 'synthetic-verify-summary'
      foreach($case in @('prior-refused','current-mismatch','main-moved','success')) {
        $calls.exports=0
        if($case -cne 'success') {
          Assert-Fails { Save-VerifiedPackages (Join-Path $dir $case) }
          if($calls.projections -ne 0 -or (Test-Path -LiteralPath $env:GITHUB_OUTPUT) -or (Test-Path -LiteralPath $env:GITHUB_STEP_SUMMARY)) { throw 'Premature manifest evidence.' }
        } else {
          Save-VerifiedPackages (Join-Path $dir $case) 6>$null
          $priorHash='2'*64
          $summary='Verified public manifest facts {"prior":{"setupSha256":"'+$priorHash+'"}}'
          if($calls.exports -ne 2 -or $calls.projections -ne 1 -or (Get-Content -LiteralPath $env:GITHUB_OUTPUT) -cne ('prior_setup_sha256='+$priorHash) -or (Get-Content -LiteralPath $env:GITHUB_STEP_SUMMARY) -cne $summary) { throw 'Missing verified manifest evidence.' }
        }
      }
    } finally { Pop-Location; $env:GITHUB_OUTPUT,$env:GITHUB_STEP_SUMMARY,$env:CURRENT_SETUP_SHA256=$prev }
  }
  $path=Join-Path $dir 'agent-forge-desktop.exe'
  [IO.File]::WriteAllText($path,'inert file for hashing only')
  $hash=Get-ForgeHash $path
  $package=@{main=$hash;files=@(@{path='agent-forge-desktop.exe';sha256=('b'*64)},@{path='MANUAL-TESTING.md';sha256=('c'*64)})}
  Assert-InstalledFiles $package $dir
  $package.main='c'*64
  Assert-Fails { Assert-InstalledFiles $package $dir }
  $package.files=@(@{path='../foreign';sha256=$hash})
  Assert-Fails { Assert-InstalledFiles $package $dir }
  $manifest=Join-Path $dir 'startup-generations.json'
  $gen=[guid]::NewGuid().ToString()
  $state=@{version=1;pending=$null;generations=@(@{generation=$gen;state='active'})}
  [IO.File]::WriteAllText($manifest,($state | ConvertTo-Json -Depth 5))
  if((Get-ActiveGeneration $dir active) -cne $gen) { throw 'Missing expected generation.' }
  Assert-Fails { Get-ActiveGeneration $dir retired $gen }
  $state.generations[0].state='retired'
  [IO.File]::WriteAllText($manifest,($state | ConvertTo-Json -Depth 5))
  Get-ActiveGeneration $dir retired $gen
  Assert-Fails { Get-ActiveGeneration $dir active }
  Assert-Fails { Get-ActiveGeneration $dir retired ([guid]::NewGuid().ToString()) }
  $state.generations[0].identity=@{command='fixture-owned';principal='fixture-principal'}
  [IO.File]::WriteAllText($manifest,($state | ConvertTo-Json -Depth 6))
  Get-ActiveGeneration $dir retired $gen 'fixture-owned' 'fixture-principal' @($gen)
  Assert-Fails { Get-ActiveGeneration $dir retired $gen 'fixture-owned' 'foreign-principal' }
  Assert-Fails { Get-ActiveGeneration $dir retired $gen 'foreign-command' 'fixture-principal' }
  Assert-Fails { Get-ActiveGeneration $dir retired $gen 'fixture-owned' 'fixture-principal' @([guid]::NewGuid().ToString()) }
  $state.pending=@{operation='retire'}
  [IO.File]::WriteAllText($manifest,($state | ConvertTo-Json -Depth 5))
  Assert-Fails { Get-ActiveGeneration $dir retired $gen }
  $residual=Join-Path $dir 'simulated-install'
  $oldDir=Join-Path $residual 'assets'
  $null=New-Item -ItemType Directory -Path $oldDir -Force
  $oldPath=Join-Path $oldDir 'old-resource.txt'
  [IO.File]::WriteAllText($oldPath,'old')
  $old=@{files=@(@{path='assets/old-resource.txt';bytes=3;sha256=(Get-ForgeHash $oldPath)})}
  $new=@{files=@(@{path='main.txt';bytes=3;sha256=$old.files[0].sha256})}
  $facts=Get-RemovalFacts $residual $new $old
  if($facts.priorOnlyExact -ne 1 -or $facts.priorDirectories -ne 1) { throw 'Prior-only bytes misclassified.' }
  Assert-RemovalFacts $facts $true
  Assert-Fails { Assert-CompleteRemoval $facts }
  Assert-CompleteRemoval (Get-RemovalFacts (Join-Path $dir 'absent-install') $new $old)
  # Exercise the normal uninstall reporting path with an inert filesystem and an untouched earlier payload.
  & {
    function Invoke-GuestPackage([string]$Path) { }
    function Get-ActiveGeneration { }
    function Assert-PreservedGuest { }
    $guest=@{dir=$residual;uninstaller=(Join-Path $residual 'uninstall.exe');uninstall=(Join-Path $dir 'absent-registration')}
    $priorSummary=$env:GITHUB_STEP_SUMMARY
    try {
      $env:GITHUB_STEP_SUMMARY=Join-Path $dir 'synthetic-summary.txt'
      $script:lifecyclePhase='upgrade-uninstall'
      Assert-Fails { Uninstall-GuestPackage $guest 'second' 'inert foreign value' $new $old @('first') 6>$null }
      if($script:lifecycleCheck -cne 'complete-removal') { throw 'Wrong final uninstall failure.' }
      $summary=Get-Content -LiteralPath $env:GITHUB_STEP_SUMMARY -Raw
      foreach($field in @('"priorOnlyExact":1','"registrationAbsent":true','"verifiedRetiredGenerations":2','"productRunSlot":"foreign-value-preserved"','"unrelatedRunValuePreserved":true','"syntheticProfilePreserved":true','upgrade-uninstall complete removal failed.')) {
        if(!$summary.Contains($field)) { throw 'Missing partial uninstall evidence.' }
      }
      if($summary.Contains('complete removal passed') -or (Get-ForgeHash $oldPath) -cne $old.files[0].sha256) { throw 'Incorrect uninstall success or changed fixture payload.' }
    } finally { $env:GITHUB_STEP_SUMMARY=$priorSummary }
  }
  Assert-Fails { Assert-RemovalFacts $facts $false }
  [IO.File]::WriteAllText($oldPath,'bad')
  [IO.File]::WriteAllText((Join-Path $residual 'main.txt'),'old')
  [IO.File]::WriteAllText((Join-Path $residual 'foreign.txt'),'foreign')
  $facts=Get-RemovalFacts $residual $new $old
  if($facts.priorOnlyChanged -ne 1 -or $facts.currentExact -ne 1 -or $facts.foreignFiles -ne 1) { throw 'Residual modification misclassified.' }
  Assert-Fails { Assert-RemovalFacts $facts $true }
  $packet=Join-Path $dir 'current'
  $null=New-Item -ItemType Directory -Path $packet
  $name='Agent-Forge-Harness-1.0.0-rc.2-windows-x64-setup.exe'
  [IO.File]::Copy($path,(Join-Path $packet $name))
  $payload=@{installer=@{productVersion='1.0.0-rc.2';mainBinarySha256=$hash;installer=@{path=$name;sha256=$hash}};portable=@{files=@()}}
  Write-ForgeJson (Join-Path $packet 'verified-payload.json') $payload
  $verified=Get-PackageReceipt $dir current $hash
  if($verified.version -cne '1.0.0-rc.2' -or $verified.role -cne 'current') { throw 'Wrong inert package.' }
  & {
    $seen=[Collections.Generic.List[bool]]::new()
    function Invoke-GuestPackage([string]$Path,[switch]$CurrentSetup) {
      $seen.Add($CurrentSetup.IsPresent); throw 'Synthetic process boundary.'
    }
    Assert-Fails { Install-GuestPackage $verified @{} }
    $legacy=$verified.Clone(); $legacy.role='prior'
    Assert-Fails { Install-GuestPackage $legacy @{} }
    Assert-Fails { Uninstall-GuestPackage @{uninstaller=$verified.path} '' $null $null $null @() }
    if($seen.Count -ne 3 -or !$seen[0] -or $seen[1] -or $seen[2]) { throw 'Package exit meanings crossed the verified current setup boundary.' }
  }
  Assert-Fails { Get-PackageReceipt $dir current ('0'*64) }
  [IO.File]::WriteAllText((Join-Path $packet $name),'changed inert bytes')
  Assert-Fails { Get-PackageReceipt $dir current $hash }
} finally {
  $full=[IO.Path]::GetFullPath($dir)
  if([IO.Path]::GetDirectoryName($full) -cne $parent -or [IO.Path]::GetFileName($full) -cnotmatch '^forge-lifecycle-fixture-[0-9a-f]{32}$') { throw 'Unsafe fixture cleanup target.' }
  Remove-Item -LiteralPath $full -Recurse -Force
}
Write-Output 'Passed inert version, duplicate-run, prior archive approval, zero-transfer refusal, authenticated manifest reporting, package-process settlement, identity, payload, generation, exact Run-slot, and uninstall residue checks.'
