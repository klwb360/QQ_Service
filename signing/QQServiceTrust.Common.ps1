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
        [Parameter(Mandatory = $true)]$Publisher,
        [switch]$ApproveOwnedImportDialog
    )
    if ($ApproveOwnedImportDialog -and $env:GITHUB_ACTIONS -ne 'true') {
        throw 'Owned certificate-dialog approval is restricted to an explicit GitHub Actions fixture or signing invocation.'
    }
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
    $workerStarted = $false
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
[Console]::Out.WriteLine('trust-native: worker-start')
[Console]::Out.Flush()
try {
    $encoded = [IO.File]::ReadAllBytes($CertificatePath)
    $certificate = [Security.Cryptography.X509Certificates.X509Certificate2]::new($encoded)
    $digest = [Security.Cryptography.SHA256]::Create()
    try { $actual = [BitConverter]::ToString($digest.ComputeHash($certificate.RawData)).Replace('-', '') }
    finally { $digest.Dispose() }
    if ($certificate.HasPrivateKey -or $actual -cne $ExpectedSha256 -or [Convert]::ToBase64String($encoded) -cne [Convert]::ToBase64String($certificate.RawData)) {
        throw 'The native trust worker did not receive the pinned public DER certificate.'
    }
    [Console]::Out.WriteLine('trust-native: certificate-validated; before-add-type')
    [Console]::Out.Flush()
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
            Console.Out.WriteLine("trust-native: before-store-open CurrentUser\\" + name);
            Console.Out.Flush();
            store.Open(OpenFlags.ReadWrite);
            Console.Out.WriteLine("trust-native: after-store-open");
            Console.Out.Flush();
            var source = new CRYPTUI_WIZ_IMPORT_SRC_INFO {
                dwSize = (uint)Marshal.SizeOf(typeof(CRYPTUI_WIZ_IMPORT_SRC_INFO)),
                dwSubjectChoice = 2, // CRYPTUI_WIZ_IMPORT_SUBJECT_CERT_CONTEXT
                pCertContext = certificate.Handle,
                dwFlags = 0,
                pwszPassword = IntPtr.Zero
            };
            // Only documented CRYPTUI_WIZ_NO_UI=1. No root-unprotection,
            // LocalMachine, private-key or policy-changing flags are used.
            Console.Out.WriteLine("trust-native: before-CryptUIWizImport; publisher=" + certificate.Subject);
            Console.Out.Flush();
            bool imported = CryptUIWizImport(1, IntPtr.Zero, null, ref source, store.StoreHandle);
            int error = imported ? 0 : Marshal.GetLastWin32Error();
            Console.Out.WriteLine("trust-native: after-CryptUIWizImport; error=0x" + error.ToString("X8"));
            Console.Out.Flush();
            GC.KeepAlive(certificate);
            GC.KeepAlive(store);
            return imported ? 0 : (error == 0 ? unchecked((int)0x80004005) : error);
        }
    }
}
"@
    [Console]::Out.WriteLine('trust-native: after-add-type; before-native-call')
    [Console]::Out.Flush()
    $code = [QQServiceCryptUIImport]::Import($certificate, $StoreName)
    if ($code -ne 0) {
        $message = (New-Object ComponentModel.Win32Exception -ArgumentList $code).Message
        throw ('CryptUIWizImport failed (0x' + $code.ToString('X8') + '): ' + $message)
    }
    [Console]::Out.WriteLine('trust-native: native-call-finished')
    [Console]::Out.Flush()
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
        $ciWindowDiagnostics = $env:GITHUB_ACTIONS -eq 'true'
        if ($ciWindowDiagnostics) { Initialize-QQServiceOwnedWindowDiagnostics }
        if (-not $process.Start()) { throw 'Could not start the Windows certificate import tool.' }
        $workerStarted = $true
        Write-Host ('QQ_Service trust worker PID ' + $process.Id + ', CurrentUser\' + $Name + ', publisher ' + $Publisher.Certificate.Subject)
        # EOF prevents console interaction. The worker itself uses the
        # documented CryptUI no-UI mode, inside this bounded child process.
        # The entry script has already obtained explicit ShouldProcess consent.
        $process.StandardInput.Close()
        $output = $process.StandardOutput.ReadToEndAsync()
        $errors = $process.StandardError.ReadToEndAsync()
        $importDeadline = 60000
        if ($ciWindowDiagnostics) { $importDeadline = 20000 }
        $approvalSent = $false
        $clock = [Diagnostics.Stopwatch]::StartNew()
        $timedOut = $false
        while (-not $process.WaitForExit(200)) {
            if ($ApproveOwnedImportDialog -and $Name -eq 'Root' -and -not $approvalSent) {
                $simpleName = $Publisher.Certificate.GetNameInfo([Security.Cryptography.X509Certificates.X509NameType]::SimpleName, $false)
                $approval = [QQServiceOwnedTrustWindows]::TryApproveRootImport($process.Id, $Publisher.Metadata.sha1, $simpleName)
                if ($approval -lt 0) { throw 'The worker root-import dialog did not match the pinned public certificate. No confirmation was sent.' }
                if ($approval -eq 1) { $approvalSent = $true; Write-Host 'Confirmed one exact owned CI root-import dialog matching the public subject and complete SHA1 fingerprint.' }
            }
            if ($clock.ElapsedMilliseconds -ge $importDeadline) { $timedOut = $true; break }
        }
        if ($timedOut) {
            if ($ciWindowDiagnostics) {
                Write-Host ('QQ_Service owned trust windows: ' + [QQServiceOwnedTrustWindows]::Describe($process.Id))
            }
            try { $process.Kill(); [void]$process.WaitForExit(2000) } catch { }
            try { [void][Threading.Tasks.Task]::WaitAll([Threading.Tasks.Task[]]@($output, $errors), 2000) } catch { }
            $diagnostic = Get-QQServiceNativeTrustDiagnostic -OutputTask $output -ErrorTask $errors
            throw ('Windows certificate import exceeded its bounded deadline. ' + $diagnostic + ' A Windows policy may require administrator-managed trust; no machine-wide fallback was attempted.')
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
        # Stop its owned process before touching the store: a pending Windows
        # confirmation can otherwise retain the store's native write lock.
        if ($workerStarted -and -not $process.HasExited) { try { $process.Kill(); [void]$process.WaitForExit(2000) } catch { } }
        try {
            if ($workerStarted -and -not $process.HasExited) { throw 'The import worker is still active; store cleanup was skipped to avoid a native lock.' }
            $removalOptions = @{}
            if ($ApproveOwnedImportDialog) { $removalOptions.ApproveOwnedRemovalDialog = $true }
            [void](Remove-QQServiceUserTrustCertificate -Name $Name -Publisher $Publisher @removalOptions)
        }
        catch { Write-Warning ('Could not clean up the new matching publisher in CurrentUser\' + $Name + '.') }
        throw
    }
    finally {
        if ($null -ne $process) {
            if ($workerStarted -and -not $process.HasExited) { try { $process.Kill(); [void]$process.WaitForExit(2000) } catch { } }
            $process.Dispose()
        }
        if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Recurse -Force }
    }
}

function Remove-QQServiceUserTrustCertificate {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][ValidateSet('Root', 'TrustedPublisher')][string]$Name,
        [Parameter(Mandatory = $true)]$Publisher,
        [switch]$ApproveOwnedRemovalDialog
    )
    if ($ApproveOwnedRemovalDialog -and $env:GITHUB_ACTIONS -ne 'true') { throw 'Owned removal confirmation is restricted to an explicit GitHub Actions invocation.' }
    if ($Publisher.Certificate.HasPrivateKey -or
        (Get-QQServiceCertificateSha256 -Certificate $Publisher.Certificate) -cne $Publisher.Sha256 -or
        $Publisher.Certificate.Thumbprint.ToUpperInvariant() -cne $Publisher.Metadata.sha1 -or
        $Publisher.Metadata.sha1 -cnotmatch '^[0-9A-F]{40}$') {
        throw 'Only the pinned public publisher may be removed from current-user trust.'
    }
    $store = Open-QQServiceUserStore -Name $Name
    try { if (@(Get-QQServiceStoreCertificate -Store $store -Publisher $Publisher).Count -eq 0) { return $false } }
    finally { $store.Dispose() }
    $temporary = Join-Path ([IO.Path]::GetTempPath()) ('qq-service-exact-trust-removal-' + [Guid]::NewGuid().ToString('N'))
    $process = New-Object Diagnostics.Process
    $started = $false
    try {
        [void][IO.Directory]::CreateDirectory($temporary)
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
        $workerPath = Join-Path $temporary 'Remove-ExactQQServicePublicTrust.ps1'
        if ($publicPath -match '["\x00-\x1f]' -or $workerPath -match '["\x00-\x1f]') { throw 'Invalid native removal paths.' }
        [IO.File]::WriteAllBytes($publicPath, $Publisher.Certificate.RawData)
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
$store = $null
$selected = $null
function Get-PublicHash($Certificate) {
    $digest = [Security.Cryptography.SHA256]::Create()
    try { return [BitConverter]::ToString($digest.ComputeHash($Certificate.RawData)).Replace('-', '') }
    finally { $digest.Dispose() }
}
try {
    [Console]::Out.WriteLine('trust-remove-native: worker-start')
    [Console]::Out.Flush()
    $encoded = [IO.File]::ReadAllBytes($CertificatePath)
    $certificate = [Security.Cryptography.X509Certificates.X509Certificate2]::new($encoded)
    if ($certificate.HasPrivateKey -or (Get-PublicHash $certificate) -cne $ExpectedSha256 -or [Convert]::ToBase64String($encoded) -cne [Convert]::ToBase64String($certificate.RawData)) { throw 'Exact public removal certificate validation failed.' }
    $store = [Security.Cryptography.X509Certificates.X509Store]::new($StoreName, [Security.Cryptography.X509Certificates.StoreLocation]::CurrentUser)
    $store.Open([Security.Cryptography.X509Certificates.OpenFlags]::ReadWrite)
    $matches = @($store.Certificates.Find([Security.Cryptography.X509Certificates.X509FindType]::FindByThumbprint, $certificate.Thumbprint, $false))
    if ($matches.Count -ne 1) { throw 'The exact removal certificate is absent or ambiguous.' }
    $selected = $matches[0]
    if ((Get-PublicHash $selected) -cne $ExpectedSha256 -or [Convert]::ToBase64String($selected.RawData) -cne [Convert]::ToBase64String($encoded)) { throw 'The selected store certificate does not match the full public DER pin.' }
    [Console]::Out.WriteLine('trust-remove-native: before-exact-context-remove')
    [Console]::Out.Flush()
    $store.Remove($selected)
    [Console]::Out.WriteLine('trust-remove-native: after-exact-context-remove')
    [Console]::Out.Flush()
}
catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }
finally {
    if ($null -ne $selected) { $selected.Dispose() }
    if ($null -ne $store) { $store.Dispose() }
    if ($null -ne $certificate) { $certificate.Dispose() }
}
'@
        [IO.File]::WriteAllText($workerPath, $worker, [Text.Encoding]::ASCII)
        $binary = Join-Path $PSHOME 'powershell.exe'
        if (-not [IO.File]::Exists($binary)) { $binary = Join-Path $PSHOME 'pwsh.exe' }
        if (-not [IO.File]::Exists($binary)) { throw 'The current Windows PowerShell host executable was not found.' }
        $start = New-Object Diagnostics.ProcessStartInfo
        $start.FileName = $binary
        $start.Arguments = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + $workerPath + '" -StoreName ' + $Name + ' -CertificatePath "' + $publicPath + '" -ExpectedSha256 ' + $Publisher.Sha256
        $start.UseShellExecute = $false
        $start.CreateNoWindow = $true
        $start.RedirectStandardInput = $true
        $start.RedirectStandardOutput = $true
        $start.RedirectStandardError = $true
        $process.StartInfo = $start
        $ciDiagnostics = $env:GITHUB_ACTIONS -eq 'true'
        if ($ciDiagnostics) { Initialize-QQServiceOwnedWindowDiagnostics }
        if (-not $process.Start()) { throw 'Could not start the Windows certificate removal tool.' }
        $started = $true
        Write-Host ('QQ_Service trust removal worker PID ' + $process.Id + ', CurrentUser\' + $Name + ', SHA1 ' + $Publisher.Metadata.sha1)
        $process.StandardInput.Close()
        $output = $process.StandardOutput.ReadToEndAsync()
        $errors = $process.StandardError.ReadToEndAsync()
        $deadline = 60000
        if ($ciDiagnostics) { $deadline = 20000 }
        $confirmationSent = $false
        $clock = [Diagnostics.Stopwatch]::StartNew()
        $timedOut = $false
        while (-not $process.WaitForExit(200)) {
            if ($ApproveOwnedRemovalDialog -and $Name -eq 'Root' -and -not $confirmationSent) {
                $simpleName = $Publisher.Certificate.GetNameInfo([Security.Cryptography.X509Certificates.X509NameType]::SimpleName, $false)
                $approval = [QQServiceOwnedTrustWindows]::TryApproveRootRemoval($process.Id, $Publisher.Metadata.sha1, $simpleName, $Publisher.Certificate.SerialNumber)
                if ($approval -lt 0) { throw 'The owned root-removal dialog did not match the exact public certificate. No confirmation was sent.' }
                if ($approval -eq 1) { $confirmationSent = $true; Write-Host 'Confirmed one exact owned CI root-removal dialog matching full SHA1, serial number and subject.' }
            }
            if ($clock.ElapsedMilliseconds -ge $deadline) { $timedOut = $true; break }
        }
        if ($timedOut) {
            if ($ciDiagnostics) { Write-Host ('QQ_Service owned removal windows: ' + [QQServiceOwnedTrustWindows]::Describe($process.Id)) }
            try { $process.Kill(); [void]$process.WaitForExit(2000) } catch { }
            try { [void][Threading.Tasks.Task]::WaitAll([Threading.Tasks.Task[]]@($output, $errors), 2000) } catch { }
            throw ('Windows certificate removal exceeded its bounded deadline. ' + (Get-QQServiceNativeTrustDiagnostic -OutputTask $output -ErrorTask $errors))
        }
        if (-not [Threading.Tasks.Task]::WaitAll([Threading.Tasks.Task[]]@($output, $errors), 3000)) {
            throw ('Windows certificate removal output did not close within its deadline. ' + (Get-QQServiceNativeTrustDiagnostic -OutputTask $output -ErrorTask $errors))
        }
        if ($process.ExitCode -ne 0) { throw ('Exact certificate-context removal failed. ' + (Get-QQServiceNativeTrustDiagnostic -OutputTask $output -ErrorTask $errors)) }
        $store = Open-QQServiceUserStore -Name $Name
        try { $remaining = @(Get-QQServiceStoreCertificate -Store $store -Publisher $Publisher).Count }
        finally { $store.Dispose() }
        if ($remaining -ne 0) {
            throw ('The exact current-user publisher is still trusted after certificate removal (exit ' + $process.ExitCode + '). ' + (Get-QQServiceNativeTrustDiagnostic -OutputTask $output -ErrorTask $errors))
        }
        # An already-removed certificate from a concurrent, identical action
        # also satisfies the desired state. Never infer it from exit text.
        return $true
    }
    finally {
        if ($started -and -not $process.HasExited) { try { $process.Kill(); [void]$process.WaitForExit(2000) } catch { } }
        $process.Dispose()
        if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Recurse -Force }
    }
}

function Initialize-QQServiceOwnedWindowDiagnostics {
    if ($null -ne ('QQServiceOwnedTrustWindows' -as [type])) { return }
    # CI-only helpers for this worker's own windows. Diagnostics are read-only;
    # confirmation is separately gated by the explicit CI-only import switch.
    # No focus, keyboard input, unrelated windows or policy changes are used.
    Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;

public static class QQServiceOwnedTrustWindows {
    private delegate bool Enumerate(IntPtr window, IntPtr state);
    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool EnumWindows(Enumerate callback, IntPtr state);
    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool EnumChildWindows(IntPtr parent, Enumerate callback, IntPtr state);
    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr window, out uint process);
    [DllImport("user32.dll", CharSet = CharSet.Unicode, EntryPoint = "GetClassNameW", ExactSpelling = true)]
    private static extern int GetClassName(IntPtr window, StringBuilder text, int maximum);
    [DllImport("user32.dll")]
    private static extern int GetDlgCtrlID(IntPtr window);
    [DllImport("user32.dll")]
    private static extern IntPtr GetParent(IntPtr window);
    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool IsWindowEnabled(IntPtr window);
    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll", CharSet = CharSet.Unicode, EntryPoint = "PostMessageW", ExactSpelling = true, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool PostMessage(IntPtr window, uint message, UIntPtr command, IntPtr control);
    [DllImport("user32.dll", CharSet = CharSet.Unicode, EntryPoint = "SendMessageTimeoutW", ExactSpelling = true)]
    private static extern IntPtr SendMessageTimeout(IntPtr window, uint message, UIntPtr length,
        StringBuilder text, uint flags, uint timeout, out UIntPtr result);

    private static string DescribeWindow(IntPtr window) {
        var kind = new StringBuilder(80);
        GetClassName(window, kind, kind.Capacity);
        var text = new StringBuilder(1201);
        UIntPtr length;
        SendMessageTimeout(window, 13, (UIntPtr)(uint)text.Capacity, text, 0x22, 100, out length);
        string value = text.ToString().Replace("\r", " ").Replace("\n", " ").Replace("\0", "");
        return "handle=" + window.ToInt64().ToString("X") + ";class=" + kind + ";id=" + GetDlgCtrlID(window) + ";text=" + value;
    }

    private static bool IsOwned(IntPtr window, int owner) {
        uint process;
        GetWindowThreadProcessId(window, out process);
        return process == (uint)owner;
    }

    private static string ClassName(IntPtr window) {
        var result = new StringBuilder(80);
        GetClassName(window, result, result.Capacity);
        return result.ToString();
    }

    private static bool ReadText(IntPtr window, out string value) {
        var text = new StringBuilder(4097);
        UIntPtr length;
        IntPtr result = SendMessageTimeout(window, 13, (UIntPtr)(uint)text.Capacity, text, 0x22, 100, out length);
        value = text.ToString();
        return result != IntPtr.Zero && value.Length < text.Capacity - 1;
    }

    public static bool MatchesExpectedImportText(string title, string text, string expectedSha1, string expectedName) {
        if (title != "Security Warning" || text == null || text.Length > 8192 || expectedSha1 == null ||
            !Regex.IsMatch(expectedSha1, "^[0-9A-F]{40}$", RegexOptions.CultureInvariant) ||
            String.IsNullOrEmpty(expectedName) || expectedName.Length > 256 || expectedName.IndexOfAny(new char[] {'\r', '\n', '\0'}) >= 0) return false;
        string body = text.Trim();
        const string opening = "You are about to install a certificate from a certification authority (CA) claiming to represent:";
        if (!body.StartsWith(opening, StringComparison.Ordinal) || !body.EndsWith("Do you want to install this certificate?", StringComparison.Ordinal)) return false;
        if (Regex.Matches(body, "claiming to represent:", RegexOptions.CultureInvariant).Count != 1 ||
            Regex.Matches(body, @"Thumbprint \(sha1\):", RegexOptions.CultureInvariant).Count != 1) return false;
        string quote = ((char)34).ToString();
        string claim = @"claiming to represent:\s*" + Regex.Escape(expectedName) + @"\s+Windows cannot validate that the certificate is actually from " + quote + Regex.Escape(expectedName) + quote + @"\.";
        if (!Regex.IsMatch(body, claim, RegexOptions.CultureInvariant)) return false;
        MatchCollection hashes = Regex.Matches(body, @"Thumbprint \(sha1\):\s*([0-9A-Fa-f]{8}(?:\s+[0-9A-Fa-f]{8}){4})\s+Warning:", RegexOptions.CultureInvariant);
        return hashes.Count == 1 && Regex.Replace(hashes[0].Groups[1].Value, @"\s", "").ToUpperInvariant() == expectedSha1;
    }

    public static bool MatchesExpectedRemovalText(string title, string text, string expectedSha1, string expectedName, string expectedSerial) {
        if (title != "Root Certificate Store" || text == null || text.Length > 8192 || expectedSha1 == null || expectedSerial == null ||
            !Regex.IsMatch(expectedSha1, "^[0-9A-F]{40}$", RegexOptions.CultureInvariant) ||
            !Regex.IsMatch(expectedSerial, "^[0-9A-F]{2,64}$", RegexOptions.CultureInvariant) || expectedSerial.Length % 2 != 0 ||
            String.IsNullOrEmpty(expectedName) || expectedName.Length > 256 || expectedName.IndexOfAny(new char[] {'\r', '\n', '\0'}) >= 0) return false;
        string body = text.Trim();
        if (!body.StartsWith("Do you want to DELETE the following certificate from the Root Store?", StringComparison.Ordinal)) return false;
        foreach (string label in new string[] { @"Subject\s*:", @"Issuer\s*:", @"Serial Number\s*:", @"Thumbprint \(sha1\)\s*:", @"Thumbprint \(md5\)\s*:" }) {
            if (Regex.Matches(body, label, RegexOptions.CultureInvariant).Count != 1) return false;
        }
        string subject = @"Subject\s*:\s*" + Regex.Escape(expectedName) + @"\s+Issuer\s*:\s*Self Issued\s+Time Validity\s*:";
        if (!Regex.IsMatch(body, subject, RegexOptions.CultureInvariant)) return false;
        MatchCollection serials = Regex.Matches(body, @"Serial Number\s*:\s*([0-9A-Fa-f\s]+?)\s+Thumbprint \(sha1\)\s*:", RegexOptions.CultureInvariant);
        if (serials.Count != 1 || Regex.Replace(serials[0].Groups[1].Value, @"\s", "").ToUpperInvariant() != expectedSerial) return false;
        MatchCollection hashes = Regex.Matches(body, @"Thumbprint \(sha1\)\s*:\s*([0-9A-Fa-f]{8}(?:\s+[0-9A-Fa-f]{8}){4})\s+Thumbprint \(md5\)\s*:\s*[0-9A-Fa-f]{8}(?:\s+[0-9A-Fa-f]{8}){3}\s*$", RegexOptions.CultureInvariant);
        return hashes.Count == 1 && Regex.Replace(hashes[0].Groups[1].Value, @"\s", "").ToUpperInvariant() == expectedSha1;
    }

    public static int TryApproveRootRemoval(int owner, string expectedSha1, string expectedName, string expectedSerial) {
        var dialogs = new List<IntPtr>();
        Enumerate find = delegate(IntPtr window, IntPtr state) {
            if (IsOwned(window, owner) && IsWindowVisible(window) && ClassName(window) == "#32770") dialogs.Add(window);
            return dialogs.Count < 2;
        };
        EnumWindows(find, IntPtr.Zero);
        GC.KeepAlive(find);
        if (dialogs.Count == 0) return 0;
        if (dialogs.Count != 1) return -1;
        IntPtr dialog = dialogs[0];
        string title;
        if (!ReadText(dialog, out title) || String.IsNullOrWhiteSpace(title)) return 0;
        if (title != "Root Certificate Store") return -1;
        var body = new StringBuilder();
        var yesButtons = new List<IntPtr>();
        bool valid = true;
        int count = 0;
        Enumerate children = delegate(IntPtr item, IntPtr state) {
            if (++count > 24 || body.Length > 8192) { valid = false; return false; }
            if (!IsOwned(item, owner)) { valid = false; return false; }
            string kind = ClassName(item), text;
            if (kind == "Static") {
                if (!ReadText(item, out text)) { valid = false; return false; }
                if (text.Length > 0) body.AppendLine(text);
            }
            if (kind == "Button" && GetDlgCtrlID(item) == 6 && GetParent(item) == dialog && IsWindowVisible(item) && IsWindowEnabled(item)) {
                if (!ReadText(item, out text) || (text != "&Yes" && text != "Yes")) { valid = false; return false; }
                yesButtons.Add(item);
            }
            return true;
        };
        EnumChildWindows(dialog, children, IntPtr.Zero);
        GC.KeepAlive(children);
        if (!valid || yesButtons.Count > 1) return -1;
        if (yesButtons.Count == 0 || body.ToString().IndexOf("Thumbprint (md5)", StringComparison.Ordinal) < 0) return 0;
        if (!MatchesExpectedRemovalText(title, body.ToString(), expectedSha1, expectedName, expectedSerial)) return -1;
        IntPtr yes = yesButtons[0];
        if (!IsOwned(dialog, owner) || !IsOwned(yes, owner) || !IsWindowVisible(dialog) || ClassName(dialog) != "#32770" ||
            ClassName(yes) != "Button" || GetDlgCtrlID(yes) != 6 || GetParent(yes) != dialog || !IsWindowVisible(yes) || !IsWindowEnabled(yes)) return -1;
        if (!PostMessage(dialog, 0x0111, (UIntPtr)6u, yes)) throw new InvalidOperationException("Could not post the owned root-removal confirmation.");
        return 1;
    }

    // Returns 0 while waiting, 1 after exactly one matched confirmation, and
    // -1 on an unexpected/ambiguous dialog. Only the caller's owned child PID
    // is eligible; no focus, keyboard input or other process is used.
    public static int TryApproveRootImport(int owner, string expectedSha1, string expectedName) {
        var dialogs = new List<IntPtr>();
        Enumerate find = delegate(IntPtr window, IntPtr state) {
            if (IsOwned(window, owner) && IsWindowVisible(window) && ClassName(window) == "#32770") dialogs.Add(window);
            return dialogs.Count < 2;
        };
        EnumWindows(find, IntPtr.Zero);
        GC.KeepAlive(find);
        if (dialogs.Count == 0) return 0;
        if (dialogs.Count != 1) return -1;
        IntPtr dialog = dialogs[0];
        string title;
        if (!ReadText(dialog, out title) || String.IsNullOrWhiteSpace(title)) return 0;
        if (title != "Security Warning") return -1;
        var body = new StringBuilder();
        var yesButtons = new List<IntPtr>();
        bool valid = true;
        int count = 0;
        Enumerate children = delegate(IntPtr item, IntPtr state) {
            if (++count > 24 || body.Length > 8192) { valid = false; return false; }
            if (!IsOwned(item, owner)) { valid = false; return false; }
            string kind = ClassName(item), text;
            if (kind == "Static") {
                if (!ReadText(item, out text)) { valid = false; return false; }
                if (text.Length > 0) body.AppendLine(text);
            }
            if (kind == "Button" && GetDlgCtrlID(item) == 6 && GetParent(item) == dialog && IsWindowVisible(item) && IsWindowEnabled(item)) {
                if (!ReadText(item, out text) || (text != "&Yes" && text != "Yes")) { valid = false; return false; }
                yesButtons.Add(item);
            }
            return true;
        };
        EnumChildWindows(dialog, children, IntPtr.Zero);
        GC.KeepAlive(children);
        if (!valid || yesButtons.Count > 1) return -1;
        if (yesButtons.Count == 0 || !body.ToString().TrimEnd().EndsWith("Do you want to install this certificate?", StringComparison.Ordinal)) return 0;
        if (!MatchesExpectedImportText(title, body.ToString(), expectedSha1, expectedName)) return -1;
        IntPtr yes = yesButtons[0];
        if (!IsOwned(dialog, owner) || !IsOwned(yes, owner) || !IsWindowVisible(dialog) || ClassName(dialog) != "#32770" ||
            ClassName(yes) != "Button" || GetDlgCtrlID(yes) != 6 || GetParent(yes) != dialog || !IsWindowVisible(yes) || !IsWindowEnabled(yes)) return -1;
        // WM_COMMAND, IDYES, BN_CLICKED. Asynchronous, bounded and issued once.
        if (!PostMessage(dialog, 0x0111, (UIntPtr)6u, yes)) throw new InvalidOperationException("Could not post the owned root-import confirmation.");
        return 1;
    }

    public static string Describe(int owner) {
        var clock = Stopwatch.StartNew();
        var result = new StringBuilder();
        int windows = 0, controls = 0;
        Enumerate top = delegate(IntPtr window, IntPtr state) {
            if (clock.ElapsedMilliseconds >= 2000 || windows >= 4 || result.Length >= 7000) return false;
            uint process;
            GetWindowThreadProcessId(window, out process);
            if (process != (uint)owner) return true;
            windows++;
            result.Append("[window ").Append(DescribeWindow(window)).Append("] ");
            Enumerate child = delegate(IntPtr item, IntPtr ignored) {
                if (clock.ElapsedMilliseconds >= 2000 || controls >= 20 || result.Length >= 7000) return false;
                uint childOwner;
                GetWindowThreadProcessId(item, out childOwner);
                if (childOwner != (uint)owner) return true;
                controls++;
                result.Append("[control ").Append(DescribeWindow(item)).Append("] ");
                return true;
            };
            EnumChildWindows(window, child, IntPtr.Zero);
            GC.KeepAlive(child);
            return true;
        };
        EnumWindows(top, IntPtr.Zero);
        GC.KeepAlive(top);
        return result.Length == 0 ? "No windows belong to the trust worker PID." : result.ToString(0, Math.Min(result.Length, 8192));
    }
}
'@
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
