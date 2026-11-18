param(
  [ValidateSet('Library','Prepare','Draft')][string]$Mode = 'Library',
  [string]$RunId,
  [string]$OutputDirectory
)
$ErrorActionPreference = 'Stop'

function Assert-ForgeQuality($Run, $Jobs, $Expected) {
  if ($Expected.sha -cnotmatch '^[a-f0-9]{40}$' -or [string]$Run.id -cne [string]$Expected.runId -or
      $Run.head_sha -cne $Expected.sha -or $Run.head_branch -cne 'main' -or $Run.event -cne 'push' -or
      $Run.status -cne 'completed' -or $Run.conclusion -cne 'success' -or $Run.run_attempt -ne 1 -or
      $Run.path -cne '.github/workflows/quality.yml') { throw 'Expected a successful attempt-one normal Quality run at the accepted main commit.' }
  $names = @('checks','checks (windows)','Playwright (shard 1/3)','Playwright (shard 2/3)','Playwright (shard 3/3)','Playwright','Windows candidate / Windows portable candidate')
  if (@($Jobs).Count -ne 7) { throw 'Expected exactly seven Quality gates.' }
  foreach ($name in $names) {
    $found = @($Jobs | Where-Object { $_.name -ceq $name })
    if ($found.Count -ne 1 -or $found[0].status -cne 'completed' -or $found[0].conclusion -cne 'success') { throw 'A required Quality gate did not pass.' }
  }
}

function Assert-ForgeArchivePath([string]$Name) {
  if ([string]::IsNullOrEmpty($Name) -or $Name -match '[\x00-\x1f<>:"\\|?*\uFFFD]') { throw 'Unsafe archive path.' }
  foreach($part in $Name.Split('/')) {
    if (-not $part -or $part -in @('.','..') -or $part -match '[. ]$' -or $part -match '^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)') { throw 'Unsafe Windows archive segment.' }
  }
}

function Get-ForgeNsisMainBinaryHash([byte[]]$Bytes) {
  if($Bytes.Length -eq 0 -or $Bytes.Length -gt 67108864){throw 'Portable executable bound exceeded.'}
  $marker='__TAURI_BUNDLE_TYPE_VAR_UNK'
  $text=[Text.Encoding]::ASCII.GetString($Bytes)
  $offset=$text.IndexOf($marker,[StringComparison]::Ordinal)
  if($offset -lt 0 -or $text.IndexOf($marker,$offset+1,[StringComparison]::Ordinal) -ge 0 -or $text.Contains('__TAURI_BUNDLE_TYPE_VAR_NSS')){throw 'Unverified portable executable bundle marker.'}
  [byte[]]$patched=$Bytes.Clone()
  $replacement=[Text.Encoding]::ASCII.GetBytes('__TAURI_BUNDLE_TYPE_VAR_NSS')
  [Array]::Copy($replacement,0,$patched,$offset,$replacement.Length)
  return [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($patched)).ToLowerInvariant()
}

function Get-ForgeZipIndex {
  param([string]$Path, [ValidateRange(1,2147483648)][long]$RemainingBytes=2147483648, [ValidateRange(1,12000)][int]$RemainingEntries=12000)
  if ((Get-Item -LiteralPath $Path).Length -gt 1073741824) { throw 'Archive exceeds one GiB.' }
  $zip=[IO.Compression.ZipFile]::OpenRead($Path)
  try {
    if ($zip.Entries.Count -lt 1 -or $zip.Entries.Count -gt $RemainingEntries) { throw 'Archive entry bound exceeded.' }
    $names=[Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    $directories=[Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    $files=[Collections.Generic.Dictionary[string,object]]::new([StringComparer]::OrdinalIgnoreCase)
    $json=@{}; $nsisMainBinarySha256=$null; [long]$total=0; $buffer=[byte[]]::new(65536)
    foreach ($entry in $zip.Entries) {
      $name=$entry.FullName; $directory=$name.EndsWith('/'); if($directory){$name=$name.Substring(0,$name.Length-1)}
      Assert-ForgeArchivePath $name
      if (-not $names.Add($name) -or (($entry.ExternalAttributes -shr 16) -band 61440) -eq 40960 -or ($entry.ExternalAttributes -band 1024) -ne 0) { throw 'Duplicate or linked archive entry.' }
      $parts=$name.Split('/'); $parent=''
      for($i=0;$i -lt $parts.Length-1;$i++) {
        $parent=if($parent){$parent+'/'+$parts[$i]}else{$parts[$i]}
        if($files.ContainsKey($parent)){throw 'File-directory archive collision.'}
        $directories.Add($parent) | Out-Null
      }
      if($directory){
        if($entry.Length -ne 0 -or $files.ContainsKey($name)){throw 'Invalid archive directory.'}
        $directories.Add($name) | Out-Null; continue
      }
      if($directories.Contains($name)){throw 'File-directory archive collision.'}
      if($entry.Length -lt 0 -or $entry.Length -gt $RemainingBytes-$total){throw 'Uncompressed archive bound exceeded.'}
      $capture=$name -cin @('CANDIDATE.json','INSTALLER-CANDIDATE.json')
      $captureBinary=$name -ceq 'agent-forge-desktop.exe'
      if($capture -and $entry.Length -gt 4194304){throw 'Candidate manifest bound exceeded.'}
      if($captureBinary -and $entry.Length -gt 67108864){throw 'Portable executable bound exceeded.'}
      $stream=$entry.Open(); $hash=[Security.Cryptography.IncrementalHash]::CreateHash([Security.Cryptography.HashAlgorithmName]::SHA256)
      $memory=if($capture -or $captureBinary){[IO.MemoryStream]::new()}else{$null}; [long]$actual=0
      try {
        while(($read=$stream.Read($buffer,0,$buffer.Length)) -gt 0){
          $actual+=$read; $total+=$read
          if($total -gt $RemainingBytes -or $actual -gt $entry.Length){throw 'Streamed archive bound exceeded.'}
          $hash.AppendData($buffer,0,$read); if($memory){$memory.Write($buffer,0,$read)}
        }
        if($actual -ne $entry.Length){throw 'Truncated archive entry.'}
        $files.Add($name,@{path=$name;bytes=$actual;sha256=[Convert]::ToHexString($hash.GetHashAndReset()).ToLowerInvariant()})
        if($capture){$json[$name]=[Text.UTF8Encoding]::new($false,$true).GetString($memory.ToArray())}
        if($captureBinary){$nsisMainBinarySha256=Get-ForgeNsisMainBinaryHash $memory.ToArray()}
      } finally { $stream.Dispose(); $hash.Dispose(); if($memory){$memory.Dispose()} }
    }
    return @{files=$files;json=$json;bytes=$total;entries=$zip.Entries.Count;nsisMainBinarySha256=$nsisMainBinarySha256}
  } finally { $zip.Dispose() }
}

function Assert-ForgeFileRow($Row, $Files) {
  Assert-ForgeArchivePath $Row.path
  if ($Row.sha256 -cnotmatch '^[a-f0-9]{64}$' -or ($Row.bytes -isnot [int] -and $Row.bytes -isnot [long]) -or $Row.bytes -lt 0 -or -not $Files.ContainsKey($Row.path)) { throw 'Invalid candidate file record.' }
  $actual=$Files[$Row.path]
  if($Row.path -cne $actual.path -or $Row.bytes -ne $actual.bytes -or $Row.sha256 -cne $actual.sha256){throw 'Candidate file bytes or hash mismatch.'}
}

function Assert-ForgeCandidatePair($Portable, $Installer, $Expected) {
  try {
    $p=$Portable.json['CANDIDATE.json'] | ConvertFrom-Json -AsHashtable -ErrorAction Stop
    $i=$Installer.json['INSTALLER-CANDIDATE.json'] | ConvertFrom-Json -AsHashtable -ErrorAction Stop
  } catch { throw 'Missing or malformed candidate manifest.' }
  if($p.kind -cne 'portable-engineering-candidate' -or $i.kind -cne 'unsigned-nsis-engineering-candidate' -or $Expected.version -cnotmatch '^1[.]0[.]0-rc[.][1-9][0-9]*$'){throw 'Only a 1.0 release candidate can be staged.'}
  if($p.schemaVersion -ne 1 -or $i.schemaVersion -ne 2){throw 'Candidate manifest schema mismatch.'}
  foreach($manifest in @($p,$i)) {
    if($manifest.sourceCommit -cne $Expected.sha -or $manifest.sourceTree -cne $Expected.tree -or $manifest.engineCommit -cne $Expected.engine -or $manifest.productVersion -cne $Expected.version -or $manifest.desktopSourceDigest -cne $Expected.sourceDigest -or [string]$manifest.runId -cne [string]$Expected.runId -or [string]$manifest.runAttempt -cne '1' -or $manifest.nativeAppLaunched -isnot [bool] -or $manifest.nativeAppLaunched -ne $false -or $manifest.manualAcceptance -cne 'pending'){throw 'Candidate source identity or acceptance mismatch.'}
  }
  if($p.platform -cne 'windows-x64' -or $p.installerBuilt -isnot [bool] -or $p.installerBuilt -ne $false -or $i.installerBuilt -ne $true -or $i.installerBuilt -isnot [bool] -or $i.releaseDisposition -cne 'hold' -or @($i.holds).Count -ne 3 -or @($i.holds | Where-Object {$_ -isnot [string] -or -not $_.Trim()}).Count -ne 0){throw 'Candidate release holds changed.'}
  foreach($field in @('signed','installerExecuted')){if($i[$field] -isnot [bool] -or $i[$field] -ne $false){throw 'Unsigned, unexecuted installer required.'}}
  $rows=@($p.files); $seen=[Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
  if($rows.Count -lt 10 -or $rows.Count -gt 10000 -or $Portable.files.Count -ne $rows.Count+1){throw 'Portable file set mismatch.'}
  foreach($row in $rows){
    if($row.path -ceq 'CANDIDATE.json' -or -not $seen.Add($row.path)){throw 'Duplicate candidate file record.'}
    Assert-ForgeFileRow $row $Portable.files
  }
  $required=@('LICENSE','NOTICE','THIRD-PARTY-NOTICES.txt','DISTRIBUTION-NOTICES.txt','DISTRIBUTION-INVENTORY.json','RUNTIME-DEPENDENCY-INVENTORY.json','COMPILED-DEPENDENCY-INVENTORY.json','.claude/skills/ATTRIBUTION.md','docs/fonts/LICENSE-Inter.txt','agent-forge-desktop.exe','desktop-host.exe','hearth.exe','dashboard/index.html','MANUAL-TESTING.md')
  foreach($path in $required){if(-not $seen.Contains($path)){throw 'Missing required portable payload or notice.'}}
  if(@($rows | Where-Object {$_.path.StartsWith('legal/')}).Count -eq 0){throw 'Missing original legal texts.'}
  if($Portable.files['MANUAL-TESTING.md'].sha256 -cne $Expected.manualSha256 -or $i.templateSha256 -cne $Expected.templateSha256 -or $i.portableSnapshotSha256 -cne $Portable.files['CANDIDATE.json'].sha256 -or $i.portableMainBinarySha256 -cne $Portable.files['agent-forge-desktop.exe'].sha256){throw 'Installer source or portable snapshot mismatch.'}
  if($i.mainBinaryVerification -cne 'extracted-nsis-payload-v1' -or $Portable.nsisMainBinarySha256 -cnotmatch '^[a-f0-9]{64}$' -or $i.mainBinarySha256 -cne $Portable.nsisMainBinarySha256){throw 'Installer NSIS executable identity mismatch.'}
  $sidecars=@($i.sidecars)
  if($sidecars.Count -ne 2){throw 'Sidecar set mismatch.'}
  foreach($path in @('desktop-host.exe','hearth.exe')){
    $sidecar=@($sidecars | Where-Object {$_.path -ceq $path})
    if($sidecar.Count -ne 1 -or $sidecar[0].sha256 -cne $Portable.files[$path].sha256){throw 'Sidecar hash mismatch.'}
  }
  $resources=@($rows | Where-Object {$_.path -notin @('agent-forge-desktop.exe','desktop-host.exe','hearth.exe','MANUAL-TESTING.md') -and -not $_.path.StartsWith('dashboard/')})
  if(@($i.resourceFiles).Count -ne $resources.Count){throw 'Installer notice resource set mismatch.'}
  $resourceSeen=[Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
  foreach($row in $i.resourceFiles){
    if(-not $resourceSeen.Add($row.path) -or @($resources | Where-Object {$_.path -ceq $row.path}).Count -ne 1){throw 'Unexpected installer resource.'}
    Assert-ForgeFileRow $row $Portable.files
  }
  $setup='Agent-Forge-Harness-'+$Expected.version+'-windows-x64-setup.exe'
  if($i.installer.path -cne $setup){throw 'Unexpected installer name.'}
  Assert-ForgeFileRow $i.installer $Installer.files
  $inputs=@($i.compilerInputs)
  if($inputs.Count -lt 1 -or $inputs.Count -gt 32 -or $Installer.files.Count -ne $inputs.Count+6){throw 'Installer review file set mismatch.'}
  $inputSeen=[Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
  foreach($row in $inputs){
    if($row.path -cnotmatch '^compiler-inputs/[A-Za-z0-9_.-]+[.]nsh$' -or $row.bytes -gt 524288 -or -not $inputSeen.Add($row.path)){throw 'Invalid compiler input.'}
    Assert-ForgeFileRow $row $Installer.files
  }
  $reviewHashes=@{'installer.nsi'=$i.renderedScriptSha256;'bundle-config.json'=$i.overlaySha256;'INSTALLER-SOURCE.json'=$Expected.installerSourceSha256;'INSTALLER-TESTING.md'=$Expected.installerTestingSha256}
  foreach($path in $reviewHashes.Keys){if(-not $Installer.files.ContainsKey($path) -or $reviewHashes[$path] -cnotmatch '^[a-f0-9]{64}$' -or $Installer.files[$path].sha256 -cne $reviewHashes[$path]){throw 'Installer review input hash mismatch.'}}
  return @{portable=$p;installer=$i}
}

function New-ForgeDraftPayload($Catalog, $Tags, $Expected) {
  if($Expected.tag -cnotmatch '^v1[.]0[.]0-rc[.][1-9][0-9]*$' -or $Expected.sha -cnotmatch '^[a-f0-9]{40}$' -or [string]$Expected.runId -cnotmatch '^[1-9][0-9]*$'){throw 'Invalid release intent identity.'}
  if(@($Catalog).Count -ge 100 -or @($Tags).Count -ge 100){throw 'Release or tag catalog requires separate review.'}
  if(@($Catalog|Where-Object {$_.tag_name -ceq $Expected.tag}).Count -gt 0 -or @($Tags|Where-Object {$_.ref -ceq ('refs/tags/'+$Expected.tag)}).Count -gt 0){throw 'Existing release or tag; preserve it and investigate.'}
  return [ordered]@{
    tag_name=$Expected.tag;target_commitish=$Expected.sha
    name=('Agent Forge Desktop '+$Expected.tag+' — unsigned engineering review')
    body=('Unpublished engineering review candidate from source '+$Expected.sha+'. Quality run: https://github.com/jupes/agent-forge-desktop/actions/runs/'+$Expected.runId+'. Read RELEASE-REVIEW.json and included testing guides. Unsigned; signing/channel provisioning, installer runtime, upgrade/uninstall, human/manual acceptance and complete runtime redistribution/source-relink obligations remain pending. This draft does not establish stable 1.0 readiness.')
    draft=$true;prerelease=$true;make_latest='false';generate_release_notes=$false
  }
}

function Assert-ForgeUploadedRelease($Release, $Assets, $Intent) {
  if($Release.draft -isnot [bool] -or $Release.draft -ne $true -or $Release.prerelease -isnot [bool] -or $Release.prerelease -ne $true -or $null -ne $Release.published_at -or $Release.tag_name -cne $Intent.tag -or $Release.target_commitish -cne $Intent.sha){throw 'Release must remain an unpublished prerelease at the exact source.'}
  if(@($Assets).Count -ne 5 -or @($Intent.assets).Count -ne 5){throw 'Release asset set mismatch.'}
  foreach($expected in $Intent.assets){
    $found=@($Assets|Where-Object {$_.name -ceq $expected.name})
    if($found.Count -ne 1 -or $found[0].state -cne 'uploaded' -or $found[0].size -ne $expected.bytes -or $found[0].digest -cne ('sha256:'+$expected.sha256)){throw 'Release asset size or server digest is unverified.'}
  }
}

function Write-ForgeJson([string]$Path, $Value) {
  $bytes=[Text.UTF8Encoding]::new($false).GetBytes(($Value|ConvertTo-Json -Depth 24)+[Environment]::NewLine)
  $stream=[IO.File]::Open($Path,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
  try{$stream.Write($bytes,0,$bytes.Length)}finally{$stream.Dispose()}
}
function Get-ForgeHash([string]$Path) { return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() }
function Invoke-ForgeApi([string]$Path, [ValidateSet('GET','POST')][string]$Method='GET', $Body=$null) {
  $params=@{Uri=('https://api.github.com/repos/jupes/agent-forge-desktop/'+$Path);Method=$Method;Headers=@{Authorization=('Bearer '+$env:GH_TOKEN);Accept='application/vnd.github+json';'X-GitHub-Api-Version'='2022-11-28'};TimeoutSec=60;MaximumRedirection=0;SkipHttpErrorCheck=$true}
  if($Method -eq 'POST'){$params.ContentType='application/json';$params.Body=($Body|ConvertTo-Json -Depth 12 -Compress)}
  try{$response=Invoke-WebRequest @params}catch{throw 'GitHub request outcome unknown; preserve evidence and investigate before retrying.'}
  $status=if($Method -eq 'POST'){201}else{200}
  if($response.StatusCode -ne $status -or $response.Content.Length -gt 4194304){throw 'GitHub response status or metadata bound mismatch; do not blindly retry.'}
  try{return $response.Content|ConvertFrom-Json -AsHashtable -ErrorAction Stop}catch{throw 'GitHub returned malformed metadata.'}
}
function Get-ForgeReleaseContext([string]$QualityRunId) {
  if($env:GITHUB_ACTIONS -cne 'true' -or $env:GITHUB_REPOSITORY -cne 'jupes/agent-forge-desktop' -or $env:GITHUB_REF -cne 'refs/heads/main' -or $env:GITHUB_EVENT_NAME -cne 'workflow_dispatch' -or $env:GITHUB_SHA -cnotmatch '^[a-f0-9]{40}$' -or -not $env:GH_TOKEN -or $QualityRunId -cnotmatch '^[1-9][0-9]*$'){throw 'Release staging requires an explicit authenticated default-main GitHub runner.'}
  $head=(& git -c maintenance.auto=false -c gc.auto=0 rev-parse HEAD)
  if($LASTEXITCODE -ne 0 -or $head -cne $env:GITHUB_SHA){throw 'Checkout identity mismatch.'}
  $tree=(& git -c maintenance.auto=false -c gc.auto=0 rev-parse 'HEAD^{tree}')
  if($LASTEXITCODE -ne 0 -or $tree -cnotmatch '^[a-f0-9]{40}$'){throw 'Checkout tree unavailable.'}
  $ref=Invoke-ForgeApi 'git/ref/heads/main'
  if($ref.object.sha -cne $head){throw 'Default main moved; select its completed normal Quality run.'}
  $run=Invoke-ForgeApi ('actions/runs/'+$QualityRunId)
  $jobs=Invoke-ForgeApi ('actions/runs/'+$QualityRunId+'/attempts/1/jobs?per_page=100')
  if($jobs.total_count -ne 7){throw 'Quality job catalog mismatch.'}
  Assert-ForgeQuality $run $jobs.jobs @{sha=$head;runId=$QualityRunId}
  $metadata=Get-Content -LiteralPath '.work/desktop/.forge-desktop-source.json' -Raw|ConvertFrom-Json -AsHashtable
  $lock=Get-Content -LiteralPath 'engine.lock.json' -Raw|ConvertFrom-Json -AsHashtable
  $package=Get-Content -LiteralPath 'package.json' -Raw|ConvertFrom-Json -AsHashtable
  if($metadata.desktopCommit -cne $head -or $metadata.engineCommit -cne $lock.commit -or $metadata.desktopVersion -cne $package.version -or $metadata.sourceDigest -cnotmatch '^[a-f0-9]{64}$' -or $package.version -cnotmatch '^1[.]0[.]0-rc[.][1-9][0-9]*$'){throw 'Prepared desktop source mismatch.'}
  return @{sha=$head;tree=$tree;engine=$lock.commit;sourceDigest=$metadata.sourceDigest;version=$package.version;runId=$QualityRunId;tag=('v'+$package.version);templateSha256=(Get-ForgeHash 'apps/desktop/src-tauri/installer/installer.nsi');installerSourceSha256=(Get-ForgeHash 'apps/desktop/src-tauri/installer/SOURCE.json');installerTestingSha256=(Get-ForgeHash 'apps/desktop/docs/manual-installer-candidate.md');manualSha256=(Get-ForgeHash 'apps/desktop/docs/manual-1.0-candidate.md')}
}
function Receive-ForgeArtifact($Artifact, [string]$Destination) {
  if($Artifact.id -isnot [long] -and $Artifact.id -isnot [int]){throw 'Invalid artifact identifier.'}
  if($Artifact.expired -ne $false -or $Artifact.size_in_bytes -gt 1073741824 -or $Artifact.size_in_bytes -le 0 -or $Artifact.digest -cnotmatch '^sha256:[a-f0-9]{64}$'){throw 'Unbounded, expired or undigested artifact.'}
  $handler=[Net.Http.HttpClientHandler]::new();$handler.AllowAutoRedirect=$false
  $client=[Net.Http.HttpClient]::new($handler);$cancel=[Threading.CancellationTokenSource]::new(180000)
  try {
    $request=[Net.Http.HttpRequestMessage]::new([Net.Http.HttpMethod]::Get,('https://api.github.com/repos/jupes/agent-forge-desktop/actions/artifacts/'+$Artifact.id+'/zip'))
    $request.Headers.Authorization=[Net.Http.Headers.AuthenticationHeaderValue]::new('Bearer',$env:GH_TOKEN)
    $request.Headers.UserAgent.ParseAdd('AgentForgeReleaseDraft/1.0');$request.Headers.Accept.ParseAdd('application/vnd.github+json')
    $redirect=$client.SendAsync($request,[Net.Http.HttpCompletionOption]::ResponseHeadersRead,$cancel.Token).GetAwaiter().GetResult()
    try{
      $location=$redirect.Headers.Location
      if([int]$redirect.StatusCode -ne 302 -or -not $location -or $location.Scheme -cne 'https' -or $location.DnsSafeHost -notmatch '(^|[.])(blob[.]core[.]windows[.]net|githubusercontent[.]com)$'){throw 'Unexpected artifact redirect.'}
    }finally{$redirect.Dispose();$request.Dispose()}
    # The signed storage request never receives the GitHub bearer token.
    $storage=[Net.Http.HttpRequestMessage]::new([Net.Http.HttpMethod]::Get,$location)
    $response=$client.SendAsync($storage,[Net.Http.HttpCompletionOption]::ResponseHeadersRead,$cancel.Token).GetAwaiter().GetResult()
    try {
      if([int]$response.StatusCode -ne 200 -or $response.Content.Headers.ContentLength -gt 1073741824){throw 'Artifact download response refused.'}
      $inputStream=$response.Content.ReadAsStream();$output=[IO.File]::Open($Destination,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
      try{
        $buffer=[byte[]]::new(65536);[long]$total=0
        while(($read=$inputStream.ReadAsync($buffer,0,$buffer.Length,$cancel.Token).GetAwaiter().GetResult()) -gt 0){
          $total+=$read;if($total -gt 1073741824){throw 'Artifact download exceeded one GiB.'};$output.Write($buffer,0,$read)
        }
      }finally{$inputStream.Dispose();$output.Dispose()}
    }finally{$response.Dispose();$storage.Dispose()}
  }finally{$cancel.Dispose();$client.Dispose();$handler.Dispose()}
  if(('sha256:'+(Get-ForgeHash $Destination)) -cne $Artifact.digest){throw 'Artifact archive digest mismatch.'}
}
function Assert-ForgeOutputDirectory([string]$Directory) {
  if(-not $env:RUNNER_TEMP){throw 'Runner temporary directory unavailable.'}
  $absolute=[IO.Path]::GetFullPath($Directory);$expected=[IO.Path]::GetFullPath((Join-Path $env:RUNNER_TEMP 'agent-forge-release-draft'))
  if($absolute -cne $expected){throw 'Unexpected release staging directory.'}
  return $absolute
}
function Initialize-ForgeDraft([string]$QualityRunId,[string]$Directory) {
  $expected=Get-ForgeReleaseContext $QualityRunId
  $directory=Assert-ForgeOutputDirectory $Directory
  if(Test-Path -LiteralPath $directory){throw 'Preserve existing staging evidence; do not overwrite.'}
  [IO.Directory]::CreateDirectory($directory)|Out-Null
  $all=Invoke-ForgeApi ('actions/runs/'+$QualityRunId+'/artifacts?per_page=100')
  if($all.total_count -ge 100){throw 'Artifact catalog exceeds bound.'}
  $downloads=@();$indexes=@();$remainingBytes=2147483648L;$remainingEntries=12000
  foreach($kind in @('desktop','installer')) {
    $name='agent-forge-'+$kind+'-'+$expected.version+'-windows-x64-'+$expected.sha
    $found=@($all.artifacts|Where-Object {$_.name -ceq $name})
    if($found.Count -ne 1 -or $found[0].workflow_run.head_sha -cne $expected.sha){throw 'Exact candidate artifact unavailable.'}
    $asset=if($kind -eq 'desktop'){'agent-forge-desktop-'+$expected.version+'-windows-x64.zip'}else{'agent-forge-installer-'+$expected.version+'-windows-x64-review.zip'}
    $path=Join-Path $directory $asset
    Receive-ForgeArtifact $found[0] $path
    $index=Get-ForgeZipIndex $path -RemainingBytes $remainingBytes -RemainingEntries $remainingEntries
    $remainingBytes-=$index.bytes;$remainingEntries-=$index.entries
    $indexes+=,$index;$downloads+=@{id=$found[0].id;name=$name;asset=$asset;sha256=(Get-ForgeHash $path)}
  }
  $pair=Assert-ForgeCandidatePair $indexes[0] $indexes[1] $expected
  $setup=$pair.installer.installer.path
  $zip=[IO.Compression.ZipFile]::OpenRead((Join-Path $directory $downloads[1].asset))
  try{
    $entry=@($zip.Entries|Where-Object {$_.FullName -ceq $setup})
    if($entry.Count -ne 1){throw 'Installer entry identity changed.'}
    $inputStream=$entry[0].Open();$output=[IO.File]::Open((Join-Path $directory $setup),[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
    try{$inputStream.CopyTo($output)}finally{$inputStream.Dispose();$output.Dispose()}
  }finally{$zip.Dispose()}
  if((Get-ForgeHash (Join-Path $directory $setup)) -cne $pair.installer.installer.sha256){throw 'Extracted installer hash mismatch.'}
  $review=@{schemaVersion=1;disposition='unpublished unsigned engineering review; stable1.0 acceptance remains held';source=$expected;qualityRun=('https://github.com/jupes/agent-forge-desktop/actions/runs/'+$QualityRunId);artifacts=$downloads;portable=$pair.portable;installer=$pair.installer;executed=$false}
  Write-ForgeJson (Join-Path $directory 'RELEASE-REVIEW.json') $review
  $names=@($downloads[0].asset,$downloads[1].asset,$setup,'RELEASE-REVIEW.json')
  $sums=@($names|ForEach-Object {(Get-ForgeHash (Join-Path $directory $_))+'  '+$_})
  [IO.File]::WriteAllLines((Join-Path $directory 'SHA256SUMS'),$sums,[Text.UTF8Encoding]::new($false));$names+='SHA256SUMS'
  $assets=@($names|ForEach-Object {$file=Get-Item -LiteralPath (Join-Path $directory $_);@{name=$_;bytes=$file.Length;sha256=(Get-ForgeHash $file.FullName)}})
  Write-ForgeJson (Join-Path $directory 'INTENT.json') @{schemaVersion=1;sha=$expected.sha;tree=$expected.tree;engine=$expected.engine;sourceDigest=$expected.sourceDigest;version=$expected.version;tag=$expected.tag;runId=$QualityRunId;draft=$true;prerelease=$true;make_latest='false';artifactDownloads=2;assets=$assets}
  return @{intent='INTENT.json';artifactDownloads=2;assets=5;executed=$false}
}
function Complete-ForgeDraft([string]$QualityRunId,[string]$Directory) {
  $expected=Get-ForgeReleaseContext $QualityRunId;$directory=Assert-ForgeOutputDirectory $Directory
  $intentPath=Join-Path $directory 'INTENT.json'
  if((Get-Item -LiteralPath $intentPath).Length -gt 4194304){throw 'Intent exceeds bound.'}
  $intent=Get-Content -LiteralPath $intentPath -Raw|ConvertFrom-Json -AsHashtable
  if($intent.schemaVersion -ne 1 -or $intent.sha -cne $expected.sha -or $intent.tree -cne $expected.tree -or $intent.engine -cne $expected.engine -or $intent.sourceDigest -cne $expected.sourceDigest -or $intent.tag -cne $expected.tag -or $intent.version -cne $expected.version -or [string]$intent.runId -cne $QualityRunId -or @($intent.assets).Count -ne 5 -or $intent.draft -ne $true -or $intent.prerelease -ne $true -or $intent.make_latest -cne 'false' -or $intent.artifactDownloads -ne 2){throw 'Preserved release intent identity mismatch.'}
  $seen=[Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
  foreach($asset in $intent.assets){
    if($asset.name -cnotmatch '^[A-Za-z0-9_.-]+$' -or -not $seen.Add($asset.name)){throw 'Unsafe or duplicate release asset name.'}
    Assert-ForgeFileRow @{path=$asset.name;bytes=$asset.bytes;sha256=$asset.sha256} @{($asset.name)=@{path=$asset.name;bytes=(Get-Item -LiteralPath (Join-Path $directory $asset.name)).Length;sha256=(Get-ForgeHash (Join-Path $directory $asset.name))}}
  }
  $catalog=Invoke-ForgeApi 'releases?per_page=100';$tags=Invoke-ForgeApi ('git/matching-refs/tags/'+$intent.tag)
  $body=New-ForgeDraftPayload $catalog $tags $expected
  Write-ForgeJson (Join-Path $directory 'CREATE-ATTEMPT.json') @{intentSha256=(Get-ForgeHash $intentPath);body=$body;state='attempt recorded before request; unknown outcomes require investigation'}
  $release=Invoke-ForgeApi 'releases' 'POST' $body
  if($release.id -isnot [long] -and $release.id -isnot [int]){throw 'Release creation outcome unknown; investigate before retrying.'}
  Write-ForgeJson (Join-Path $directory 'CREATED.json') @{id=$release.id;draft=$release.draft;prerelease=$release.prerelease;tag=$release.tag_name}
  if($release.draft -ne $true -or $release.prerelease -ne $true -or $null -ne $release.published_at -or $release.tag_name -cne $intent.tag -or $release.target_commitish -cne $intent.sha -or @($release.assets).Count -ne 0){throw 'Unexpected created release; stop without uploading.'}
  foreach($asset in $intent.assets){
    Write-ForgeJson (Join-Path $directory ('UPLOAD-ATTEMPT-'+$asset.name+'.json')) @{releaseId=$release.id;name=$asset.name;bytes=$asset.bytes;sha256=$asset.sha256;state='attempt recorded before request; no clobber or blind retry'}
    $uri='https://uploads.github.com/repos/jupes/agent-forge-desktop/releases/'+$release.id+'/assets?name='+[Uri]::EscapeDataString($asset.name)
    try{$response=Invoke-WebRequest -Uri $uri -Method Post -Headers @{Authorization=('Bearer '+$env:GH_TOKEN);Accept='application/vnd.github+json';'X-GitHub-Api-Version'='2022-11-28'} -ContentType 'application/octet-stream' -InFile (Join-Path $directory $asset.name) -TimeoutSec 180 -MaximumRedirection 0 -SkipHttpErrorCheck}catch{throw 'Upload outcome unknown; preserve the draft and investigate before retrying.'}
    if($response.StatusCode -ne 201){throw 'Upload was not confirmed; preserve the draft and investigate.'}
  }
  $final=Invoke-ForgeApi ('releases/'+$release.id);$assets=Invoke-ForgeApi ('releases/'+$release.id+'/assets?per_page=100')
  Assert-ForgeUploadedRelease $final $assets $intent
  Write-ForgeJson (Join-Path $directory 'VERIFIED.json') @{releaseId=$release.id;url=$final.html_url;draft=$true;prerelease=$true;published=$false;source=$intent.sha;assets=$intent.assets}
  ('Prepared unpublished engineering draft: '+$final.html_url+'. Installation, signing and human acceptance remain pending.')|Add-Content -LiteralPath $env:GITHUB_STEP_SUMMARY
  return @{releaseId=$release.id;url=$final.html_url;draft=$true;prerelease=$true;published=$false;assets=5}
}

if($Mode -ne 'Library') {
  try {
    if($PSVersionTable.PSVersion -lt [Version]'7.4'){throw 'PowerShell 7.4 or newer is required.'}
    $result=if($Mode -eq 'Prepare'){Initialize-ForgeDraft $RunId $OutputDirectory}else{Complete-ForgeDraft $RunId $OutputDirectory}
    @{ok=$true;data=$result;error=$null}|ConvertTo-Json -Depth 8 -Compress
  }catch{
    @{ok=$false;data=$null;error=('Release '+$Mode+' stopped. Preserve intent/effect evidence and investigate before retrying. Exception class: '+$_.Exception.GetType().Name)}|ConvertTo-Json -Compress|Write-Error -ErrorAction Continue
    exit 1
  }
}
