# Check the actual WebView2 Runtime on the disposable native test host.
$ErrorActionPreference = 'Stop'
if (!$IsWindows -or $env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted') {
    throw 'WebView2 setup requires a GitHub-hosted Windows runner.'
}

function Find-EvergreenRuntime {
    $client = 'Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}'
    $registrations = @(
        @{ scope = 'machine'; key = "HKLM:\SOFTWARE\WOW6432Node\$client"; roots = @(${env:ProgramFiles(x86)}, $env:ProgramFiles) },
        @{ scope = 'user'; key = "HKCU:\Software\$client"; roots = @($env:LOCALAPPDATA) }
    )
    foreach ($registration in $registrations) {
        $pv = Get-ItemPropertyValue -LiteralPath $registration.key -Name pv -ErrorAction SilentlyContinue
        $version = $null
        if (!([version]::TryParse([string]$pv, [ref]$version)) -or $version -le [version]'0.0.0.0') { continue }
        foreach ($runtimeRoot in $registration.roots) {
            if (!$runtimeRoot) { continue }
            $exe = Join-Path $runtimeRoot "Microsoft\EdgeWebView\Application\$version\msedgewebview2.exe"
            if (Test-Path -LiteralPath $exe -PathType Leaf) {
                $actual = (Get-Item -LiteralPath $exe).VersionInfo.FileVersionRaw
                if ($actual -ne $version) { throw 'Installed WebView2 executable and registry versions differ.' }
                Write-Host "WebView2 runtime registered for $($registration.scope), executable version $actual"
                return $version
            }
        }
        Write-Host "WebView2 $($registration.scope) registration $version has no matching runtime executable."
    }
}

if (!(Find-EvergreenRuntime)) {
    Write-Host 'Installing missing Microsoft Evergreen WebView2 prerequisite on the hosted runner.'
    $setup = Join-Path $env:RUNNER_TEMP ("forge-lite-webview2-" + [guid]::NewGuid().ToString('N') + '.exe')
    Invoke-WebRequest -Uri 'https://go.microsoft.com/fwlink/p/?LinkId=2124703' -OutFile $setup -TimeoutSec 45
    $signature = Get-AuthenticodeSignature -LiteralPath $setup
    if ($signature.Status -ne 'Valid' -or
        $signature.SignerCertificate.GetNameInfo([Security.Cryptography.X509Certificates.X509NameType]::SimpleName, $false) -cne 'Microsoft Corporation') {
        throw 'WebView2 bootstrapper must have a valid Microsoft Corporation signature.'
    }
    $install = Start-Process -FilePath $setup -ArgumentList '/silent','/install' -PassThru -WindowStyle Hidden
    if (!$install.WaitForExit(120000) -or $install.ExitCode -ne 0) { throw 'WebView2 prerequisite installation failed.' }
    if (!(Find-EvergreenRuntime)) { throw 'WebView2 is still unavailable after installation.' }
}
