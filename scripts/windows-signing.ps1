[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('Prepare', 'Verify', 'VerifyBundle', 'Cleanup')]
    [string]$Action,
    [string]$ProjectRoot = (Split-Path -Parent $PSScriptRoot),
    [string]$CertificatePath,
    [string]$MetadataPath,
    [string]$WorkDirectory,
    [string]$BundleDirectory,
    [string]$SourceSha
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProjectRoot = [IO.Path]::GetFullPath($ProjectRoot)
if (-not $CertificatePath) { $CertificatePath = Join-Path $ProjectRoot 'signing/QQ_Service.cer' }
if (-not $MetadataPath) { $MetadataPath = Join-Path $ProjectRoot 'signing/certificate.json' }
if (-not $WorkDirectory) {
    if (-not $env:RUNNER_TEMP) { throw 'WorkDirectory is required outside GitHub Actions.' }
    $WorkDirectory = Join-Path $env:RUNNER_TEMP 'qq-service-signing'
}
$WorkDirectory = [IO.Path]::GetFullPath($WorkDirectory)
$rootPrefix = $ProjectRoot.TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
if ($WorkDirectory.Equals($ProjectRoot, [StringComparison]::OrdinalIgnoreCase) -or $WorkDirectory.StartsWith($rootPrefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Signing working files must stay outside the project and packaged resources.'
}
$statePath = Join-Path $WorkDirectory 'state.json'
$pfxPath = Join-Path $WorkDirectory 'certificate.pfx'

function Get-HexDigest([byte[]]$Bytes, [string]$Algorithm = 'SHA256') {
    $hasher = [Security.Cryptography.HashAlgorithm]::Create($Algorithm)
    try { return ([BitConverter]::ToString($hasher.ComputeHash($Bytes))).Replace('-', '') }
    finally { $hasher.Dispose() }
}

function Read-SmallJson([string]$Path, [int]$Maximum = 16384) {
    $file = Get-Item -LiteralPath $Path -Force
    if ($file.PSIsContainer -or $file.Length -gt $Maximum -or ($file.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Invalid signing metadata file.' }
    return ([IO.File]::ReadAllText($file.FullName) | ConvertFrom-Json)
}

function Write-JsonFile([string]$Path, $Value) {
    [IO.File]::WriteAllText($Path, (($Value | ConvertTo-Json -Depth 8) + "`n"), [Text.UTF8Encoding]::new($false))
}

function ConvertTo-SigningUtcTime($Value) {
    if ($Value -is [DateTimeOffset]) { return $Value.UtcDateTime }
    if ($Value -is [DateTime]) { return $Value.ToUniversalTime() }
    return [DateTime]::Parse([string]$Value, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::RoundtripKind).ToUniversalTime()
}

function Read-PublicCertificate {
    $info = Get-Item -LiteralPath $CertificatePath -Force
    if ($info.PSIsContainer -or $info.Length -gt 16384 -or ($info.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Invalid public signing certificate.' }
    $encoded = [IO.File]::ReadAllBytes($info.FullName)
    $certificate = [Security.Cryptography.X509Certificates.X509Certificate2]::new($encoded)
    $metadata = Read-SmallJson $MetadataPath
    $sha1 = Get-HexDigest $certificate.RawData 'SHA1'
    $sha256 = Get-HexDigest $certificate.RawData
    if ($encoded.Length -ne $certificate.RawData.Length -or (Get-HexDigest $encoded) -cne $sha256) { throw 'The public certificate must contain one exact DER certificate.' }
    if ($metadata.schemaVersion -ne 1 -or $metadata.usage -cne 'codeSigning' -or $metadata.sha1 -cnotmatch '^[0-9A-F]{40}$' -or $metadata.sha256 -cnotmatch '^[0-9A-F]{64}$' -or $metadata.sha1 -cne $sha1 -or $metadata.sha256 -cne $sha256 -or $metadata.subject -cne $certificate.Subject) { throw 'Public certificate does not match the pinned signing metadata.' }
    if ($certificate.HasPrivateKey -or $certificate.Subject -cne 'CN=QQ_Service Self-Signed Publisher' -or $certificate.Issuer -cne $certificate.Subject -or $certificate.SignatureAlgorithm.Value -ne '1.2.840.113549.1.1.11') { throw 'Expected the public self-signed QQ_Service SHA256 certificate.' }
    $before = ConvertTo-SigningUtcTime $metadata.notBefore
    $after = ConvertTo-SigningUtcTime $metadata.notAfter
    if ($before -ne $certificate.NotBefore.ToUniversalTime() -or $after -ne $certificate.NotAfter.ToUniversalTime()) { throw 'Certificate validity does not match the pinned metadata.' }
    if ($Action -ne 'Cleanup' -and ([DateTime]::UtcNow -lt $before -or [DateTime]::UtcNow -ge $after)) { throw 'The signing certificate is not currently valid.' }
    $eku = @($certificate.Extensions | Where-Object { $_.Oid.Value -eq '2.5.29.37' })
    if ($eku.Count -ne 1) { throw 'The signing certificate must have a code-signing EKU.' }
    $typedEku = [Security.Cryptography.X509Certificates.X509EnhancedKeyUsageExtension]::new($eku[0], $eku[0].Critical)
    $usages = @($typedEku.EnhancedKeyUsages | ForEach-Object { $_.Value })
    if ($usages.Count -ne 1 -or $usages[0] -ne '1.3.6.1.5.5.7.3.3') { throw 'The certificate must be restricted to code signing.' }
    $constraints = @($certificate.Extensions | Where-Object { $_.Oid.Value -eq '2.5.29.19' })
    if ($constraints.Count -ne 1 -or ([Security.Cryptography.X509Certificates.X509BasicConstraintsExtension]::new($constraints[0], $constraints[0].Critical)).CertificateAuthority) { throw 'The signing certificate must not be a CA.' }
    $keyUsage = @($certificate.Extensions | Where-Object { $_.Oid.Value -eq '2.5.29.15' })
    if ($keyUsage.Count -ne 1 -or ([Security.Cryptography.X509Certificates.X509KeyUsageExtension]::new($keyUsage[0], $keyUsage[0].Critical)).KeyUsages -ne [Security.Cryptography.X509Certificates.X509KeyUsageFlags]::DigitalSignature) { throw 'The certificate must only permit digital signatures.' }
    $rsa = [Security.Cryptography.X509Certificates.RSACertificateExtensions]::GetRSAPublicKey($certificate)
    try { if (-not $rsa -or $rsa.KeySize -ne 4096) { throw 'The signing certificate must use RSA-4096.' } }
    finally { if ($rsa) { $rsa.Dispose() } }
    return @{ Certificate = $certificate; Metadata = $metadata; Sha1 = $sha1; Sha256 = $sha256 }
}

function Remove-OwnedStoreCertificate([string]$StoreName, [string]$Thumbprint, [string]$Sha256, [switch]$DeletePrivateKey) {
    if ($StoreName -eq 'Root' -or $StoreName -eq 'TrustedPublisher') {
        $publicCertificate = $null
        $store = [Security.Cryptography.X509Certificates.X509Store]::new($StoreName, [Security.Cryptography.X509Certificates.StoreLocation]::CurrentUser)
        try {
            $store.Open([Security.Cryptography.X509Certificates.OpenFlags]::ReadOnly)
            $matches = @($store.Certificates.Find([Security.Cryptography.X509Certificates.X509FindType]::FindByThumbprint, $Thumbprint, $false))
            foreach ($existing in $matches) {
                if ((Get-HexDigest $existing.RawData) -cne $Sha256) { throw 'Refusing to remove a certificate with a different fingerprint.' }
            }
            if ($matches.Count) { $publicCertificate = [Security.Cryptography.X509Certificates.X509Certificate2]::new($matches[0].RawData) }
        } finally { $store.Dispose() }
        if ($publicCertificate) {
            try {
                . (Join-Path $ProjectRoot 'signing/QQServiceTrust.Common.ps1')
                $publisher = [pscustomobject]@{ Certificate = $publicCertificate; Metadata = @{ sha1 = $Thumbprint }; Sha256 = $Sha256 }
                [void](Remove-QQServiceUserTrustCertificate -Name $StoreName -Publisher $publisher -ApproveOwnedRemovalDialog:($env:GITHUB_ACTIONS -eq 'true'))
            } finally { $publicCertificate.Dispose() }
        }
        return
    }
    if ($StoreName -ne 'My') { throw 'Unsupported signing certificate store.' }
    $path = "Cert:\CurrentUser\$StoreName\$Thumbprint"
    if (-not (Test-Path -LiteralPath $path)) { return }
    $existing = Get-Item -LiteralPath $path
    if ((Get-HexDigest $existing.RawData) -cne $Sha256) { throw 'Refusing to remove a certificate with a different fingerprint.' }
    if ($DeletePrivateKey -and $existing.HasPrivateKey) { Remove-Item -LiteralPath $path -DeleteKey -Force }
    else { Remove-Item -LiteralPath $path -Force }
}

function Cleanup-Signing {
    if (-not (Test-Path -LiteralPath $WorkDirectory)) { return }
    if ((Get-Item -LiteralPath $WorkDirectory -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Refusing to clean a linked signing work directory.' }
    if (-not (Test-Path -LiteralPath $statePath)) { throw 'Signing work directory has no ownership receipt; refusing to remove it.' }
    $state = Read-SmallJson $statePath
    if ($state.schemaVersion -ne 1 -or $state.projectRoot -cne $ProjectRoot -or $state.sha1 -cnotmatch '^[0-9A-F]{40}$' -or $state.sha256 -cnotmatch '^[0-9A-F]{64}$' -or $state.ownsDirectory -ne $true) { throw 'Invalid signing cleanup receipt.' }
    if ($state.storeImportStarted -eq $true) { Remove-OwnedStoreCertificate 'My' $state.sha1 $state.sha256 -DeletePrivateKey }
    if (Test-Path -LiteralPath $pfxPath) { Remove-Item -LiteralPath $pfxPath -Force }
    $unexpected = @(Get-ChildItem -LiteralPath $WorkDirectory -Force | Where-Object { $_.Name -ne 'state.json' })
    if ($unexpected.Count) { throw 'Signing directory contains unexpected files; refusing recursive cleanup.' }
    Remove-Item -LiteralPath $statePath -Force
    Remove-Item -LiteralPath $WorkDirectory -Force
    Write-Host 'Signing private-key cleanup completed.'
}

function Prepare-Signing($Public) {
    if (Test-Path -LiteralPath $WorkDirectory) { throw 'Signing working directory already exists; clean up the previous owned attempt first.' }
    if (Test-Path -LiteralPath ("Cert:\CurrentUser\My\" + $Public.Sha1)) { throw 'The signing certificate already exists in CurrentUser/My; refusing to take ownership of it.' }
    $encoded = $env:WINDOWS_SIGNING_PFX_BASE64
    $password = $env:WINDOWS_SIGNING_PASSWORD
    if (-not $encoded -or $encoded.Length -gt 65536 -or -not $password -or $password.Length -lt 16 -or $password.Length -gt 1024) { throw 'Missing or invalid signing credentials.' }
    $bytes = $null
    $collection = [Security.Cryptography.X509Certificates.X509Certificate2Collection]::new()
    try {
        try { $bytes = [Convert]::FromBase64String($encoded) }
        catch { throw 'The encrypted signing certificate is not valid Base64.' }
        try { $collection.Import($bytes, $password, [Security.Cryptography.X509Certificates.X509KeyStorageFlags]::EphemeralKeySet) }
        catch { throw 'The encrypted signing certificate could not be opened.' }
        if ($collection.Count -ne 1 -or -not $collection[0].HasPrivateKey -or (Get-HexDigest $collection[0].RawData) -cne $Public.Sha256) { throw 'The private signing certificate does not match the pinned public certificate.' }
        [void][IO.Directory]::CreateDirectory($WorkDirectory)
        $state = [ordered]@{ schemaVersion = 1; projectRoot = $ProjectRoot; sha1 = $Public.Sha1; sha256 = $Public.Sha256; ownsDirectory = $true; storeImportStarted = $false }
        Write-JsonFile $statePath $state
        [IO.File]::WriteAllBytes($pfxPath, $bytes)
        $state.storeImportStarted = $true
        Write-JsonFile $statePath $state
        $securePassword = ConvertTo-SecureString -String $password -AsPlainText -Force
        Import-PfxCertificate -FilePath $pfxPath -CertStoreLocation 'Cert:\CurrentUser\My' -Password $securePassword | Out-Null
        $imported = Get-Item -LiteralPath ("Cert:\CurrentUser\My\" + $Public.Sha1)
        if (-not $imported.HasPrivateKey -or (Get-HexDigest $imported.RawData) -cne $Public.Sha256) { throw 'Windows did not import the expected private signing certificate.' }
        Remove-Item -LiteralPath $pfxPath -Force
        Write-Host ('Prepared the pinned code-signing certificate: ' + $Public.Sha1)
    } catch {
        if (Test-Path -LiteralPath $statePath) { Cleanup-Signing }
        throw
    } finally {
        foreach ($item in $collection) { $item.Dispose() }
        if ($bytes) { [Array]::Clear($bytes, 0, $bytes.Length) }
        $env:WINDOWS_SIGNING_PFX_BASE64 = $null
        $env:WINDOWS_SIGNING_PASSWORD = $null
    }
}

function Read-DerElement([byte[]]$Bytes, [int]$Offset) {
    if ($Offset -lt 0 -or $Offset + 2 -gt $Bytes.Length) { throw 'Invalid Authenticode ASN.1 data.' }
    $tag = [int]$Bytes[$Offset]
    $length = [int]$Bytes[$Offset + 1]
    $start = $Offset + 2
    if ($length -band 128) {
        $count = $length -band 127
        if ($count -lt 1 -or $count -gt 4 -or $start + $count -gt $Bytes.Length) { throw 'Invalid Authenticode ASN.1 length.' }
        [long]$length = 0
        for ($index = 0; $index -lt $count; $index++) { $length = $length * 256 + $Bytes[$start + $index] }
        $start += $count
    }
    if ($length -lt 0 -or $length -gt 16MB -or $start + $length -gt $Bytes.Length) { throw 'Invalid Authenticode ASN.1 bounds.' }
    return @{ Tag = $tag; Start = $start; Length = [int]$length; End = [int]($start + $length) }
}

function Read-AuthenticodeCms([string]$Path) {
    try { Add-Type -AssemblyName System.Security.Cryptography.Pkcs -ErrorAction Stop }
    catch { Add-Type -AssemblyName System.Security -ErrorAction Stop }
    $stream = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
    $reader = [IO.BinaryReader]::new($stream)
    try {
        if ($stream.Length -lt 256 -or $reader.ReadUInt16() -ne 0x5A4D) { throw 'Expected a signed Windows PE file.' }
        $stream.Position = 0x3C
        $pe = $reader.ReadUInt32()
        if ($pe -gt $stream.Length - 256) { throw 'Invalid PE header.' }
        $stream.Position = $pe
        if ($reader.ReadUInt32() -ne 0x00004550) { throw 'Invalid PE signature.' }
        $optional = [long]$pe + 24
        $stream.Position = $optional
        $magic = $reader.ReadUInt16()
        if ($magic -eq 0x20B) { $directory = $optional + 144 }
        elseif ($magic -eq 0x10B) { $directory = $optional + 128 }
        else { throw 'Unsupported PE optional header.' }
        $stream.Position = $directory
        [long]$table = $reader.ReadUInt32()
        [long]$size = $reader.ReadUInt32()
        if ($table -lt 1 -or $size -lt 16 -or $size -gt 16MB -or $table + $size -gt $stream.Length) { throw 'Missing or invalid Authenticode security directory.' }
        $stream.Position = $table
        [long]$length = $reader.ReadUInt32()
        $revision = $reader.ReadUInt16()
        $type = $reader.ReadUInt16()
        if ($length -lt 16 -or $length -gt $size -or $revision -ne 0x200 -or $type -ne 2) { throw 'Unsupported Authenticode certificate record.' }
        $bytes = $reader.ReadBytes([int]($length - 8))
        $der = Read-DerElement $bytes 0
        if ($der.Tag -ne 0x30) { throw 'Invalid Authenticode CMS envelope.' }
        $encoded = [byte[]]::new($der.End)
        [Array]::Copy($bytes, $encoded, $der.End)
        $cms = [Security.Cryptography.Pkcs.SignedCms]::new()
        $cms.Decode($encoded)
        return $cms
    } finally { $reader.Dispose(); $stream.Dispose() }
}

function Get-PrimarySignatureValue($Cms) {
    $signer = $Cms.SignerInfos[0]
    if ($signer.PSObject.Methods['GetSignature']) { return ,([byte[]]$signer.GetSignature()) }
    # .NET Framework in Windows PowerShell 5.1 does not expose GetSignature.
    # Read precisely the same OCTET STRING from its single SignerInfo instead.
    [byte[]]$encoded = $Cms.Encode()
    $root = Read-DerElement $encoded 0
    $contentType = Read-DerElement $encoded $root.Start
    $explicit = Read-DerElement $encoded $contentType.End
    $signedData = Read-DerElement $encoded $explicit.Start
    $position = $signedData.Start
    for ($index = 0; $index -lt 3; $index++) { $position = (Read-DerElement $encoded $position).End }
    while ($position -lt $signedData.End) {
        $node = Read-DerElement $encoded $position
        if ($node.Tag -eq 0x31) { break }
        if ($node.Tag -ne 0xA0 -and $node.Tag -ne 0xA1) { throw 'Invalid CMS signer set.' }
        $position = $node.End
    }
    if ($position -ge $signedData.End -or $node.Tag -ne 0x31 -or $node.End -ne $signedData.End) { throw 'Missing CMS signer set.' }
    $info = Read-DerElement $encoded $node.Start
    if ($info.Tag -ne 0x30 -or $info.End -ne $node.End) { throw 'Expected one CMS SignerInfo.' }
    $position = $info.Start
    for ($index = 0; $index -lt 3; $index++) { $position = (Read-DerElement $encoded $position).End }
    $next = Read-DerElement $encoded $position
    if ($next.Tag -eq 0xA0) { $position = $next.End }
    $algorithm = Read-DerElement $encoded $position
    $signature = Read-DerElement $encoded $algorithm.End
    if ($algorithm.Tag -ne 0x30 -or $signature.Tag -ne 4 -or $signature.Length -lt 64 -or $signature.Length -gt 1024) { throw 'Invalid CMS signature value.' }
    $value = [byte[]]::new($signature.Length)
    [Array]::Copy($encoded, $signature.Start, $value, 0, $signature.Length)
    return ,$value
}

function Assert-Rfc3161Binding($Timestamp, $ParentSigner, [byte[]]$ParentSignature) {
    [byte[]]$content = $Timestamp.ContentInfo.Content
    $root = Read-DerElement $content 0
    $version = Read-DerElement $content $root.Start
    $policy = Read-DerElement $content $version.End
    $imprint = Read-DerElement $content $policy.End
    $algorithm = Read-DerElement $content $imprint.Start
    $oid = Read-DerElement $content $algorithm.Start
    $hash = Read-DerElement $content $algorithm.End
    $serial = Read-DerElement $content $imprint.End
    $time = Read-DerElement $content $serial.End
    $oidBytes = [byte[]]::new($oid.Length)
    [Array]::Copy($content, $oid.Start, $oidBytes, 0, $oid.Length)
    if ($root.Tag -ne 0x30 -or $root.End -ne $content.Length -or $version.Tag -ne 2 -or $version.Length -ne 1 -or $content[$version.Start] -ne 1 -or $policy.Tag -ne 6 -or $imprint.Tag -ne 0x30 -or $algorithm.Tag -ne 0x30 -or $oid.Tag -ne 6 -or ([BitConverter]::ToString($oidBytes)) -cne '60-86-48-01-65-03-04-02-01' -or $hash.Tag -ne 4 -or $hash.Length -ne 32 -or $hash.End -ne $imprint.End -or $serial.Tag -ne 2 -or $time.Tag -ne 0x18) { throw 'Invalid SHA256 RFC3161 message imprint or generation time.' }
    $imprinted = [byte[]]::new($hash.Length)
    [Array]::Copy($content, $hash.Start, $imprinted, 0, $hash.Length)
    $actualImprint = ([BitConverter]::ToString($imprinted)).Replace('-', '')
    if ($actualImprint -cne (Get-HexDigest $ParentSignature)) { throw 'The RFC3161 timestamp does not bind to this Authenticode signature.' }
    $text = [Text.Encoding]::ASCII.GetString($content, $time.Start, $time.Length)
    if ($text -cnotmatch '^\d{14}(?:\.\d{1,7})?Z$') { throw 'Invalid RFC3161 generation time.' }
    $styles = [Globalization.DateTimeStyles]::AssumeUniversal -bor [Globalization.DateTimeStyles]::AdjustToUniversal
    $generated = [DateTime]::ParseExact($text, [string[]]@("yyyyMMddHHmmss'Z'", "yyyyMMddHHmmss.FFFFFFF'Z'"), [Globalization.CultureInfo]::InvariantCulture, $styles)
    if ($generated -gt [DateTime]::UtcNow.AddMinutes(5) -or $generated -lt $ParentSigner.NotBefore.ToUniversalTime() -or $generated -gt $ParentSigner.NotAfter.ToUniversalTime()) { throw 'The RFC3161 generation time is outside the publisher certificate validity.' }
    $tsa = $Timestamp.SignerInfos[0].Certificate
    $eku = @($tsa.Extensions | Where-Object { $_.Oid.Value -eq '2.5.29.37' })
    if ($eku.Count -ne 1 -or -not $eku[0].Critical) { throw 'The RFC3161 signer must have a critical timestamping EKU.' }
    $typedEku = [Security.Cryptography.X509Certificates.X509EnhancedKeyUsageExtension]::new($eku[0], $eku[0].Critical)
    $purposes = @($typedEku.EnhancedKeyUsages | ForEach-Object { $_.Value })
    if ($purposes.Count -ne 1 -or $purposes[0] -ne '1.3.6.1.5.5.7.3.8') { throw 'The RFC3161 signer must be restricted to timestamping.' }
    $chain = [Security.Cryptography.X509Certificates.X509Chain]::new()
    try {
        [void]$chain.ChainPolicy.ApplicationPolicy.Add([Security.Cryptography.Oid]::new('1.3.6.1.5.5.7.3.8'))
        $chain.ChainPolicy.ExtraStore.AddRange($Timestamp.Certificates)
        $chain.ChainPolicy.VerificationTime = $generated
        $chain.ChainPolicy.RevocationMode = [Security.Cryptography.X509Certificates.X509RevocationMode]::Online
        $chain.ChainPolicy.RevocationFlag = [Security.Cryptography.X509Certificates.X509RevocationFlag]::ExcludeRoot
        $chain.ChainPolicy.UrlRetrievalTimeout = [TimeSpan]::FromSeconds(10)
        Write-Host 'RFC3161 imprint is bound; checking the trusted TSA chain and online revocation (10 seconds per URL).'
        if (-not $chain.Build($tsa)) { throw 'The RFC3161 signer does not chain to a trusted timestamp authority at its generation time.' }
        Write-Host 'RFC3161 TSA chain and generation-time policy passed.'
    } finally { $chain.Dispose() }
}

function Assert-Sha256Timestamp([string]$Path, $Public) {
    Write-Host ('Checking Authenticode CMS, SHA256 digest and RFC3161 token: ' + [IO.Path]::GetFileName($Path))
    $cms = Read-AuthenticodeCms $Path
    if ($cms.SignerInfos.Count -ne 1 -or $cms.SignerInfos[0].DigestAlgorithm.Value -ne '2.16.840.1.101.3.4.2.1' -or (Get-HexDigest $cms.SignerInfos[0].Certificate.RawData) -cne $Public.Sha256) { throw 'Expected exactly one SHA256 signature from the pinned publisher.' }
    $cms.CheckSignature($true)
    $content = $cms.ContentInfo.Content
    $root = Read-DerElement $content 0
    $data = Read-DerElement $content $root.Start
    $digest = Read-DerElement $content $data.End
    $algorithm = Read-DerElement $content $digest.Start
    $oid = Read-DerElement $content $algorithm.Start
    $oidBytes = [byte[]]::new($oid.Length)
    [Array]::Copy($content, $oid.Start, $oidBytes, 0, $oid.Length)
    $value = Read-DerElement $content $algorithm.End
    if ($root.Tag -ne 0x30 -or $digest.Tag -ne 0x30 -or $algorithm.Tag -ne 0x30 -or $oid.Tag -ne 6 -or ([BitConverter]::ToString($oidBytes)) -cne '60-86-48-01-65-03-04-02-01' -or $value.Tag -ne 4 -or $value.Length -ne 32) { throw 'The Authenticode file digest must use SHA256.' }
    $timestamps = @($cms.SignerInfos[0].UnsignedAttributes | Where-Object { $_.Oid.Value -eq '1.3.6.1.4.1.311.3.3.1' })
    if ($timestamps.Count -ne 1 -or $timestamps[0].Values.Count -ne 1) { throw 'A valid RFC3161 timestamp is required.' }
    $timestamp = [Security.Cryptography.Pkcs.SignedCms]::new()
    $timestamp.Decode($timestamps[0].Values[0].RawData)
    if ($timestamp.SignerInfos.Count -ne 1 -or $timestamp.ContentInfo.ContentType.Value -ne '1.2.840.113549.1.9.16.1.4') { throw 'Invalid RFC3161 timestamp token.' }
    $timestamp.CheckSignature($true)
    Assert-Rfc3161Binding $timestamp $cms.SignerInfos[0].Certificate (Get-PrimarySignatureValue $cms)
}

function Import-CiTrustCertificate([string]$StoreName, $Public) {
    if ($StoreName -ne 'Root' -and $StoreName -ne 'TrustedPublisher') { throw 'Unsupported temporary trust store.' }
    # Reuse the same audited, bounded CryptUIWizImport NO_UI worker as the
    # explicit user trust scripts. The caller already pinned the exact public
    # DER and this CI path changes only CurrentUser trust after signing.
    $common = Join-Path $ProjectRoot 'signing/QQServiceTrust.Common.ps1'
    if (-not (Test-Path -LiteralPath $common -PathType Leaf)) { throw 'The pinned publisher trust helper is unavailable.' }
    . $common
    Write-Host ('Importing the pinned public certificate into temporary CurrentUser/' + $StoreName + ' trust using the bounded no-UI Windows helper.')
    [void](Add-QQServiceUserTrustCertificate -Name $StoreName -Publisher $Public -ApproveOwnedImportDialog:($env:GITHUB_ACTIONS -eq 'true'))
    $store = [Security.Cryptography.X509Certificates.X509Store]::new($StoreName, [Security.Cryptography.X509Certificates.StoreLocation]::CurrentUser)
    try {
        $store.Open([Security.Cryptography.X509Certificates.OpenFlags]::ReadOnly)
        $found = @($store.Certificates.Find([Security.Cryptography.X509Certificates.X509FindType]::FindByThumbprint, $Public.Sha1, $false))
        if ($found.Count -ne 1 -or (Get-HexDigest $found[0].RawData) -cne $Public.Sha256) { throw 'The imported temporary trust entry does not match the pinned certificate.' }
    } finally { $store.Dispose() }
    Write-Host ('Pinned CurrentUser/' + $StoreName + ' trust entry is present.')
}

function With-TemporaryTrust($Public, [scriptblock]$Task) {
    $added = [Collections.Generic.List[string]]::new()
    try {
        foreach ($storeName in @('Root', 'TrustedPublisher')) {
            $store = [Security.Cryptography.X509Certificates.X509Store]::new($storeName, [Security.Cryptography.X509Certificates.StoreLocation]::CurrentUser)
            try {
                $store.Open([Security.Cryptography.X509Certificates.OpenFlags]::ReadOnly)
                $existing = @($store.Certificates.Find([Security.Cryptography.X509Certificates.X509FindType]::FindByThumbprint, $Public.Sha1, $false))
                foreach ($certificate in $existing) {
                    if ((Get-HexDigest $certificate.RawData) -cne $Public.Sha256) { throw 'Existing trust entry does not match the pinned certificate.' }
                }
            } finally { $store.Dispose() }
            if (-not $existing.Count) {
                # Record ownership before invoking native CAPI: a timeout may
                # occur after the certificate was added, and still needs cleanup.
                $added.Add($storeName)
                Import-CiTrustCertificate $storeName $Public
            }
        }
        & $Task
    } finally {
        foreach ($storeName in $added) {
            Write-Host ("Removing this verifier's temporary CurrentUser/" + $storeName + ' trust entry.')
            Remove-OwnedStoreCertificate $storeName $Public.Sha1 $Public.Sha256
        }
    }
}

function Assert-ValidSignature([string]$Path, $Public) {
    Assert-Sha256Timestamp $Path $Public
    Write-Host ('Checking Windows Authenticode policy: ' + [IO.Path]::GetFileName($Path))
    $signature = Get-AuthenticodeSignature -LiteralPath $Path
    if ($signature.Status -ne [Management.Automation.SignatureStatus]::Valid -or -not $signature.SignerCertificate -or (Get-HexDigest $signature.SignerCertificate.RawData) -cne $Public.Sha256 -or -not $signature.TimeStamperCertificate) { throw ('Invalid, untrusted or incorrectly timestamped QQ_Service signature: ' + [IO.Path]::GetFileName($Path)) }
    Write-Host ('Windows Authenticode policy passed: ' + [IO.Path]::GetFileName($Path))
}

function Get-PackageVersion {
    $package = Read-SmallJson (Join-Path $ProjectRoot 'package.json') 65536
    if ($package.version -cnotmatch '^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$') { throw 'Invalid application package version.' }
    return $package.version
}

function Verify-Signing($Public) {
    if ($SourceSha -cnotmatch '^[0-9a-f]{40}$') { throw 'The exact tested source commit SHA is required.' }
    $dist = Join-Path $ProjectRoot 'dist'
    $version = Get-PackageVersion
    $outerName = "QQ_Service-$version-Windows-x64.exe"
    $outer = Join-Path $dist $outerName
    $inner = Join-Path $dist 'win-unpacked/QQ_Service.exe'
    Write-Host 'Beginning strict signature verification for the internal and portable QQ_Service executables.'
    With-TemporaryTrust $Public {
        Write-Host 'Verifying the internal application executable.'
        Assert-ValidSignature $inner $Public
        Write-Host 'Verifying the outer portable executable.'
        Assert-ValidSignature $outer $Public
    }
    $outerHash = (Get-FileHash -LiteralPath $outer -Algorithm SHA256).Hash.ToLowerInvariant()
    $innerHash = (Get-FileHash -LiteralPath $inner -Algorithm SHA256).Hash.ToLowerInvariant()
    $manifest = [ordered]@{
        schemaVersion = 1; sourceSha = $SourceSha
        certificate = [ordered]@{ sha1 = $Public.Sha1; sha256 = $Public.Sha256; subject = $Public.Certificate.Subject }
        artifact = [ordered]@{ name = $outerName; sha256 = $outerHash }
        inner = [ordered]@{ name = 'QQ_Service.exe'; sha256 = $innerHash }
        timestampRequired = $true
    }
    [IO.File]::WriteAllText(($outer + '.sha256'), ($outerHash + '  ' + $outerName + "`n"), [Text.UTF8Encoding]::new($false))
    Write-JsonFile (Join-Path $dist 'signing-manifest.json') $manifest
    Write-Host 'Verified inner and portable signatures, SHA256 file digests and RFC3161 timestamps.'
}

function Verify-Bundle($Public) {
    if (-not $BundleDirectory -or $SourceSha -cnotmatch '^[0-9a-f]{40}$') { throw 'BundleDirectory and the exact source commit SHA are required.' }
    $bundle = [IO.Path]::GetFullPath($BundleDirectory)
    $manifest = Read-SmallJson (Join-Path $bundle 'signing-manifest.json')
    $version = Get-PackageVersion
    $outerName = "QQ_Service-$version-Windows-x64.exe"
    if ($manifest.schemaVersion -ne 1 -or $manifest.sourceSha -cne $SourceSha -or $manifest.timestampRequired -ne $true -or $manifest.certificate.sha1 -cne $Public.Sha1 -or $manifest.certificate.sha256 -cne $Public.Sha256 -or $manifest.certificate.subject -cne $Public.Certificate.Subject -or $manifest.artifact.name -cne $outerName -or $manifest.artifact.sha256 -cnotmatch '^[0-9a-f]{64}$' -or $manifest.inner.name -cne 'QQ_Service.exe' -or $manifest.inner.sha256 -cnotmatch '^[0-9a-f]{64}$') { throw 'The signed bundle does not match the pinned publisher and source commit.' }
    if ((Get-HexDigest ([IO.File]::ReadAllBytes((Join-Path $bundle 'QQ_Service.cer')))) -cne $Public.Sha256) { throw 'The bundle public certificate differs from the repository pin.' }
    $outer = Join-Path $bundle $outerName
    $hash = (Get-FileHash -LiteralPath $outer -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($hash -cne $manifest.artifact.sha256) { throw 'The signed bundle executable hash does not match its manifest.' }
    $checksum = [IO.File]::ReadAllText(($outer + '.sha256')).TrimEnd("`r", "`n")
    if ($checksum -cne ($hash + '  ' + $outerName)) { throw 'Invalid final executable checksum file.' }
    With-TemporaryTrust $Public { Assert-ValidSignature $outer $Public }
    Write-Host 'Verified the downloaded signed bundle against its source commit and pinned publisher.'
}

if ($Action -eq 'Cleanup') { Cleanup-Signing; exit 0 }
$public = Read-PublicCertificate
try {
    switch ($Action) {
        'Prepare' { Prepare-Signing $public }
        'Verify' { Verify-Signing $public }
        'VerifyBundle' { Verify-Bundle $public }
    }
} finally { $public.Certificate.Dispose() }
