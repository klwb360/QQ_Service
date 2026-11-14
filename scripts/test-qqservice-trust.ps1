[CmdletBinding()]
param([Parameter(Mandatory = $true)][string]$CertificateDirectory)

# This fixture touches only disposable CurrentUser certificates. Production
# certificates are rejected by the short-validity guard below.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$trustDirectory = Join-Path $root 'signing'
. (Join-Path $trustDirectory 'QQServiceTrust.Common.ps1')
$install = Join-Path $trustDirectory 'Install-QQServiceTrust.ps1'
$remove = Join-Path $trustDirectory 'Remove-QQServiceTrust.ps1'
$isGitHubActions = $env:GITHUB_ACTIONS -eq 'true'
$ciInstallArguments = @{}
$ciRemoveArguments = @{}
if ($isGitHubActions) { $ciInstallArguments.CiApproveOwnedImportDialog = $true }
if ($isGitHubActions) { $ciRemoveArguments.CiApproveOwnedRemovalDialog = $true }

function Assert-TrustTest {
    param([bool]$Condition, [string]$Message)
    if (-not $Condition) { throw ('Trust fixture failed: ' + $Message) }
}

function Get-TrustTestStoreHashes {
    param([string]$Name, [System.Security.Cryptography.X509Certificates.StoreLocation]$Location = [System.Security.Cryptography.X509Certificates.StoreLocation]::CurrentUser)
    $store = New-Object System.Security.Cryptography.X509Certificates.X509Store -ArgumentList $Name, $Location
    try {
        $store.Open([System.Security.Cryptography.X509Certificates.OpenFlags]::ReadOnly)
        return @($store.Certificates | ForEach-Object { Get-QQServiceCertificateSha256 -Certificate $_ } | Sort-Object)
    }
    finally { $store.Dispose() }
}

function Test-TrustTestPublisherPresent {
    param([string]$Name, $Publisher)
    $store = Open-QQServiceUserStore -Name $Name
    try { return (@(Get-QQServiceStoreCertificate -Store $store -Publisher $Publisher).Count -eq 1) }
    finally { $store.Dispose() }
}

$expectedTime = [DateTimeOffset]::Parse('2026-11-14T03:00:00Z', [Globalization.CultureInfo]::InvariantCulture)
foreach ($value in @('2026-11-14T03:00:00.000Z', '2026-11-14T11:00:00+08:00', $expectedTime, $expectedTime.UtcDateTime, $expectedTime.LocalDateTime)) {
    $parsedTime = ConvertTo-QQServiceCertificateTime -Value $value
    Assert-TrustTest ($parsedTime.UtcDateTime.Ticks -eq $expectedTime.UtcDateTime.Ticks) 'typed and string metadata dates must preserve the UTC instant'
}

$publisher = Read-QQServiceTrustCertificate -CertificateDirectory $CertificateDirectory
$sentinel = $null
$sentinelPublic = $null
$sentinelPublisher = $null
$temporary = $null
$cleanupAllowed = $false
$trustTestsPassed = $false
try {
    Assert-TrustTest (($publisher.Certificate.NotAfter - $publisher.Certificate.NotBefore).TotalDays -le 2) 'only an ephemeral certificate valid for at most two days may be tested'
    foreach ($name in @('Root', 'TrustedPublisher')) {
        Assert-TrustTest (-not (Test-TrustTestPublisherPresent -Name $name -Publisher $publisher)) 'the fixture certificate must not already be trusted'
    }
    $cleanupAllowed = $true
    $machineRootBefore = @(Get-TrustTestStoreHashes -Name 'Root' -Location LocalMachine) -join ','
    $machinePublishersBefore = @(Get-TrustTestStoreHashes -Name 'TrustedPublisher' -Location LocalMachine) -join ','
    $executionPolicyBefore = Get-ExecutionPolicy -List | ConvertTo-Json -Compress

    $sentinel = New-SelfSignedCertificate -Type CodeSigningCert -Subject 'CN=QQ_Service unrelated trust fixture' -KeyLength 2048 -HashAlgorithm SHA256 -CertStoreLocation 'Cert:\CurrentUser\My' -NotAfter ([DateTime]::Now.AddDays(1))
    $sentinelHash = Get-QQServiceCertificateSha256 -Certificate $sentinel
    $sentinelPublic = [Security.Cryptography.X509Certificates.X509Certificate2]::new($sentinel.RawData)
    $sentinelPublisher = [pscustomobject]@{ Certificate = $sentinelPublic; Sha256 = $sentinelHash; Metadata = @{ sha1 = $sentinel.Thumbprint.ToUpperInvariant() } }
    foreach ($name in @('Root', 'TrustedPublisher')) {
        [void](Add-QQServiceUserTrustCertificate -Name $name -Publisher $sentinelPublisher -ApproveOwnedImportDialog:$isGitHubActions)
    }
    $myBefore = @(Get-TrustTestStoreHashes -Name 'My') -join ','
    $rootBefore = @(Get-TrustTestStoreHashes -Name 'Root') -join ','
    $publishersBefore = @(Get-TrustTestStoreHashes -Name 'TrustedPublisher') -join ','

    & $install -CertificateDirectory $CertificateDirectory -WhatIf @ciInstallArguments
    foreach ($name in @('Root', 'TrustedPublisher')) {
        Assert-TrustTest (-not (Test-TrustTestPublisherPresent -Name $name -Publisher $publisher)) 'WhatIf install must not add trust'
    }

    $temporary = Join-Path ([System.IO.Path]::GetTempPath()) ('qq-service-trust-negative-' + [Guid]::NewGuid().ToString('N'))
    [void][System.IO.Directory]::CreateDirectory($temporary)
    Copy-Item -LiteralPath (Join-Path $CertificateDirectory 'QQ_Service.cer') -Destination (Join-Path $temporary 'QQ_Service.cer')
    $badMetadata = Get-Content -Raw -LiteralPath (Join-Path $CertificateDirectory 'certificate.json') | ConvertFrom-Json
    $badMetadata.sha256 = ('0' * 64)
    [System.IO.File]::WriteAllText((Join-Path $temporary 'certificate.json'), ($badMetadata | ConvertTo-Json), (New-Object System.Text.UTF8Encoding -ArgumentList $false))
    $rejected = $false
    try { & $install -CertificateDirectory $temporary -Confirm:$false @ciInstallArguments }
    catch { $rejected = $true }
    Assert-TrustTest $rejected 'a mismatched fingerprint must be rejected'
    foreach ($name in @('Root', 'TrustedPublisher')) {
        Assert-TrustTest (-not (Test-TrustTestPublisherPresent -Name $name -Publisher $publisher)) 'rejected metadata must not change trust'
    }

    & $install -CertificateDirectory $CertificateDirectory -Confirm:$false @ciInstallArguments
    & $install -CertificateDirectory $CertificateDirectory -Confirm:$false @ciInstallArguments
    foreach ($name in @('Root', 'TrustedPublisher')) {
        Assert-TrustTest (Test-TrustTestPublisherPresent -Name $name -Publisher $publisher) 'install must add exactly one matching trust entry'
    }
    & $remove -CertificateDirectory $CertificateDirectory -WhatIf @ciRemoveArguments
    foreach ($name in @('Root', 'TrustedPublisher')) {
        Assert-TrustTest (Test-TrustTestPublisherPresent -Name $name -Publisher $publisher) 'WhatIf removal must retain trust'
    }
    & $remove -CertificateDirectory $CertificateDirectory -Confirm:$false @ciRemoveArguments
    & $remove -CertificateDirectory $CertificateDirectory -Confirm:$false @ciRemoveArguments
    foreach ($name in @('Root', 'TrustedPublisher')) {
        Assert-TrustTest (-not (Test-TrustTestPublisherPresent -Name $name -Publisher $publisher)) 'remove must clear only the fixture publisher'
        Assert-TrustTest (@(Get-TrustTestStoreHashes -Name $name) -contains $sentinelHash) 'an unrelated publisher must remain trusted'
    }
    Assert-TrustTest ((@(Get-TrustTestStoreHashes -Name 'Root') -join ',') -ceq $rootBefore) 'Root must return to its original contents'
    Assert-TrustTest ((@(Get-TrustTestStoreHashes -Name 'TrustedPublisher') -join ',') -ceq $publishersBefore) 'TrustedPublisher must return to its original contents'
    Assert-TrustTest ((@(Get-TrustTestStoreHashes -Name 'My') -join ',') -ceq $myBefore) 'the private-key store must not change'
    Assert-TrustTest ((@(Get-TrustTestStoreHashes -Name 'Root' -Location LocalMachine) -join ',') -ceq $machineRootBefore) 'machine Root must not change'
    Assert-TrustTest ((@(Get-TrustTestStoreHashes -Name 'TrustedPublisher' -Location LocalMachine) -join ',') -ceq $machinePublishersBefore) 'machine publishers must not change'
    Assert-TrustTest ((Get-ExecutionPolicy -List | ConvertTo-Json -Compress) -ceq $executionPolicyBefore) 'execution policy must not change'
    $trustTestsPassed = $true
    Write-Output 'PASS current-user trust, idempotence, WhatIf, wrong fingerprint, unrelated publishers, private-key and machine-store isolation.'
}
finally {
    # Only the disposable fixture and the sentinel created by this script are
    # eligible for cleanup. This does not enumerate or remove other publishers.
    $cleanupErrors = [Collections.Generic.List[string]]::new()
    if ($cleanupAllowed) {
        foreach ($name in @('Root', 'TrustedPublisher')) {
            try { [void](Remove-QQServiceUserTrustCertificate -Name $name -Publisher $publisher -ApproveOwnedRemovalDialog:$isGitHubActions) }
            catch { $cleanupErrors.Add($_.Exception.Message) }
            if ($null -ne $sentinelPublisher) {
                try { [void](Remove-QQServiceUserTrustCertificate -Name $name -Publisher $sentinelPublisher -ApproveOwnedRemovalDialog:$isGitHubActions) }
                catch { $cleanupErrors.Add($_.Exception.Message) }
            }
        }
    }
    if ($null -ne $sentinel) {
        Remove-Item -LiteralPath ('Cert:\CurrentUser\My\' + $sentinel.Thumbprint) -DeleteKey -ErrorAction SilentlyContinue
        $sentinel.Dispose()
    }
    if ($null -ne $sentinelPublic) { $sentinelPublic.Dispose() }
    if ($null -ne $temporary -and (Test-Path -LiteralPath $temporary)) { Remove-Item -LiteralPath $temporary -Recurse -Force }
    $publisher.Certificate.Dispose()
    if ($cleanupErrors.Count) {
        foreach ($message in $cleanupErrors) { Write-Warning ('Trust fixture cleanup: ' + $message) }
        if ($trustTestsPassed) { throw 'Trust fixture cleanup did not remove every owned temporary publisher.' }
    }
}
