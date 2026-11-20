$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'installer-lifecycle.ps1') -Mode Library

function Assert-Fails([scriptblock]$Action) {
  try { & $Action } catch { return }
  throw 'Expected lifecycle assertion to reject the fixture.'
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
Write-Output 'Passed inert version, duplicate-run, prior archive approval, zero-transfer refusal, identity, payload, generation, exact Run-slot, and uninstall residue checks.'
