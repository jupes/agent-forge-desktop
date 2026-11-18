$ErrorActionPreference = 'Stop'
. "$PSScriptRoot/release-draft.ps1"
$script:Passed = 0
$script:Failed = 0
function Test-Case([string]$Name, [scriptblock]$Action) {
  try { & $Action; $script:Passed++; Write-Output "PASS $Name" }
  catch { $script:Failed++; Write-Output "FAIL $Name : $($_.Exception.Message)" }
}
function Assert-True($Value) { if ($Value -ne $true) { throw 'Assertion failed.' } }
function Assert-Throws([scriptblock]$Action) {
  $threw = $false
  try { & $Action | Out-Null } catch { $threw = $true }
  if (-not $threw) { throw 'Expected refusal.' }
}
function New-QualityFixture {
  $sha = 'a' * 40
  $names = @('checks','checks (windows)','Playwright (shard 1/3)','Playwright (shard 2/3)','Playwright (shard 3/3)','Playwright','Windows candidate / Windows portable candidate')
  return @{
    run = @{ id=123; head_sha=$sha; head_branch='main'; event='push'; status='completed'; conclusion='success'; run_attempt=1; path='.github/workflows/quality.yml' }
    jobs = @($names | ForEach-Object { @{ name=$_; status='completed'; conclusion='success' } })
    expected = @{ sha=$sha; runId='123' }
  }
}
Test-Case 'accepted default-main normal run has all seven gates' {
  $f=New-QualityFixture; Assert-ForgeQuality $f.run $f.jobs $f.expected
}
Test-Case 'PR, dispatch, retry, stale head and missing or skipped gate are refused' {
  foreach ($change in @(@{event='pull_request'},@{event='workflow_dispatch'},@{run_attempt=2},@{head_sha=('b'*40)},@{head_branch='other'},@{path='.github/workflows/other.yml'},@{status='in_progress'},@{id=124})) {
    $f=New-QualityFixture; foreach($key in $change.Keys){$f.run[$key]=$change[$key]}; Assert-Throws { Assert-ForgeQuality $f.run $f.jobs $f.expected }
  }
  $f=New-QualityFixture; Assert-Throws { Assert-ForgeQuality $f.run $f.jobs[0..5] $f.expected }
  $f.jobs[0].conclusion='skipped'; Assert-Throws { Assert-ForgeQuality $f.run $f.jobs $f.expected }
}

function With-Archive($Rows, [scriptblock]$Action) {
  $ownedRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../.tmp'))
  $directory = Join-Path $ownedRoot ('release-draft-fixture-' + [Guid]::NewGuid().ToString('N'))
  [IO.Directory]::CreateDirectory($directory) | Out-Null
  $path = Join-Path $directory 'inert.zip'
  try {
    $zip = [IO.Compression.ZipFile]::Open($path, [IO.Compression.ZipArchiveMode]::Create)
    try { foreach($row in $Rows) {
      $entry=$zip.CreateEntry($row.name); if($row.ContainsKey('attributes')){$entry.ExternalAttributes=$row.attributes}
      $stream=$entry.Open(); try { $bytes=[Text.Encoding]::UTF8.GetBytes($row.content); $stream.Write($bytes,0,$bytes.Length) } finally { $stream.Dispose() }
    }} finally { $zip.Dispose() }
    & $Action $path
  } finally {
    $resolved=[IO.Path]::GetFullPath($directory)
    if ([IO.Path]::GetDirectoryName($resolved) -cne $ownedRoot -or [IO.Path]::GetFileName($resolved) -notmatch '^release-draft-fixture-[a-f0-9]{32}$') { throw 'Unsafe fixture cleanup target.' }
    Remove-Item -LiteralPath $resolved -Recurse -Force
  }
}
Test-Case 'archive indexing hashes actual bytes and retains only bounded manifest text' {
  With-Archive @(@{name='file.txt';content='abc'},@{name='CANDIDATE.json';content='{}'}) { param($path)
    $index=Get-ForgeZipIndex $path
    Assert-True ($index.files.Count -eq 2 -and $index.bytes -eq 5 -and $index.entries -eq 2)
    Assert-True ($index.files['file.txt'].sha256 -ceq 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
    Assert-True ($index.json['CANDIDATE.json'] -ceq '{}')
  }
}
Test-Case 'unsafe, absolute, backslash and Windows-reserved archive paths refuse' {
  foreach($name in @('../escape','/absolute','C:/drive','dir\escape','nul.txt','bad./file','a//b','a:stream')) {
    With-Archive @(@{name=$name;content='inert'}) { param($path) Assert-Throws { Get-ForgeZipIndex $path } }
  }
}
Test-Case 'case collisions, linked entries and file-directory aliases refuse' {
  With-Archive @(@{name='A';content='a'},@{name='a';content='b'}) { param($path) Assert-Throws { Get-ForgeZipIndex $path } }
  With-Archive @(@{name='link';content='target';attributes=[int]-1610612736}) { param($path) Assert-Throws { Get-ForgeZipIndex $path } }
  With-Archive @(@{name='a/b';content='x'},@{name='a';content='x'}) { param($path) Assert-Throws { Get-ForgeZipIndex $path } }
}
Test-Case 'aggregate byte and entry limits cannot be raised' {
  With-Archive @(@{name='a';content='abc'},@{name='b';content='def'}) { param($path)
    Assert-Throws { Get-ForgeZipIndex $path -RemainingBytes 5 }
    Assert-Throws { Get-ForgeZipIndex $path -RemainingEntries 1 }
    Assert-Throws { Get-ForgeZipIndex $path -RemainingBytes 2147483649 }
    Assert-Throws { Get-ForgeZipIndex $path -RemainingEntries 12001 }
  }
}

function New-PairFixture {
  $sha='a'*40; $hash='b'*64; $version='1.0.0-rc.1'
  $required=@('LICENSE','NOTICE','THIRD-PARTY-NOTICES.txt','DISTRIBUTION-NOTICES.txt','DISTRIBUTION-INVENTORY.json','RUNTIME-DEPENDENCY-INVENTORY.json','COMPILED-DEPENDENCY-INVENTORY.json','.claude/skills/ATTRIBUTION.md','docs/fonts/LICENSE-Inter.txt','legal/original.txt','agent-forge-desktop.exe','desktop-host.exe','hearth.exe','dashboard/index.html','MANUAL-TESTING.md')
  $files=[Collections.Generic.Dictionary[string,object]]::new([StringComparer]::OrdinalIgnoreCase)
  foreach($path in $required){$files.Add($path,@{path=$path;bytes=1;sha256=$hash})}
  $p=@{schemaVersion=1;kind='portable-engineering-candidate';productVersion=$version;sourceCommit=$sha;sourceTree=('c'*40);engineCommit=('d'*40);desktopSourceDigest=('e'*64);runId='123';runAttempt='1';platform='windows-x64';nativeAppLaunched=$false;installerBuilt=$false;manualAcceptance='pending';files=@($files.Values)}
  $pjson=$p | ConvertTo-Json -Depth 12 -Compress
  $phash=[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($pjson))).ToLowerInvariant()
  $files.Add('CANDIDATE.json',@{path='CANDIDATE.json';bytes=[Text.Encoding]::UTF8.GetByteCount($pjson);sha256=$phash})
  $setup="Agent-Forge-Harness-$version-windows-x64-setup.exe"
  $i=@{schemaVersion=1;kind='unsigned-nsis-engineering-candidate';productVersion=$version;sourceCommit=$sha;sourceTree=('c'*40);engineCommit=('d'*40);desktopSourceDigest=('e'*64);runId='123';runAttempt='1';installerBuilt=$true;installerExecuted=$false;nativeAppLaunched=$false;signed=$false;manualAcceptance='pending';releaseDisposition='hold';installer=@{path=$setup;bytes=1;sha256=$hash};templateSha256=('f'*64);mainBinarySha256=$hash;sidecars=@(@{path='desktop-host.exe';sha256=$hash},@{path='hearth.exe';sha256=$hash});compilerInputs=@(@{path='compiler-inputs/inert.nsh';bytes=1;sha256=$hash});renderedScriptSha256=$hash;overlaySha256=$hash;portableSnapshotSha256=$phash;resourceFiles=@($p.files | Where-Object {$_.path -notin @('agent-forge-desktop.exe','desktop-host.exe','hearth.exe','MANUAL-TESTING.md') -and -not $_.path.StartsWith('dashboard/')});holds=@('unsigned','manual pending','redistribution pending')}
  $ifiles=[Collections.Generic.Dictionary[string,object]]::new([StringComparer]::OrdinalIgnoreCase)
  foreach($path in @($setup,'installer.nsi','INSTALLER-SOURCE.json','INSTALLER-TESTING.md','bundle-config.json','compiler-inputs/inert.nsh','INSTALLER-CANDIDATE.json')){$ifiles.Add($path,@{path=$path;bytes=1;sha256=$hash})}
  return @{portable=@{files=$files;json=@{'CANDIDATE.json'=$pjson}};installer=@{files=$ifiles;json=@{'INSTALLER-CANDIDATE.json'=($i|ConvertTo-Json -Depth 12 -Compress)}};p=$p;i=$i;expected=@{sha=$sha;tree=('c'*40);engine=('d'*40);sourceDigest=('e'*64);version=$version;runId='123';templateSha256=('f'*64);installerSourceSha256=$hash;installerTestingSha256=$hash;manualSha256=$hash}}
}
function Update-InstallerFixture($Fixture) {$Fixture.installer.json['INSTALLER-CANDIDATE.json']=$Fixture.i|ConvertTo-Json -Depth 12 -Compress}
Test-Case 'portable and installer manifests agree with accepted source and all payload files' {
  $f=New-PairFixture; $pair=Assert-ForgeCandidatePair $f.portable $f.installer $f.expected
  Assert-True ($pair.portable.sourceCommit -ceq $f.expected.sha)
}
Test-Case 'stale source, engine, tree, version, run attempt and digest refuse' {
  foreach($change in @(@{sourceCommit=('9'*40)},@{engineCommit=('9'*40)},@{sourceTree=('9'*40)},@{productVersion='1.0.0'},@{runId='124'},@{runAttempt='2'},@{desktopSourceDigest=('9'*64)})){
    $f=New-PairFixture; foreach($key in $change.Keys){$f.i[$key]=$change[$key]}; Update-InstallerFixture $f
    Assert-Throws {Assert-ForgeCandidatePair $f.portable $f.installer $f.expected}
  }
}
Test-Case 'cleared holds, claimed signing or manual acceptance and launched binaries refuse' {
  foreach($change in @(@{signed=$true},@{manualAcceptance='passed'},@{releaseDisposition='release'},@{installerExecuted=$true},@{nativeAppLaunched=$true},@{holds=@()})){
    $f=New-PairFixture; foreach($key in $change.Keys){$f.i[$key]=$change[$key]}; Update-InstallerFixture $f
    Assert-Throws {Assert-ForgeCandidatePair $f.portable $f.installer $f.expected}
  }
}
Test-Case 'installer bytes, compiler inputs, main binary, sidecars and resource correspondence refuse mismatches' {
  foreach($kind in @('installer','compiler','main','sidecar','resource','snapshot','extra-portable','extra-installer','missing-notice')) {
    $f=New-PairFixture
    switch($kind){
      installer {$f.i.installer.sha256='9'*64}
      compiler {$f.i.compilerInputs[0].bytes=2}
      main {$f.i.mainBinarySha256='9'*64}
      sidecar {$f.i.sidecars[0].sha256='9'*64}
      resource {$f.i.resourceFiles[0].sha256='9'*64}
      snapshot {$f.i.portableSnapshotSha256='9'*64}
      extra-portable {$f.portable.files.Add('unexpected.exe',@{path='unexpected.exe';bytes=1;sha256=('9'*64)})}
      extra-installer {$f.installer.files.Add('unexpected.exe',@{path='unexpected.exe';bytes=1;sha256=('9'*64)})}
      missing-notice {$f.portable.files.Remove('LICENSE') | Out-Null}
    }
    Update-InstallerFixture $f; Assert-Throws {Assert-ForgeCandidatePair $f.portable $f.installer $f.expected}
  }
}

Test-Case 'new release intent always creates an unpublished prerelease with no latest promotion' {
  $e=@{tag='v1.0.0-rc.1';sha=('a'*40);runId='123'}
  $body=New-ForgeDraftPayload @() @() $e
  Assert-True ($body.draft -eq $true -and $body.prerelease -eq $true -and $body.make_latest -ceq 'false' -and $body.target_commitish -ceq $e.sha)
  Assert-Throws {New-ForgeDraftPayload @(@{tag_name=$e.tag}) @() $e}
  Assert-Throws {New-ForgeDraftPayload @() @(@{ref=('refs/tags/'+$e.tag)}) $e}
  Assert-Throws {New-ForgeDraftPayload (@(1..100|ForEach-Object {@{tag_name=('other'+$_)}})) @() $e}
}
Test-Case 'post-upload verification refuses publication, missing assets and unknown or mismatched digests' {
  $intent=@{tag='v1.0.0-rc.1';sha=('a'*40);assets=@(1..5|ForEach-Object {@{name=('inert'+$_);bytes=1;sha256=('b'*64)}})}
  $release=@{draft=$true;prerelease=$true;published_at=$null;tag_name=$intent.tag;target_commitish=$intent.sha}
  $assets=@($intent.assets|ForEach-Object {@{name=$_.name;size=$_.bytes;digest=('sha256:'+ $_.sha256);state='uploaded'}})
  Assert-ForgeUploadedRelease $release $assets $intent
  $release.draft=$false; Assert-Throws {Assert-ForgeUploadedRelease $release $assets $intent}; $release.draft=$true
  Assert-Throws {Assert-ForgeUploadedRelease $release $assets[0..3] $intent}
  $assets[0].digest=$null; Assert-Throws {Assert-ForgeUploadedRelease $release $assets $intent}
  $assets[0].digest='sha256:'+('c'*64); Assert-Throws {Assert-ForgeUploadedRelease $release $assets $intent}
}

Test-Case 'intent and effect journals cannot overwrite earlier evidence' {
  With-Archive @(@{name='inert';content='data'}) { param($path)
    $journal=$path+'.json'; Write-ForgeJson $journal @{schemaVersion=1;draft=$true}
    Assert-Throws {Write-ForgeJson $journal @{draft=$false}}
    $value=Get-Content -LiteralPath $journal -Raw|ConvertFrom-Json -AsHashtable
    Assert-True ($value.draft -eq $true -and $value.schemaVersion -eq 1)
  }
}

Test-Case 'manual workflow prepares and creates exactly once with preserved intent in between' {
  $workflow=Get-Content -LiteralPath (Join-Path $PSScriptRoot '../.github/workflows/release-draft.yml') -Raw
  $prepare=[regex]::Matches($workflow,'(?m)^\s+run: .+ -Mode Prepare\b')
  $draft=[regex]::Matches($workflow,'(?m)^\s+run: .+ -Mode Draft\b')
  Assert-True ($prepare.Count -eq 1 -and $draft.Count -eq 1)
  $intent=$workflow.IndexOf('INTENT.json')
  Assert-True ($prepare[0].Index -lt $intent -and $intent -lt $draft[0].Index)
}

if ($script:Failed -gt 0) { throw "$script:Failed failed; $script:Passed passed." }
Write-Output "$script:Passed passed; 0 failed."
