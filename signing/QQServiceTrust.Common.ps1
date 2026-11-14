# Shared by the two explicit, current-user trust entry points. No action is
# performed when this file is loaded. Compatible with Windows PowerShell 5.1.
Set-StrictMode -Version Latest

function Get-QQServiceCertificateSha256 {
    param([Parameter(Mandatory = $true)][System.Security.Cryptography.X509Certificates.X509Certificate2]$Certificate)
    $algorithm = [System.Security.Cryptography.SHA256]::Create()
    try { return [System.BitConverter]::ToString($algorithm.ComputeHash($Certificate.RawData)).Replace('-', '') }
    finally { $algorithm.Dispose() }
}

function ConvertTo-QQServiceCertificateTime {
    param([Parameter(Mandatory = $true)]$Value)
    # PowerShell 7.5+ may deserialize ISO JSON dates into DateTime objects;
    # Windows PowerShell 5.1 leaves them as strings. Preserve the timezone in
    # both cases, including when the user's computer is not configured to UTC.
    if ($Value -is [DateTimeOffset]) { return $Value.ToUniversalTime() }
    if ($Value -is [DateTime]) { return [DateTimeOffset]::new($Value.ToUniversalTime()) }
    if ($Value -isnot [string]) { throw 'Certificate validity fields must contain ISO dates.' }
    $style = [System.Globalization.DateTimeStyles]::AssumeUniversal -bor [System.Globalization.DateTimeStyles]::AdjustToUniversal
    return [DateTimeOffset]::Parse($Value, [System.Globalization.CultureInfo]::InvariantCulture, $style)
}

function Read-QQServiceTrustCertificate {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$CertificateDirectory,
        [switch]$AllowExpired
    )
    if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
        throw 'QQ_Service certificate trust must be configured on Windows.'
    }
    $directory = [System.IO.Path]::GetFullPath($CertificateDirectory)
    $certificatePath = Join-Path $directory 'QQ_Service.cer'
    $metadataPath = Join-Path $directory 'certificate.json'
    foreach ($file in @($certificatePath, $metadataPath)) {
        $item = Get-Item -LiteralPath $file -ErrorAction Stop
        if ($item.PSIsContainer -or ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
            throw 'The certificate and its metadata must be ordinary files.'
        }
    }
    $certificateBytes = [System.IO.File]::ReadAllBytes($certificatePath)
    $metadataBytes = [System.IO.File]::ReadAllBytes($metadataPath)
    if ($certificateBytes.Length -lt 512 -or $certificateBytes.Length -gt 65536 -or $metadataBytes.Length -gt 8192) {
        throw 'The certificate or its metadata has an invalid size.'
    }
    $metadata = [System.Text.Encoding]::UTF8.GetString($metadataBytes).TrimStart([char]0xFEFF) | ConvertFrom-Json
    if ($null -eq $metadata -or $metadata -isnot [pscustomobject]) { throw 'Invalid certificate metadata.' }
    $expectedFields = @('schemaVersion', 'subject', 'sha1', 'sha256', 'notBefore', 'notAfter', 'usage')
    $actualFields = @($metadata.PSObject.Properties.Name)
    if ($actualFields.Count -ne $expectedFields.Count -or @($actualFields | Where-Object { $expectedFields -cnotcontains $_ }).Count) {
        throw 'Certificate metadata fields do not match the supported format.'
    }
    if (($metadata.schemaVersion -isnot [int] -and $metadata.schemaVersion -isnot [long]) -or $metadata.schemaVersion -ne 1 -or
        $metadata.subject -cne 'CN=QQ_Service Self-Signed Publisher' -or $metadata.usage -cne 'codeSigning' -or
        $metadata.sha1 -isnot [string] -or $metadata.sha1 -cnotmatch '^[0-9A-F]{40}$' -or
        $metadata.sha256 -isnot [string] -or $metadata.sha256 -cnotmatch '^[0-9A-F]{64}$') {
        throw 'Certificate metadata contains an unexpected publisher, purpose or fingerprint.'
    }
    $certificate = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2 -ArgumentList @(,$certificateBytes)
    try {
        # Only one public DER certificate is accepted, never a PFX, PKCS#7
        # collection or private-key container disguised with a .cer extension.
        if ($certificate.HasPrivateKey -or [Convert]::ToBase64String($certificate.RawData) -cne [Convert]::ToBase64String($certificateBytes)) {
            throw 'Only the public DER certificate is accepted.'
        }
        $sha256 = Get-QQServiceCertificateSha256 -Certificate $certificate
        if ($certificate.Thumbprint.ToUpperInvariant() -cne $metadata.sha1 -or $sha256 -cne $metadata.sha256 -or
            $certificate.Subject -cne $metadata.subject -or $certificate.Issuer -cne $metadata.subject -or
            $certificate.SignatureAlgorithm.Value -ne '1.2.840.113549.1.1.11') {
            throw 'The public certificate does not match its expected publisher or fingerprints.'
        }
        $rsa = [System.Security.Cryptography.X509Certificates.RSACertificateExtensions]::GetRSAPublicKey($certificate)
        try { if ($null -eq $rsa -or $rsa.KeySize -ne 4096) { throw 'The publisher must use a 4096-bit RSA key.' } }
        finally { if ($null -ne $rsa) { $rsa.Dispose() } }
        $eku = @($certificate.Extensions | Where-Object { $_.Oid.Value -eq '2.5.29.37' })
        $constraints = @($certificate.Extensions | Where-Object { $_.Oid.Value -eq '2.5.29.19' })
        $keyUsage = @($certificate.Extensions | Where-Object { $_.Oid.Value -eq '2.5.29.15' })
        if ($eku.Count -ne 1 -or $constraints.Count -ne 1 -or $keyUsage.Count -ne 1) { throw 'Required code-signing certificate extensions are missing.' }
        $enhanced = New-Object System.Security.Cryptography.X509Certificates.X509EnhancedKeyUsageExtension
        $enhanced.CopyFrom($eku[0])
        $basic = New-Object System.Security.Cryptography.X509Certificates.X509BasicConstraintsExtension
        $basic.CopyFrom($constraints[0])
        $usage = New-Object System.Security.Cryptography.X509Certificates.X509KeyUsageExtension
        $usage.CopyFrom($keyUsage[0])
        if ($enhanced.EnhancedKeyUsages.Count -ne 1 -or $enhanced.EnhancedKeyUsages[0].Value -ne '1.3.6.1.5.5.7.3.3' -or
            $basic.CertificateAuthority -or $usage.KeyUsages -ne [System.Security.Cryptography.X509Certificates.X509KeyUsageFlags]::DigitalSignature) {
            throw 'The certificate must be a non-CA certificate for code signing only.'
        }
        $notBefore = ConvertTo-QQServiceCertificateTime -Value $metadata.notBefore
        $notAfter = ConvertTo-QQServiceCertificateTime -Value $metadata.notAfter
        if ([Math]::Abs(($certificate.NotBefore.ToUniversalTime() - $notBefore.UtcDateTime).TotalSeconds) -ge 1 -or
            [Math]::Abs(($certificate.NotAfter.ToUniversalTime() - $notAfter.UtcDateTime).TotalSeconds) -ge 1 -or
            $notAfter -le $notBefore -or ($notAfter - $notBefore).TotalDays -gt 1096) {
            throw 'The certificate validity does not match its metadata.'
        }
        if (-not $AllowExpired -and ([DateTime]::UtcNow -lt $certificate.NotBefore.ToUniversalTime() -or [DateTime]::UtcNow -gt $certificate.NotAfter.ToUniversalTime())) {
            throw 'The certificate is not currently valid. Check the Windows clock or obtain the current signing bundle.'
        }
        $chain = New-Object System.Security.Cryptography.X509Certificates.X509Chain
        try {
            $chain.ChainPolicy.RevocationMode = [System.Security.Cryptography.X509Certificates.X509RevocationMode]::NoCheck
            $chain.ChainPolicy.VerificationFlags = [System.Security.Cryptography.X509Certificates.X509VerificationFlags]::AllowUnknownCertificateAuthority
            if ($AllowExpired) {
                $chain.ChainPolicy.VerificationFlags = $chain.ChainPolicy.VerificationFlags -bor [System.Security.Cryptography.X509Certificates.X509VerificationFlags]::IgnoreNotTimeValid
            }
            [void]$chain.ChainPolicy.ApplicationPolicy.Add((New-Object System.Security.Cryptography.Oid -ArgumentList '1.3.6.1.5.5.7.3.3'))
            [void]$chain.ChainPolicy.ExtraStore.Add($certificate)
            if (-not $chain.Build($certificate) -or $chain.ChainElements.Count -ne 1 -or
                (Get-QQServiceCertificateSha256 -Certificate $chain.ChainElements[0].Certificate) -cne $sha256) {
                throw 'The public certificate does not form the expected self-signed code-signing chain.'
            }
        }
        finally { $chain.Dispose() }
        return [pscustomobject]@{ Certificate = $certificate; Metadata = $metadata; Sha256 = $sha256 }
    }
    catch { $certificate.Dispose(); throw }
}

function Get-QQServiceStoreCertificate {
    param(
        [Parameter(Mandatory = $true)][System.Security.Cryptography.X509Certificates.X509Store]$Store,
        [Parameter(Mandatory = $true)]$Publisher
    )
    $found = @($Store.Certificates.Find([System.Security.Cryptography.X509Certificates.X509FindType]::FindByThumbprint, $Publisher.Metadata.sha1, $false))
    foreach ($candidate in $found) {
        if ((Get-QQServiceCertificateSha256 -Certificate $candidate) -cne $Publisher.Sha256) {
            throw 'A certificate with a conflicting fingerprint is already present; no trust entries were changed.'
        }
    }
    return $found
}

function Open-QQServiceUserStore {
    param(
        [Parameter(Mandatory = $true)][ValidateSet('Root', 'TrustedPublisher')][string]$Name,
        [switch]$Writable
    )
    $store = New-Object System.Security.Cryptography.X509Certificates.X509Store -ArgumentList $Name, ([System.Security.Cryptography.X509Certificates.StoreLocation]::CurrentUser)
    try {
        $flags = [System.Security.Cryptography.X509Certificates.OpenFlags]::ReadOnly
        if ($Writable) { $flags = [System.Security.Cryptography.X509Certificates.OpenFlags]::ReadWrite }
        $store.Open($flags)
        return $store
    }
    catch { $store.Dispose(); throw }
}
