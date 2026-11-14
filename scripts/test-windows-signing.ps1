[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('Setup', 'Verify', 'Cleanup')]
    [string]$Stage,
    [string]$ProjectRoot = (Split-Path -Parent $PSScriptRoot),
    [string]$CertificateDirectory,
    [string]$WorkDirectory,
    [string]$SourceSha = $env:GITHUB_SHA
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProjectRoot = [IO.Path]::GetFullPath($ProjectRoot)
if (-not $env:RUNNER_TEMP -and (-not $CertificateDirectory -or -not $WorkDirectory)) { throw 'Fixture directories must be specified outside GitHub Actions.' }
if (-not $CertificateDirectory) { $CertificateDirectory = Join-Path $env:RUNNER_TEMP 'qq-fixture-public' }
if (-not $WorkDirectory) { $WorkDirectory = Join-Path $env:RUNNER_TEMP 'qq-fixture-private' }
$CertificateDirectory = [IO.Path]::GetFullPath($CertificateDirectory)
$WorkDirectory = [IO.Path]::GetFullPath($WorkDirectory)
$certificatePath = Join-Path $CertificateDirectory 'QQ_Service.cer'
$metadataPath = Join-Path $CertificateDirectory 'certificate.json'
$tool = Join-Path $ProjectRoot 'scripts/windows-signing.ps1'

function Assert-True([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw ('Signing fixture assertion failed: ' + $Message) }
}

function Hex-Hash([byte[]]$Bytes) {
    $hash = [Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($hash.ComputeHash($Bytes))).Replace('-', '') }
    finally { $hash.Dispose() }
}

function New-FixtureCertificate {
    return New-SelfSignedCertificate -Type CodeSigningCert -Subject 'CN=QQ_Service Self-Signed Publisher' -CertStoreLocation 'Cert:\CurrentUser\My' -KeyAlgorithm RSA -KeyLength 4096 -HashAlgorithm SHA256 -KeyUsage DigitalSignature -KeyExportPolicy Exportable -NotBefore ([DateTime]::Now.AddMinutes(-1)) -NotAfter ([DateTime]::Now.AddDays(1)) -TextExtension @('2.5.29.19={critical}{text}ca=0')
}

function New-RandomPassword {
    $bytes = [byte[]]::new(32)
    $random = [Security.Cryptography.RandomNumberGenerator]::Create()
    try { $random.GetBytes($bytes); return [Convert]::ToBase64String($bytes) }
    finally { $random.Dispose(); [Array]::Clear($bytes, 0, $bytes.Length) }
}

function Remove-FixtureCertificate($Certificate) {
    $path = 'Cert:\CurrentUser\My\' + $Certificate.Thumbprint
    if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path -DeleteKey -Force }
}

function Invoke-NegativePrepare([string]$Directory, [string]$Expected) {
    $failed = $false
    try { & $tool -Action Prepare -ProjectRoot $ProjectRoot -CertificatePath $certificatePath -MetadataPath $metadataPath -WorkDirectory $Directory }
    catch {
        if ($_.Exception.Message -notmatch $Expected) { throw }
        $failed = $true
    }
    Assert-True $failed 'invalid signing input must fail closed'
    Assert-True (-not (Test-Path -LiteralPath $Directory)) 'rejected credentials must not leave a private working directory'
}

function Read-FixturePeCms([string]$Path) {
    $stream = [IO.File]::OpenRead($Path)
    $reader = [IO.BinaryReader]::new($stream)
    try {
        $stream.Position = 0x3C
        $pe = $reader.ReadUInt32()
        $stream.Position = $pe + 24
        $magic = $reader.ReadUInt16()
        if ($magic -eq 0x20B) { $directory = $pe + 24 + 144 }
        elseif ($magic -eq 0x10B) { $directory = $pe + 24 + 128 }
        else { throw 'Unexpected fixture PE architecture.' }
        $stream.Position = $directory
        [long]$table = $reader.ReadUInt32()
        [long]$size = $reader.ReadUInt32()
        Assert-True ($table -gt 0 -and $size -gt 8 -and $table + $size -eq $stream.Length) 'fixture security table must be at the file end'
        $stream.Position = $table
        $length = $reader.ReadUInt32()
        Assert-True ($reader.ReadUInt16() -eq 0x200 -and $reader.ReadUInt16() -eq 2) 'fixture must contain one PKCS7 WIN_CERTIFICATE'
        $encoded = $reader.ReadBytes($length - 8)
        $header = 2
        [int]$derLength = $encoded[1]
        if ($derLength -band 128) {
            $count = $derLength -band 127
            $derLength = 0
            for ($index = 0; $index -lt $count; $index++) { $derLength = $derLength * 256 + $encoded[2 + $index] }
            $header += $count
        }
        $body = [byte[]]::new($header + $derLength)
        [Array]::Copy($encoded, $body, $body.Length)
        $cms = [Security.Cryptography.Pkcs.SignedCms]::new()
        $cms.Decode($body)
        return @{ Cms = $cms; Table = $table; Directory = $directory }
    } finally { $reader.Dispose(); $stream.Dispose() }
}

function Replace-FixtureTimestamp([string]$TargetPath, [string]$DonorPath) {
    $target = Read-FixturePeCms $TargetPath
    $donor = Read-FixturePeCms $DonorPath
    $oid = '1.3.6.1.4.1.311.3.3.1'
    $old = @($target.Cms.SignerInfos[0].UnsignedAttributes | Where-Object { $_.Oid.Value -eq $oid })
    $replacement = @($donor.Cms.SignerInfos[0].UnsignedAttributes | Where-Object { $_.Oid.Value -eq $oid })
    Assert-True ($old.Count -eq 1 -and $replacement.Count -eq 1) 'both actual signed binaries must carry RFC3161 tokens'
    $before = [Convert]::ToBase64String($target.Cms.SignerInfos[0].GetSignature())
    Assert-True ($before -cne [Convert]::ToBase64String($donor.Cms.SignerInfos[0].GetSignature())) 'the real binaries must have different parent signatures'
    $donorToken = [Security.Cryptography.Pkcs.SignedCms]::new()
    $donorToken.Decode($replacement[0].Values[0].RawData)
    $donorToken.CheckSignature($true)
    $target.Cms.SignerInfos[0].RemoveUnsignedAttribute([Security.Cryptography.AsnEncodedData]::new($old[0].Oid, $old[0].Values[0].RawData))
    $target.Cms.SignerInfos[0].AddUnsignedAttribute([Security.Cryptography.AsnEncodedData]::new($replacement[0].Oid, $replacement[0].Values[0].RawData))
    Assert-True ($before -ceq [Convert]::ToBase64String($target.Cms.SignerInfos[0].GetSignature())) 'swapping an unsigned timestamp must preserve the publisher signature'
    [byte[]]$encoded = $target.Cms.Encode()
    [uint32]$length = 8 + $encoded.Length
    [uint32]$padding = (8 - ($length % 8)) % 8
    $stream = [IO.File]::Open($TargetPath, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite)
    $writer = [IO.BinaryWriter]::new($stream)
    try {
        $stream.SetLength($target.Table)
        $stream.Position = $target.Table
        $writer.Write($length)
        $writer.Write([uint16]0x200)
        $writer.Write([uint16]2)
        $writer.Write($encoded)
        if ($padding) { $writer.Write([byte[]]::new($padding)) }
        $stream.Position = $target.Directory + 4
        $writer.Write([uint32]($length + $padding))
    } finally { $writer.Dispose(); $stream.Dispose() }
}

if ($Stage -eq 'Setup') {
    if (Test-Path -LiteralPath $CertificateDirectory) { throw 'Fixture public directory already exists.' }
    [void][IO.Directory]::CreateDirectory($CertificateDirectory)
    $fixture = $null
    $pfx = Join-Path $CertificateDirectory 'fixture-temporary.pfx'
    try {
        $fixture = New-FixtureCertificate
        Export-Certificate -Cert $fixture -FilePath $certificatePath -Type CERT | Out-Null
        $metadata = [ordered]@{ schemaVersion = 1; subject = $fixture.Subject; sha1 = $fixture.Thumbprint.ToUpperInvariant(); sha256 = (Hex-Hash $fixture.RawData); notBefore = $fixture.NotBefore.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ'); notAfter = $fixture.NotAfter.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ'); usage = 'codeSigning' }
        [IO.File]::WriteAllText($metadataPath, (($metadata | ConvertTo-Json) + "`n"), [Text.UTF8Encoding]::new($false))
        $password = New-RandomPassword
        $secure = ConvertTo-SecureString $password -AsPlainText -Force
        Export-PfxCertificate -Cert $fixture -FilePath $pfx -Password $secure | Out-Null
        $env:WINDOWS_SIGNING_PFX_BASE64 = [Convert]::ToBase64String([IO.File]::ReadAllBytes($pfx))
        $env:WINDOWS_SIGNING_PASSWORD = $password
        Remove-FixtureCertificate $fixture
        & $tool -Action Prepare -ProjectRoot $ProjectRoot -CertificatePath $certificatePath -MetadataPath $metadataPath -WorkDirectory $WorkDirectory
        Assert-True (Test-Path -LiteralPath ('Cert:\CurrentUser\My\' + $metadata.sha1)) 'fixture private key must be imported for the real builder'
        Assert-True (-not (Test-Path -LiteralPath ('Cert:\CurrentUser\Root\' + $metadata.sha1))) 'builder must not see a public-only Root copy before signing'
        Assert-True (-not (Test-Path -LiteralPath ('Cert:\CurrentUser\TrustedPublisher\' + $metadata.sha1))) 'publisher trust must not be installed before signing'
        Invoke-NegativePrepare (Join-Path $CertificateDirectory 'existing-key-negative') 'already exists in CurrentUser/My'
        Assert-True (Test-Path -LiteralPath ('Cert:\CurrentUser\My\' + $metadata.sha1)) 'a rejected collision must preserve the existing private key'
        Write-Host 'PASS disposable RSA4096 fixture, exact public metadata and private-key preparation'
    } catch {
        if (Test-Path -LiteralPath (Join-Path $WorkDirectory 'state.json')) { & $tool -Action Cleanup -ProjectRoot $ProjectRoot -WorkDirectory $WorkDirectory }
        if ($fixture) { Remove-FixtureCertificate $fixture }
        throw
    } finally {
        $env:WINDOWS_SIGNING_PFX_BASE64 = $null
        $env:WINDOWS_SIGNING_PASSWORD = $null
        if (Test-Path -LiteralPath $pfx) { Remove-Item -LiteralPath $pfx -Force }
        if ($fixture) { $fixture.Dispose() }
    }
    exit 0
}

if ($Stage -eq 'Cleanup') {
    & $tool -Action Cleanup -ProjectRoot $ProjectRoot -WorkDirectory $WorkDirectory
    if (Test-Path -LiteralPath $CertificateDirectory) { Remove-Item -LiteralPath $CertificateDirectory -Recurse -Force }
    Write-Host 'PASS fixture key and public temporary files cleaned up'
    exit 0
}

& $tool -Action Verify -ProjectRoot $ProjectRoot -CertificatePath $certificatePath -MetadataPath $metadataPath -WorkDirectory $WorkDirectory -SourceSha $SourceSha
$metadata = [IO.File]::ReadAllText($metadataPath) | ConvertFrom-Json
Assert-True (-not (Test-Path -LiteralPath ('Cert:\CurrentUser\Root\' + $metadata.sha1))) 'verification must remove its temporary Root trust'
Assert-True (-not (Test-Path -LiteralPath ('Cert:\CurrentUser\TrustedPublisher\' + $metadata.sha1))) 'verification must remove its temporary publisher trust'
Write-Host 'PASS actual inner and portable signatures, SHA256 and RFC3161 timestamps'

# Copy only the public certificate into a temporary bundle. VerifyBundle must
# reject a changed executable independently of the runner certificate store.
$bundle = Join-Path $CertificateDirectory 'bundle'
[void][IO.Directory]::CreateDirectory($bundle)
$manifestPath = Join-Path $ProjectRoot 'dist/signing-manifest.json'
$manifest = [IO.File]::ReadAllText($manifestPath) | ConvertFrom-Json
$outer = Join-Path (Join-Path $ProjectRoot 'dist') $manifest.artifact.name
$copy = Join-Path $bundle $manifest.artifact.name
Copy-Item -LiteralPath $outer -Destination $copy
Copy-Item -LiteralPath ($outer + '.sha256') -Destination ($copy + '.sha256')
Copy-Item -LiteralPath $manifestPath -Destination (Join-Path $bundle 'signing-manifest.json')
Copy-Item -LiteralPath $certificatePath -Destination (Join-Path $bundle 'QQ_Service.cer')
& $tool -Action VerifyBundle -ProjectRoot $ProjectRoot -CertificatePath $certificatePath -MetadataPath $metadataPath -WorkDirectory $WorkDirectory -SourceSha $SourceSha -BundleDirectory $bundle
$stream = [IO.File]::Open($copy, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite)
try {
    $stream.Position = 0x40
    $original = $stream.ReadByte()
    $stream.Position = 0x40
    $stream.WriteByte([byte]($original -bxor 1))
} finally { $stream.Dispose() }
# An attacker may replace the unsigned checksum and JSON alongside the file.
# Update both claims so this case reaches real Authenticode verification under
# temporary trust instead of merely failing our preceding checksum comparison.
$changedHash = (Get-FileHash -LiteralPath $copy -Algorithm SHA256).Hash.ToLowerInvariant()
$manifest.artifact.sha256 = $changedHash
[IO.File]::WriteAllText((Join-Path $bundle 'signing-manifest.json'), (($manifest | ConvertTo-Json -Depth 8) + "`n"), [Text.UTF8Encoding]::new($false))
[IO.File]::WriteAllText(($copy + '.sha256'), ($changedHash + '  ' + $manifest.artifact.name + "`n"), [Text.UTF8Encoding]::new($false))
$rejected = $false
try { & $tool -Action VerifyBundle -ProjectRoot $ProjectRoot -CertificatePath $certificatePath -MetadataPath $metadataPath -WorkDirectory $WorkDirectory -SourceSha $SourceSha -BundleDirectory $bundle }
catch {
    if ($_.Exception.Message -notmatch 'Invalid, untrusted or incorrectly timestamped') { throw }
    $rejected = $true
}
Assert-True $rejected 'the signed bundle verifier must reject a tampered executable'
Copy-Item -LiteralPath $outer -Destination $copy -Force
Replace-FixtureTimestamp $copy (Join-Path $ProjectRoot 'dist/win-unpacked/QQ_Service.exe')
$changedHash = (Get-FileHash -LiteralPath $copy -Algorithm SHA256).Hash.ToLowerInvariant()
$manifest.artifact.sha256 = $changedHash
[IO.File]::WriteAllText((Join-Path $bundle 'signing-manifest.json'), (($manifest | ConvertTo-Json -Depth 8) + "`n"), [Text.UTF8Encoding]::new($false))
[IO.File]::WriteAllText(($copy + '.sha256'), ($changedHash + '  ' + $manifest.artifact.name + "`n"), [Text.UTF8Encoding]::new($false))
$rejected = $false
try { & $tool -Action VerifyBundle -ProjectRoot $ProjectRoot -CertificatePath $certificatePath -MetadataPath $metadataPath -WorkDirectory $WorkDirectory -SourceSha $SourceSha -BundleDirectory $bundle }
catch {
    if ($_.Exception.Message -notmatch 'timestamp does not bind to this Authenticode signature') { throw }
    $rejected = $true
}
Assert-True $rejected 'a genuine timestamp borrowed from a different signature must fail even after updating public hashes'
Remove-Item -LiteralPath $bundle -Recurse -Force
Write-Host 'PASS exact-source bundle, rehashed tampering and valid-but-unbound RFC3161 token rejection'

& (Join-Path $ProjectRoot 'scripts/test-qqservice-trust.ps1') -CertificateDirectory $CertificateDirectory

# Complete the private-key lifecycle before testing invalid credentials. The
# negative cases cannot borrow an already imported real signing key.
& $tool -Action Cleanup -ProjectRoot $ProjectRoot -WorkDirectory $WorkDirectory
Assert-True (-not (Test-Path -LiteralPath ('Cert:\CurrentUser\My\' + $metadata.sha1))) 'cleanup must remove the fixture private key'
& $tool -Action Cleanup -ProjectRoot $ProjectRoot -WorkDirectory $WorkDirectory
$negative = Join-Path $CertificateDirectory 'negative-private'
$env:WINDOWS_SIGNING_PFX_BASE64 = $null
$env:WINDOWS_SIGNING_PASSWORD = $null
Invoke-NegativePrepare $negative 'Missing or invalid signing credentials'

$wrong = $null
$wrongPfx = Join-Path $CertificateDirectory 'wrong-key-temporary.pfx'
try {
    $wrong = New-FixtureCertificate
    $password = New-RandomPassword
    Export-PfxCertificate -Cert $wrong -FilePath $wrongPfx -Password (ConvertTo-SecureString $password -AsPlainText -Force) | Out-Null
    $env:WINDOWS_SIGNING_PFX_BASE64 = [Convert]::ToBase64String([IO.File]::ReadAllBytes($wrongPfx))
    $env:WINDOWS_SIGNING_PASSWORD = $password
    Invoke-NegativePrepare $negative 'does not match the pinned public certificate'
    Assert-True (Test-Path -LiteralPath ('Cert:\CurrentUser\My\' + $wrong.Thumbprint)) 'rejecting the wrong key must preserve unrelated existing certificates'
    Assert-True (-not (Test-Path -LiteralPath ('Cert:\CurrentUser\My\' + $metadata.sha1))) 'wrong-key rejection must not import the expected signer'
} finally {
    $env:WINDOWS_SIGNING_PFX_BASE64 = $null
    $env:WINDOWS_SIGNING_PASSWORD = $null
    if ($wrong) { Remove-FixtureCertificate $wrong; $wrong.Dispose() }
    if (Test-Path -LiteralPath $wrongPfx) { Remove-Item -LiteralPath $wrongPfx -Force }
}
Write-Host 'PASS missing credentials, wrong private key, idempotent cleanup and unrelated-key preservation'
