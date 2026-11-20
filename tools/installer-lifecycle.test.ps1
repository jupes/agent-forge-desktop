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
  if($verified.version -cne '1.0.0-rc.2') { throw 'Wrong inert package.' }
  Assert-Fails { Get-PackageReceipt $dir current ('0'*64) }
  [IO.File]::WriteAllText((Join-Path $packet $name),'changed inert bytes')
  Assert-Fails { Get-PackageReceipt $dir current $hash }
} finally {
  $full=[IO.Path]::GetFullPath($dir)
  if([IO.Path]::GetDirectoryName($full) -cne $parent -or [IO.Path]::GetFileName($full) -cnotmatch '^forge-lifecycle-fixture-[0-9a-f]{32}$') { throw 'Unsafe fixture cleanup target.' }
  Remove-Item -LiteralPath $full -Recurse -Force
}
Write-Output 'Passed inert version, duplicate-run, prior archive approval, zero-transfer refusal, authenticated manifest reporting, identity, payload, generation, exact Run-slot, and uninstall residue checks.'
