$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $projectRoot
$runtimeRoot = Join-Path $projectRoot '.runtime'
New-Item -ItemType Directory -Force -Path $runtimeRoot | Out-Null
$existingNode = Get-ChildItem -LiteralPath $runtimeRoot -Directory -Filter 'node-v24*-win-*' | Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $existingNode -or -not (Test-Path (Join-Path $existingNode.FullName 'node.exe')) -or -not (Test-Path (Join-Path $existingNode.FullName 'node_modules\npm\bin\npm-cli.js'))) {
    Write-Host 'Preparing official Node.js 24 runtime (first launch only)...'
    $architecture = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'x64' }
    $checksumUri = 'https://nodejs.org/dist/latest-v24.x/SHASUMS256.txt'
    $checksumText = (Invoke-WebRequest -UseBasicParsing -Uri $checksumUri).Content
    $pattern = '^([a-f0-9]{64})\s+(node-v24\.\d+\.\d+-win-' + $architecture + '\.zip)\r?$'
    $match = [regex]::Match($checksumText, $pattern, [Text.RegularExpressions.RegexOptions]::Multiline)
    if (-not $match.Success) { throw 'Could not resolve an official Node.js 24 Windows package.' }
    $expectedHash = $match.Groups[1].Value
    $archiveName = $match.Groups[2].Value
    $archivePath = Join-Path $runtimeRoot $archiveName
    Invoke-WebRequest -UseBasicParsing -Uri ('https://nodejs.org/dist/latest-v24.x/' + $archiveName) -OutFile $archivePath
    $actualHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $archivePath).Hash.ToLowerInvariant()
    if ($actualHash -ne $expectedHash) { Remove-Item -LiteralPath $archivePath; throw 'Node.js checksum verification failed.' }
    Expand-Archive -LiteralPath $archivePath -DestinationPath $runtimeRoot -Force
    Remove-Item -LiteralPath $archivePath
    $existingNode = Get-Item -LiteralPath (Join-Path $runtimeRoot ($archiveName -replace '\.zip$', ''))
}
$nodeExe = Join-Path $existingNode.FullName 'node.exe'
$npmCli = Join-Path $existingNode.FullName 'node_modules\npm\bin\npm-cli.js'
$env:QQ_DASHBOARD_NPM_CLI = $npmCli
$env:PATH = $existingNode.FullName + ';' + $env:PATH
$stamp = Join-Path $runtimeRoot 'dependencies.sha256'
$lockHash = (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $projectRoot 'package-lock.json')).Hash
$dependencyStamp = if (Test-Path -LiteralPath $stamp) { (Get-Content -Raw -LiteralPath $stamp).Trim() } else { '' }
if (-not (Test-Path -LiteralPath (Join-Path $projectRoot 'node_modules\ws\package.json')) -or $dependencyStamp -ne $lockHash) {
    Write-Host 'Installing locked dashboard dependencies...'
    & $nodeExe $npmCli ci --ignore-scripts --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { throw 'Dashboard dependency installation failed. Check your network and retry.' }
    Set-Content -LiteralPath $stamp -Value $lockHash -Encoding ASCII
}
$dashboardUri = 'http://127.0.0.1:3210'
try {
    $running = Invoke-WebRequest -UseBasicParsing -Uri ($dashboardUri + '/api/state') -TimeoutSec 2
    if ($running.StatusCode -eq 200) { Write-Host 'A dashboard is already running.'; Start-Process $dashboardUri; exit 0 }
} catch { }
Write-Host ('Starting ' + $dashboardUri)
Write-Host 'Keep this window open. Press Ctrl+C to stop.'
$browserOpener = Start-Job -ScriptBlock {
    param($uri)
    for ($attempt = 0; $attempt -lt 30; $attempt++) {
        try {
            $response = Invoke-WebRequest -UseBasicParsing -Uri ($uri + '/api/state') -TimeoutSec 2
            if ($response.StatusCode -eq 200) { Start-Process $uri; return }
        } catch { }
        Start-Sleep -Seconds 1
    }
} -ArgumentList $dashboardUri
try { & $nodeExe (Join-Path $projectRoot 'src\server.mjs') } finally { Stop-Job $browserOpener -ErrorAction SilentlyContinue; Remove-Job $browserOpener -ErrorAction SilentlyContinue }
if ($LASTEXITCODE -ne 0) { throw 'The dashboard stopped with an error.' }
