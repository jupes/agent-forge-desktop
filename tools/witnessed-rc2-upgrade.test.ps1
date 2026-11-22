#requires -Version 7.4
$ErrorActionPreference='Stop'
$root=Join-Path $PSScriptRoot '../apps/desktop/installer-tools'
$module=Import-Module (Join-Path $root 'WitnessedRc2Upgrade.psm1') -PassThru -ErrorAction Stop
& $module {
  function Assert-Refusal([scriptblock]$Action) {
    try { & $Action | Out-Null } catch { return }
    throw 'Expected witness policy refusal.'
  }
  function JsonBytes($Value) {
    return ,[Text.Encoding]::UTF8.GetBytes(($Value | ConvertTo-Json -Depth 12 -Compress))
  }
  $command='"C:\Fixture\agent-forge-desktop.exe" --from-login'
  $sid='S-1-5-21-100-200-300-1001'
  $id=@('f9b3b618-e50e-41e9-a283-a02ff6398057','da6f0ca0-9c75-4e14-ba49-5546c82ba17e')
  $op=@('415fe44c-d300-4af9-9085-5a51353f81d2','c3024315-9a07-4dc2-b673-9c4f30989d8b')
  $manifestName='startup-generations.json'
  $markerName='startup-generation.initialized'
  $latest='startup-generation-'+$op[1]+'-terminal.json'
  function New-PolicyFixture([switch]$Retired) {
    $rows=@(); $publications=@()
    for ($i=0; $i -lt 2; $i++) {
      $who=[ordered]@{principal=$sid;command=$command}
      $state=if ($i -eq 0 -or $Retired) {'retired'} else {'active'}
      $effect=if ($state -ceq 'active') {'activate'} else {'retire'}
      $intent=[ordered]@{operation_id=$op[$i];operation=$effect;identity=$who;generation=$id[$i];prior_sha256=('a'*64)}
      $rows+=@([ordered]@{identity=$who;generation=$id[$i];state=$state;receipt=$intent})
      $publications+=@([ordered]@{version=1;intent=$intent;phase=$state;revision=(4+$i*2);manifest_sha256=('b'*64)})
    }
    $manifest=[ordered]@{version=1;revision=6;generations=$rows;pending=$null}
    $raw=JsonBytes $manifest
    $publications[1].manifest_sha256=[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($raw)).ToLowerInvariant()
    $records=@{$markerName=[Text.Encoding]::ASCII.GetBytes("startup-generations-v1`n");$manifestName=$raw}
    for ($i=0; $i -lt 2; $i++) { $records['startup-generation-'+$op[$i]+'-terminal.json']=JsonBytes $publications[$i] }
    return $records
  }
  function Read-Fixture($Records, [switch]$BeforeInstall) {
    return Read-WitnessGeneration {
      param($Name,$AllowAbsentDirectory)
      if (!$Records.ContainsKey($Name)) {
        if ($AllowAbsentDirectory -and $Records.Count -eq 0) { return }
        throw 'Missing synthetic private record.'
      }
      return ,$Records[$Name]
    } $sid $command -BeforeInstall:$BeforeInstall
  }
  $records=New-PolicyFixture
  if ((Read-Fixture $records) -cne $id[1]) { throw 'Valid terminal activation refused.' }
  Assert-Refusal { Read-Fixture $records -BeforeInstall }
  # First activation has no preceding manifest digest. Rust persists null, not an empty string.
  $initial=[Text.Encoding]::UTF8.GetString($records[$manifestName]) | ConvertFrom-Json -AsHashtable
  $initial.generations=@($initial.generations[1]); $initial.revision=2
  $initial.generations[0].receipt.prior_sha256=$null
  $records[$manifestName]=JsonBytes $initial
  $initialReceipt=[Text.Encoding]::UTF8.GetString($records[$latest]) | ConvertFrom-Json -AsHashtable
  $initialReceipt.intent=$initial.generations[0].receipt; $initialReceipt.revision=2
  $initialReceipt.manifest_sha256=[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($records[$manifestName])).ToLowerInvariant()
  $records[$latest]=JsonBytes $initialReceipt
  if ((Read-Fixture $records) -cne $id[1]) { throw 'First confirmed activation refused.' }
  if ($null -ne (Read-Fixture @{} -BeforeInstall)) { throw 'Absent history should allow fresh install.' }
  $retired=New-PolicyFixture -Retired
  if ($null -ne (Read-Fixture $retired -BeforeInstall)) { throw 'Fully retired history refused.' }
  Assert-Refusal { Read-Fixture $retired }
  foreach ($name in @($markerName,$manifestName,$latest)) {
    $records=New-PolicyFixture
    $records.Remove($name)
    Assert-Refusal { Read-Fixture $records }
  }
  foreach ($change in @(
    {param($m) $m.Remove('revision')},
    {param($m) $m.revision=0},
    {param($m) $m.revision=9007199254740992},
    {param($m) $m.revision='6'},
    {param($m) $m.pending=@{}},
    {param($m) $m.extra='unknown'},
    {param($m) $m.generations=@($m.generations[0])*65},
    {param($m) $m.generations=@()},
    {param($m) $m.generations=@($m.generations[1],$m.generations[0])},
    {param($m) $m.generations[1].generation=$id[0]},
    {param($m) $m.generations[1].Remove('receipt')},
    {param($m) $m.generations[1].receipt.operation='retire'},
    {param($m) $m.generations[1].receipt.generation=$id[0]},
    {param($m) $m.generations[1].receipt.operation_id='bad'},
    {param($m) $m.generations[1].identity.principal='foreign'},
    {param($m) $m.generations[1].receipt.identity.command='foreign'},
    {param($m) $m.generations[1].receipt.prior_sha256='bad'}
  )) {
    $records=New-PolicyFixture
    $m=[Text.Encoding]::UTF8.GetString($records[$manifestName]) | ConvertFrom-Json -AsHashtable
    & $change $m
    $records[$manifestName]=JsonBytes $m
    # Preserve the latest hash so an invalid manifest cannot pass its semantic test by failing only on the digest.
    $t=[Text.Encoding]::UTF8.GetString($records[$latest]) | ConvertFrom-Json -AsHashtable
    $t.manifest_sha256=[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($records[$manifestName])).ToLowerInvariant()
    $records[$latest]=JsonBytes $t
    Assert-Refusal { Read-Fixture $records }
  }
  foreach ($change in @(
    {param($t) $t.phase='retired'},
    {param($t) $t.version=2},
    {param($t) $t.revision=4},
    {param($t) $t.revision=5},
    {param($t) $t.revision=7},
    {param($t) $t.Remove('intent')},
    {param($t) $t.intent.operation_id=$op[0]},
    {param($t) $t.intent.prior_sha256=$null},
    {param($t) $t.manifest_sha256='b'*64}
  )) {
    $records=New-PolicyFixture
    $t=[Text.Encoding]::UTF8.GetString($records[$latest]) | ConvertFrom-Json -AsHashtable
    & $change $t
    $records[$latest]=JsonBytes $t
    Assert-Refusal { Read-Fixture $records }
  }
  $records=New-PolicyFixture
  $records[$markerName]=[byte[]](0)
  Assert-Refusal { Read-Fixture $records }
  $records=New-PolicyFixture
  $records[$latest]=[byte[]]::new(8193)
  Assert-Refusal { Read-Fixture $records }
  $records=New-PolicyFixture
  $records[$manifestName]=[byte[]]::new(131073)
  Assert-Refusal { Read-Fixture $records }
  $records=New-PolicyFixture
  $records[$manifestName]=[Text.Encoding]::UTF8.GetBytes(([Text.Encoding]::UTF8.GetString($records[$manifestName])).Replace('"version":1','"version":1,"version":1'))
  Assert-Refusal { Read-Fixture $records }
}
'Witnessed RC2 activation policy fixtures passed.'
$ErrorActionPreference='Stop'
Add-Type -TypeDefinition @'
using System;
public sealed class InertWitness : IDisposable {
    public string Confirmation;
    public int DisposeCount;
    public void VerifyConfirmedPrior() {}
    public void Commit(string expected) { if (Confirmation != null) throw new InvalidOperationException(); Confirmation = expected; }
    public void Dispose() { DisposeCount++; }
}
'@
& $module {
  $events=[Collections.Generic.List[string]]::new()
  $id=[guid]::NewGuid().ToString()
  $different=[guid]::NewGuid().ToString()
  function Enter-WitnessPackageGuard { return [IO.MemoryStream]::new() }
  function Get-WitnessActivation([string]$Version) {
    $events.Add($Version)
    if($Version -ceq $case.changedGenerationAt){return $different}
    return $id
  }
  function Open-WitnessedSetup([string]$Path,[string]$Sha256) { return [IO.MemoryStream]::new() }
  function Invoke-WitnessedSetup([string]$Path) {
    $events.Add('setup')
    if($case.interrupted){throw 'Synthetic interrupted install'}
  }
  foreach($case in @(
    @{expected=@('1.0.0-rc.2','setup','1.0.0-rc.4');success=$true},
    @{changedGenerationAt='1.0.0-rc.2';expected=@('1.0.0-rc.2')},
    @{changedGenerationAt='1.0.0-rc.4';expected=@('1.0.0-rc.2','setup','1.0.0-rc.4')},
    @{interrupted=$true;expected=@('1.0.0-rc.2','setup')}
  )) {
    $events.Clear()
    $resource=[InertWitness]::new()
    $session=[ForgeWitnessedRc2Session]::new($resource,$id)
    $accepted=$true
    try { Complete-ForgeWitnessedRc2Upgrade $session './inert-setup.exe' ('1'*64) ('2'*64) } catch { $accepted=$false }
    if($accepted -ne [bool]$case.success -or ($events -join ',') -cne ($case.expected -join ',') -or $resource.DisposeCount -ne 1) {throw 'Unexpected witness execution order or resource lifetime.'}
    if($accepted -and $resource.Confirmation -cne ('2'*64)){throw 'The reviewed successor was not confirmed.'}
    if(!$accepted -and $resource.Confirmation){throw 'Uncertain activation authorized cleanup.'}
    $accepted=$true
    try { Complete-ForgeWitnessedRc2Upgrade $session './inert-setup.exe' ('1'*64) ('2'*64) } catch { $accepted=$false }
    if($accepted -or $resource.DisposeCount -ne 1 -or ($events -join ',') -cne ($case.expected -join ',')) {throw 'A closed witness was replayed.'}
  }
}
'Witnessed RC2 session ordering and interruption fixtures passed.'
# The tampered fixture is inert. Verification must fail before compiling its contents.
$temp=[IO.Directory]::CreateTempSubdirectory('forge-witness-module-')
$fixture=Join-Path $temp.FullName 'IdentityFixture.psm1'
$sidecar=Join-Path $temp.FullName 'Rc2ResourceWitness.cs'
try {
    [IO.File]::Copy((Join-Path $root 'WitnessedRc2Upgrade.psm1'),$fixture)
    [IO.File]::WriteAllText($sidecar,'/* inert, unreviewed source */')
    $untrusted=Import-Module $fixture -PassThru -NoClobber
    $refused=$false
    try { & $untrusted { Initialize-WitnessNative } }
    catch { $refused=$_.Exception.Message -ceq 'The native witness source differs from the reviewed version.' }
    if(!$refused -or ('AgentForge.Upgrade.Rc2Witness' -as [type])) { throw 'Changed native source was admitted.' }
} finally {
    if($null -ne $untrusted) { Remove-Module $untrusted }
    foreach($file in @($fixture,$sidecar)) { [IO.File]::Delete($file) }
    [IO.Directory]::Delete($temp.FullName,$false)
}
& $module { Initialize-WitnessNative }
'Reviewed native source compiled and modified native source refused.'
