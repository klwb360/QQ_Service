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

function Add-QQServiceUserTrustCertificate {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][ValidateSet('Root', 'TrustedPublisher')][string]$Name,
        [Parameter(Mandatory = $true)]$Publisher
    )
    # Callers validate the publisher before the explicit ShouldProcess prompt.
    # Snapshot immutable public DER so the native worker never reopens a source file
    # which could have changed while that prompt was displayed.
    $bytes = $Publisher.Certificate.RawData
    if ($Publisher.Certificate.HasPrivateKey -or
        (Get-QQServiceCertificateSha256 -Certificate $Publisher.Certificate) -cne $Publisher.Sha256 -or
        $Publisher.Certificate.Thumbprint.ToUpperInvariant() -cne $Publisher.Metadata.sha1) {
        throw 'Only the validated public publisher certificate may be imported.'
    }
    $store = Open-QQServiceUserStore -Name $Name
    try { if (@(Get-QQServiceStoreCertificate -Store $store -Publisher $Publisher).Count) { return $false } }
    finally { $store.Dispose() }
    $temporary = Join-Path ([System.IO.Path]::GetTempPath()) ('qq-service-public-trust-' + [Guid]::NewGuid().ToString('N'))
    $process = $null
    try {
        [void][System.IO.Directory]::CreateDirectory($temporary)
        $acl = Get-Acl -LiteralPath $temporary
        $acl.SetAccessRuleProtection($true, $false)
        $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
        try {
            $rule = New-Object Security.AccessControl.FileSystemAccessRule -ArgumentList $identity.User, ([Security.AccessControl.FileSystemRights]::FullControl), ([Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit), ([Security.AccessControl.PropagationFlags]::None), ([Security.AccessControl.AccessControlType]::Allow)
            $acl.AddAccessRule($rule)
            Set-Acl -LiteralPath $temporary -AclObject $acl
        }
        finally { $identity.Dispose() }
        $publicPath = Join-Path $temporary 'QQ_Service.cer'
        $workerPath = Join-Path $temporary 'Import-QQServicePublicTrust.ps1'
        if ($publicPath -match '["\x00-\x1f]' -or $workerPath -match '["\x00-\x1f]') { throw 'The temporary certificate paths cannot be passed safely to the native worker.' }
        [System.IO.File]::WriteAllBytes($publicPath, $bytes)
        # This is static reviewed code. No caller input is interpolated into
        # the script; certificate paths, target store and fingerprint are argv.
        $worker = @'
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][ValidateSet('Root', 'TrustedPublisher')][string]$StoreName,
    [Parameter(Mandatory = $true)][string]$CertificatePath,
    [Parameter(Mandatory = $true)][ValidatePattern('^[0-9A-F]{64}$')][string]$ExpectedSha256
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$certificate = $null
try {
    $encoded = [IO.File]::ReadAllBytes($CertificatePath)
    $certificate = [Security.Cryptography.X509Certificates.X509Certificate2]::new($encoded)
    $digest = [Security.Cryptography.SHA256]::Create()
    try { $actual = [BitConverter]::ToString($digest.ComputeHash($certificate.RawData)).Replace('-', '') }
    finally { $digest.Dispose() }
    if ($certificate.HasPrivateKey -or $actual -cne $ExpectedSha256 -or [Convert]::ToBase64String($encoded) -cne [Convert]::ToBase64String($certificate.RawData)) {
        throw 'The native trust worker did not receive the pinned public DER certificate.'
    }
    Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Security.Cryptography.X509Certificates;

public static class QQServiceCryptUIImport {
    [StructLayout(LayoutKind.Sequential)]
    private struct CRYPTUI_WIZ_IMPORT_SRC_INFO {
        public uint dwSize;
        public uint dwSubjectChoice;
        public IntPtr pCertContext;
        public uint dwFlags;
        public IntPtr pwszPassword;
    }

    [DllImport("cryptui.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CryptUIWizImport(uint flags, IntPtr parent, string title,
        ref CRYPTUI_WIZ_IMPORT_SRC_INFO source, IntPtr destination);

    public static int Import(X509Certificate2 certificate, string name) {
        if (name != "Root" && name != "TrustedPublisher") throw new ArgumentException("Unsupported user store.");
        using (var store = new X509Store(name, StoreLocation.CurrentUser)) {
            store.Open(OpenFlags.ReadWrite);
            var source = new CRYPTUI_WIZ_IMPORT_SRC_INFO {
                dwSize = (uint)Marshal.SizeOf(typeof(CRYPTUI_WIZ_IMPORT_SRC_INFO)),
                dwSubjectChoice = 2, // CRYPTUI_WIZ_IMPORT_SUBJECT_CERT_CONTEXT
                pCertContext = certificate.Handle,
                dwFlags = 0,
                pwszPassword = IntPtr.Zero
            };
            // Only documented CRYPTUI_WIZ_NO_UI=1. No root-unprotection,
            // LocalMachine, private-key or policy-changing flags are used.
            bool imported = CryptUIWizImport(1, IntPtr.Zero, null, ref source, store.StoreHandle);
            int error = imported ? 0 : Marshal.GetLastWin32Error();
            GC.KeepAlive(certificate);
            GC.KeepAlive(store);
            return imported ? 0 : (error == 0 ? unchecked((int)0x80004005) : error);
        }
    }
}
"@
    $code = [QQServiceCryptUIImport]::Import($certificate, $StoreName)
    if ($code -ne 0) {
        $message = (New-Object ComponentModel.Win32Exception -ArgumentList $code).Message
        throw ('CryptUIWizImport failed (0x' + $code.ToString('X8') + '): ' + $message)
    }
    Write-Output 'The pinned public certificate was imported to the selected CurrentUser store.'
}
catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }
finally { if ($null -ne $certificate) { $certificate.Dispose() } }
'@
        [IO.File]::WriteAllText($workerPath, $worker, [Text.Encoding]::ASCII)
        $binary = Join-Path $PSHOME 'powershell.exe'
        if (-not [System.IO.File]::Exists($binary)) { $binary = Join-Path $PSHOME 'pwsh.exe' }
        if (-not [System.IO.File]::Exists($binary)) { throw 'The current Windows PowerShell host executable was not found.' }
        $start = New-Object Diagnostics.ProcessStartInfo
        $start.FileName = $binary
        $start.Arguments = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + $workerPath + '" -StoreName ' + $Name + ' -CertificatePath "' + $publicPath + '" -ExpectedSha256 ' + $Publisher.Sha256
        $start.UseShellExecute = $false
        $start.CreateNoWindow = $true
        $start.RedirectStandardOutput = $true
        $start.RedirectStandardError = $true
        $start.RedirectStandardInput = $true
        $process = New-Object Diagnostics.Process
        $process.StartInfo = $start
        if (-not $process.Start()) { throw 'Could not start the Windows certificate import tool.' }
        # EOF prevents console interaction. The worker itself uses the
        # documented CryptUI no-UI mode, inside this bounded child process.
        # The entry script has already obtained explicit ShouldProcess consent.
        $process.StandardInput.Close()
        $output = $process.StandardOutput.ReadToEndAsync()
        $errors = $process.StandardError.ReadToEndAsync()
        if (-not $process.WaitForExit(25000)) {
            try { $process.Kill(); [void]$process.WaitForExit(2000) } catch { }
            try { [void][Threading.Tasks.Task]::WaitAll([Threading.Tasks.Task[]]@($output, $errors), 2000) } catch { }
            $diagnostic = Get-QQServiceNativeTrustDiagnostic -OutputTask $output -ErrorTask $errors
            throw ('Windows certificate import exceeded its 25-second deadline. ' + $diagnostic + ' A Windows policy may require administrator-managed trust; no machine-wide fallback was attempted.')
        }
        if (-not [Threading.Tasks.Task]::WaitAll([Threading.Tasks.Task[]]@($output, $errors), 3000)) {
            $diagnostic = Get-QQServiceNativeTrustDiagnostic -OutputTask $output -ErrorTask $errors
            throw ('Windows certificate import output did not close within its deadline. ' + $diagnostic)
        }
        # The worker receives only a public certificate; never print arbitrary
        # unbounded process output or interpret it as success. On failure only
        # bounded public-certificate diagnostics are included. No PFX is used.
        if ($process.ExitCode -ne 0) {
            $diagnostic = Get-QQServiceNativeTrustDiagnostic -OutputTask $output -ErrorTask $errors
            throw ('Windows certificate import failed with exit code ' + $process.ExitCode + '. ' + $diagnostic)
        }
        $store = Open-QQServiceUserStore -Name $Name
        try {
            if (@(Get-QQServiceStoreCertificate -Store $store -Publisher $Publisher).Count -ne 1) {
                throw 'Windows did not install the expected publisher certificate.'
            }
        }
        finally { $store.Dispose() }
        return $true
    }
    catch {
        # The exact publisher was absent before this attempt. A failed native
        # import may still have added it; remove only that matching new entry.
        try {
            $store = Open-QQServiceUserStore -Name $Name -Writable
            try { foreach ($item in @(Get-QQServiceStoreCertificate -Store $store -Publisher $Publisher)) { $store.Remove($item) } }
            finally { $store.Dispose() }
        }
        catch { Write-Warning ('Could not clean up the new matching publisher in CurrentUser\' + $Name + '.') }
        throw
    }
    finally {
        if ($null -ne $process) { $process.Dispose() }
        if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Recurse -Force }
    }
}

function Get-QQServiceNativeTrustDiagnostic {
    param(
        [Parameter(Mandatory = $true)][Threading.Tasks.Task]$OutputTask,
        [Parameter(Mandatory = $true)][Threading.Tasks.Task]$ErrorTask
    )
    $messages = @()
    foreach ($item in @(@{ Label = 'stdout'; Task = $OutputTask }, @{ Label = 'stderr'; Task = $ErrorTask })) {
        $text = '[pipe not closed]'
        if ($item.Task.IsCompleted -and -not $item.Task.IsFaulted -and -not $item.Task.IsCanceled) {
            $text = [string]$item.Task.Result
            $text = $text -replace '[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]', ''
            if ($text.Length -gt 1200) { $text = $text.Substring(0, 1200) + ' [truncated]' }
            if (-not $text.Trim()) { $text = '[empty]' }
        }
        elseif ($item.Task.IsFaulted -or $item.Task.IsCanceled) { $text = '[pipe failed]' }
        $messages += ($item.Label + ': ' + $text.Trim())
    }
    return ($messages -join ' | ')
}
