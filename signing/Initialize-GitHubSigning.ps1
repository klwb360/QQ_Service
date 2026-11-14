[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'Medium')]
param(
    [string]$PublicDirectory = (Join-Path $env:LOCALAPPDATA 'QQ_Service/signing-public'),
    [switch]$ResumePublicCommit
)

# Operator-only, one-time setup. Never shipped in the signed application bundle.
# Run this on your own Windows computer, not in a constrained cloud connector.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$repository = 'klwb360/QQ_Service'
$branch = 'fix/model-presets'
$environmentName = 'windows-signing'
$publisherSubject = 'CN=QQ_Service Self-Signed Publisher'
$ghVersion = '2.104.0'
$ghZipSha256 = '08c06d10482f12c478018cd259f64acbd5f625712cadf331aad19ba973c879e5'
$secretNames = @('WINDOWS_SIGNING_PASSWORD', 'WINDOWS_SIGNING_PFX_BASE64')

if (-not $PSCmdlet.ShouldProcess("$repository / $environmentName / main only", 'Initialize the signing identity and commit only its public certificate to the existing PR branch')) { return }
if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) { throw 'Run this one-time initializer on your own Windows computer.' }
if (-not [Environment]::Is64BitOperatingSystem) { throw 'Windows x64 is required.' }
$PublicDirectory = [IO.Path]::GetFullPath($PublicDirectory)
if (Test-Path -LiteralPath $PublicDirectory) {
    if ((Get-Item -LiteralPath $PublicDirectory -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'The public output directory must not be a link.' }
}
$temporary = Join-Path ([IO.Path]::GetTempPath()) ('qq-service-signing-initialize-' + [Guid]::NewGuid().ToString('N'))
$privateCertificate = $null
$privateConfigured = $false
$createdSecrets = [Collections.Generic.List[string]]::new()
$ownedPublicFiles = [Collections.Generic.List[string]]::new()
$setupMutex = $null
$ownsMutex = $false
$oldTls = [Net.ServicePointManager]::SecurityProtocol

function Hex-Sha256([byte[]]$Bytes) {
    $hash = [Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($hash.ComputeHash($Bytes))).Replace('-', '') }
    finally { $hash.Dispose() }
}

function Quote-ProcessArgument([string]$Value) {
    # Windows CommandLineToArgvW quoting. Secrets are never arguments.
    $result = [Text.StringBuilder]::new()
    [void]$result.Append('"')
    $slashes = 0
    foreach ($character in $Value.ToCharArray()) {
        if ($character -eq [char]0x5C) { $slashes++; continue }
        if ($character -eq [char]0x22) {
            [void]$result.Append([char]0x5C, ($slashes * 2 + 1))
            [void]$result.Append($character)
        } else {
            if ($slashes) { [void]$result.Append([char]0x5C, $slashes) }
            [void]$result.Append($character)
        }
        $slashes = 0
    }
    if ($slashes) { [void]$result.Append([char]0x5C, ($slashes * 2)) }
    [void]$result.Append('"')
    return $result.ToString()
}

function Invoke-Gh {
    param([string[]]$Arguments, [string]$InputText, [switch]$AllowFailure, [switch]$SensitiveInput, [switch]$Interactive)
    $start = [Diagnostics.ProcessStartInfo]::new()
    $start.FileName = $script:ghExecutable
    $start.Arguments = (@($Arguments | ForEach-Object { Quote-ProcessArgument $_ }) -join ' ')
    $start.UseShellExecute = $false
    $start.CreateNoWindow = -not $Interactive
    $start.EnvironmentVariables.Remove('GH_DEBUG')
    $start.EnvironmentVariables['GH_PROMPT_DISABLED'] = '1'
    $start.EnvironmentVariables['GH_HOST'] = 'github.com'
    $start.EnvironmentVariables['NO_COLOR'] = '1'
    if (-not $Interactive) {
        $start.RedirectStandardInput = $true
        $start.RedirectStandardOutput = $true
        $start.RedirectStandardError = $true
    }
    $process = [Diagnostics.Process]::new()
    $process.StartInfo = $start
    try {
        [void]$process.Start()
        if ($Interactive) {
            $process.WaitForExit()
            if ($process.ExitCode -ne 0) { throw 'GitHub CLI browser authentication did not complete.' }
            return
        }
        $outputTask = $process.StandardOutput.ReadToEndAsync()
        $errorTask = $process.StandardError.ReadToEndAsync()
        if ($null -ne $InputText) { $process.StandardInput.Write($InputText) }
        $process.StandardInput.Close()
        $process.WaitForExit()
        $output = $outputTask.GetAwaiter().GetResult()
        $errorText = $errorTask.GetAwaiter().GetResult()
        $result = [pscustomobject]@{ Success = ($process.ExitCode -eq 0); Output = $output; Error = $errorText }
        if (-not $result.Success -and -not $AllowFailure) {
            if ($SensitiveInput) { throw 'GitHub refused to save a signing secret. No secret value was printed.' }
            $safeError = $errorText.Trim()
            if ($safeError.Length -gt 500) { $safeError = $safeError.Substring(0, 500) }
            throw ('GitHub operation failed: ' + $safeError)
        }
        return $result
    } finally { $process.Dispose() }
}

function GitHub-Json([string]$Path, [string]$Method = 'GET', $Body = $null) {
    $arguments = @('api', '--hostname', 'github.com', '--method', $Method, $Path)
    $text = $null
    if ($null -ne $Body) { $arguments += @('--input', '-'); $text = $Body | ConvertTo-Json -Depth 12 -Compress }
    $response = Invoke-Gh -Arguments $arguments -InputText $text
    if ([string]::IsNullOrWhiteSpace($response.Output)) { return $null }
    return ($response.Output | ConvertFrom-Json)
}

function Download-Gh {
    Add-Type -AssemblyName System.Net.Http
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $url = [Uri]("https://github.com/cli/cli/releases/download/v$ghVersion/gh_${ghVersion}_windows_amd64.zip")
    $archive = Join-Path $temporary 'github-cli.zip'
    $handler = [Net.Http.HttpClientHandler]::new()
    $handler.AllowAutoRedirect = $false
    $client = [Net.Http.HttpClient]::new($handler)
    $client.Timeout = [TimeSpan]::FromMinutes(5)
    [void]$client.DefaultRequestHeaders.UserAgent.ParseAdd('QQ-Service-signing-initializer/1.0')
    $response = $null
    try {
        for ($redirect = 0; $redirect -le 5; $redirect++) {
            if ($url.Scheme -cne 'https' -or $url.Host -notin @('github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com')) { throw 'Unexpected GitHub CLI download destination.' }
            $response = $client.GetAsync($url, [Net.Http.HttpCompletionOption]::ResponseHeadersRead).GetAwaiter().GetResult()
            if ([int]$response.StatusCode -in @(301, 302, 303, 307, 308)) {
                if (-not $response.Headers.Location) { throw 'Invalid GitHub CLI redirect.' }
                $next = [Uri]::new($url, $response.Headers.Location)
                $response.Dispose(); $response = $null; $url = $next
                continue
            }
            $response.EnsureSuccessStatusCode() | Out-Null
            break
        }
        if ($null -eq $response -or [int]$response.StatusCode -ne 200) { throw 'GitHub CLI download exceeded its redirect limit.' }
        if ($response.Content.Headers.ContentLength -gt 128MB) { throw 'GitHub CLI archive exceeds its size limit.' }
        $inputStream = $response.Content.ReadAsStreamAsync().GetAwaiter().GetResult()
        $outputStream = [IO.File]::Open($archive, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
        try {
            $buffer = [byte[]]::new(65536); [long]$total = 0
            while (($read = $inputStream.Read($buffer, 0, $buffer.Length)) -gt 0) {
                $total += $read
                if ($total -gt 128MB) { throw 'GitHub CLI archive exceeds its size limit.' }
                $outputStream.Write($buffer, 0, $read)
            }
        } finally { $outputStream.Dispose(); $inputStream.Dispose() }
    } finally { if ($response) { $response.Dispose() }; $client.Dispose(); $handler.Dispose() }
    if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant() -cne $ghZipSha256) { throw 'Official GitHub CLI archive checksum mismatch.' }
    $zip = [IO.Compression.ZipFile]::OpenRead($archive)
    try {
        if ($zip.Entries.Count -gt 10000) { throw 'Unexpected GitHub CLI archive.' }
        [long]$expanded = 0
        foreach ($entry in $zip.Entries) {
            $name = $entry.FullName
            if ($name.Contains('\') -or $name.StartsWith('/') -or $name.Contains(':') -or @($name.Split('/') | Where-Object { $_ -eq '..' }).Count -or (($entry.ExternalAttributes -shr 16) -band 0xF000) -eq 0xA000) { throw 'Unsafe GitHub CLI archive entry.' }
            $expanded += $entry.Length
            if ($expanded -gt 512MB) { throw 'GitHub CLI archive expands beyond its limit.' }
        }
        $executables = @($zip.Entries | Where-Object { $_.FullName -ceq 'bin/gh.exe' -or $_.FullName -ceq "gh_${ghVersion}_windows_amd64/bin/gh.exe" })
        if ($executables.Count -ne 1 -or $executables[0].Length -lt 1 -or $executables[0].Length -gt 128MB) { throw 'The verified GitHub CLI archive has no unique expected executable.' }
        $destination = Join-Path $temporary 'gh.exe'
        $stream = $executables[0].Open()
        $file = [IO.File]::Open($destination, [IO.FileMode]::CreateNew)
        try { $stream.CopyTo($file) } finally { $file.Dispose(); $stream.Dispose() }
        return $destination
    } finally { $zip.Dispose() }
}

function Assert-MainOnlyEnvironment {
    $path = "repos/$repository/environments/$environmentName"
    $existing = Invoke-Gh -Arguments @('api', '--hostname', 'github.com', $path) -AllowFailure
    if (-not $existing.Success) {
        if ($existing.Error -notmatch 'HTTP 404') { throw 'GitHub cannot read the signing environment. Check your own account permissions before generating a key.' }
        [void](GitHub-Json $path 'PUT' @{ wait_timer = 0; reviewers = @(); deployment_branch_policy = @{ protected_branches = $false; custom_branch_policies = $true } })
        [void](GitHub-Json ($path + '/deployment-branch-policies') 'POST' @{ name = 'main'; type = 'branch' })
    }
    $environment = GitHub-Json $path
    if ($null -eq $environment.deployment_branch_policy -or $environment.deployment_branch_policy.protected_branches -ne $false -or $environment.deployment_branch_policy.custom_branch_policies -ne $true) { throw 'An existing signing environment is not restricted to a custom main-only policy. Refusing to weaken or replace it.' }
    $policies = @( (GitHub-Json ($path + '/deployment-branch-policies')).branch_policies )
    if ($policies.Count -ne 1 -or $policies[0].name -cne 'main' -or $policies[0].type -cne 'branch') { throw 'The signing environment must allow only the main branch, never tags or pull requests.' }
    # A real permission probe before any certificate or private key is created.
    $key = GitHub-Json ($path + '/secrets/public-key')
    if (-not $key.key_id -or -not $key.key) { throw 'GitHub did not grant signing-secret management permission.' }
}

function Existing-PublicCertificate([string]$Ref = $branch) {
    $paths = @('signing/QQ_Service.cer', 'signing/certificate.json')
    $encodedRef = [Uri]::EscapeDataString($Ref)
    foreach ($name in $paths) {
        $result = Invoke-Gh -Arguments @('api', '--hostname', 'github.com', "repos/$repository/contents/${name}?ref=$encodedRef") -AllowFailure
        if ($result.Success) { throw 'A signing identity is already committed. This initializer will not rotate or replace it.' }
        if ($result.Error -notmatch 'HTTP 404') { throw 'Could not check whether a publisher identity already exists.' }
    }
}

function Existing-SigningSecrets {
    # Read each exact metadata endpoint; never infer absence from page one of
    # an environment's secret listing. Secret values cannot be read here.
    foreach ($name in $secretNames) {
        $result = Invoke-Gh -Arguments @('api', '--hostname', 'github.com', "repos/$repository/environments/$environmentName/secrets/$name") -AllowFailure
        if ($result.Success) { Write-Output $name }
        elseif ($result.Error -notmatch 'HTTP 404') { throw 'Could not determine whether a signing secret already exists. No key was generated.' }
    }
}

function Read-LocalPublicIdentity {
    $cer = Join-Path $PublicDirectory 'QQ_Service.cer'
    $json = Join-Path $PublicDirectory 'certificate.json'
    foreach ($file in @($cer, $json)) {
        $item = Get-Item -LiteralPath $file -Force
        if ($item.PSIsContainer -or $item.Length -gt 65536 -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Invalid local public identity resource.' }
    }
    $bytes = [IO.File]::ReadAllBytes($cer)
    $metadata = [IO.File]::ReadAllText($json) | ConvertFrom-Json
    $certificate = [Security.Cryptography.X509Certificates.X509Certificate2]::new($bytes)
    try {
        $fields = @('schemaVersion', 'subject', 'sha1', 'sha256', 'notBefore', 'notAfter', 'usage')
        if (@($metadata.PSObject.Properties.Name).Count -ne 7 -or @($metadata.PSObject.Properties.Name | Where-Object { $_ -cnotin $fields }).Count -or $metadata.schemaVersion -ne 1 -or $metadata.usage -cne 'codeSigning' -or $certificate.HasPrivateKey -or [Convert]::ToBase64String($bytes) -cne [Convert]::ToBase64String($certificate.RawData) -or $metadata.subject -cne $publisherSubject -or $certificate.Subject -cne $publisherSubject -or $certificate.Issuer -cne $publisherSubject -or $metadata.sha1 -cne $certificate.Thumbprint.ToUpperInvariant() -or $metadata.sha256 -cne (Hex-Sha256 $bytes)) { throw 'The local public identity is not the expected pinned certificate.' }
        if ($certificate.SignatureAlgorithm.Value -ne '1.2.840.113549.1.1.11') { throw 'The publisher certificate must be signed with SHA256.' }
        $rsa = [Security.Cryptography.X509Certificates.RSACertificateExtensions]::GetRSAPublicKey($certificate)
        try { if ($null -eq $rsa -or $rsa.KeySize -ne 4096) { throw 'The public publisher key must be RSA-4096.' } }
        finally { if ($null -ne $rsa) { $rsa.Dispose() } }
        $eku = @($certificate.Extensions | Where-Object { $_.Oid.Value -eq '2.5.29.37' })
        $constraints = @($certificate.Extensions | Where-Object { $_.Oid.Value -eq '2.5.29.19' })
        $keyUsage = @($certificate.Extensions | Where-Object { $_.Oid.Value -eq '2.5.29.15' })
        if ($eku.Count -ne 1 -or $constraints.Count -ne 1 -or $keyUsage.Count -ne 1) { throw 'The public certificate lacks its dedicated signing extensions.' }
        $typedEku = [Security.Cryptography.X509Certificates.X509EnhancedKeyUsageExtension]::new($eku[0], $eku[0].Critical)
        $typedConstraints = [Security.Cryptography.X509Certificates.X509BasicConstraintsExtension]::new($constraints[0], $constraints[0].Critical)
        $typedUsage = [Security.Cryptography.X509Certificates.X509KeyUsageExtension]::new($keyUsage[0], $keyUsage[0].Critical)
        if ($typedEku.EnhancedKeyUsages.Count -ne 1 -or $typedEku.EnhancedKeyUsages[0].Value -ne '1.3.6.1.5.5.7.3.3' -or $typedConstraints.CertificateAuthority -or $typedUsage.KeyUsages -ne [Security.Cryptography.X509Certificates.X509KeyUsageFlags]::DigitalSignature) { throw 'The public certificate must be a non-CA certificate dedicated to digital code signatures.' }
        return [pscustomobject]@{ Bytes = $bytes; Metadata = $metadata; JsonBytes = [IO.File]::ReadAllBytes($json) }
    } finally { $certificate.Dispose() }
}

function Write-NewPublicFile([string]$Name, [byte[]]$Bytes) {
    $path = Join-Path $PublicDirectory $Name
    $stream = [IO.File]::Open($path, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    $ownedPublicFiles.Add($path)
    try { $stream.Write($Bytes, 0, $Bytes.Length) }
    finally { $stream.Dispose() }
}

function Commit-PublicIdentity($Identity) {
    $cerBlob = GitHub-Json "repos/$repository/git/blobs" 'POST' @{ encoding = 'base64'; content = [Convert]::ToBase64String($Identity.Bytes) }
    $jsonBlob = GitHub-Json "repos/$repository/git/blobs" 'POST' @{ encoding = 'base64'; content = [Convert]::ToBase64String($Identity.JsonBytes) }
    foreach ($sha in @($cerBlob.sha, $jsonBlob.sha)) { if ($sha -cnotmatch '^[0-9a-f]{40}$') { throw 'Invalid public blob response from GitHub.' } }
    for ($attempt = 0; $attempt -lt 3; $attempt++) {
        $reference = GitHub-Json "repos/$repository/git/ref/heads/$branch"
        $head = $reference.object.sha
        if ($head -cnotmatch '^[0-9a-f]{40}$') { throw 'Invalid source branch reference.' }
        # Check the same immutable parent that will supply base_tree, not a
        # floating branch which another public identity commit could change.
        Existing-PublicCertificate -Ref $head
        $parent = GitHub-Json "repos/$repository/git/commits/$head"
        $tree = GitHub-Json "repos/$repository/git/trees" 'POST' @{ base_tree = $parent.tree.sha; tree = @(
            @{ path = 'signing/QQ_Service.cer'; mode = '100644'; type = 'blob'; sha = $cerBlob.sha },
            @{ path = 'signing/certificate.json'; mode = '100644'; type = 'blob'; sha = $jsonBlob.sha }
        ) }
        $commit = GitHub-Json "repos/$repository/git/commits" 'POST' @{ message = 'chore: pin the public Windows signing identity'; tree = $tree.sha; parents = @($head) }
        $payload = @{ sha = $commit.sha; force = $false } | ConvertTo-Json -Compress
        $update = Invoke-Gh -Arguments @('api', '--hostname', 'github.com', '--method', 'PATCH', "repos/$repository/git/refs/heads/$branch", '--input', '-') -InputText $payload -AllowFailure
        if ($update.Success) { return $commit.sha }
        if ($update.Error -notmatch 'HTTP (409|422)') { throw 'The public identity commit could not be confirmed. The encrypted GitHub secrets and local public files have been preserved.' }
        # Re-read the actual branch and create a new public tree on top of it.
    }
    throw 'The branch changed repeatedly. Encrypted secrets and public files are preserved; resume the public commit after other pushes finish.'
}

try {
    $userSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $setupMutex = [Threading.Mutex]::new($false, ('Local\QQ_ServiceSigningInitialize-' + $userSid))
    try { $ownsMutex = $setupMutex.WaitOne(0) }
    catch [Threading.AbandonedMutexException] { $ownsMutex = $true }
    if (-not $ownsMutex) { throw 'Another signing initializer is running for this Windows user. Wait for it to finish; do not initialize from multiple computers at once.' }
    [void][IO.Directory]::CreateDirectory($temporary)
    $acl = [Security.AccessControl.DirectorySecurity]::new()
    $acl.SetAccessRuleProtection($true, $false)
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent().User
    $rights = [Security.AccessControl.FileSystemAccessRule]::new($identity, [Security.AccessControl.FileSystemRights]::FullControl, ([Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit), [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow)
    [void]$acl.AddAccessRule($rights)
    Set-Acl -LiteralPath $temporary -AclObject $acl
    [Net.ServicePointManager]::SecurityProtocol = $oldTls -bor [Net.SecurityProtocolType]::Tls12
    Write-Host "Downloading and verifying official portable GitHub CLI $ghVersion..."
    $script:ghExecutable = Download-Gh
    $login = Invoke-Gh -Arguments @('api', '--hostname', 'github.com', 'user') -AllowFailure
    if (-not $login.Success) {
        Write-Host 'Complete the official GitHub CLI browser authentication using klwb360. No password or token is sent to ChatGPT.'
        Invoke-Gh -Arguments @('auth', 'login', '--hostname', 'github.com', '--git-protocol', 'https', '--web', '--scopes', 'repo') -Interactive
        $login = Invoke-Gh -Arguments @('api', '--hostname', 'github.com', 'user')
    }
    if (($login.Output | ConvertFrom-Json).login -ine 'klwb360') { throw 'Use the repository owner account klwb360. Existing other GitHub accounts were not changed.' }
    $repo = GitHub-Json "repos/$repository"
    if ($repo.permissions.admin -ne $true) { throw 'The authenticated account is not an administrator of QQ_Service.' }
    Existing-PublicCertificate
    Assert-MainOnlyEnvironment
    $existingSecrets = @(Existing-SigningSecrets)
    if ($ResumePublicCommit) {
        foreach ($secret in $secretNames) { if ($existingSecrets -cnotcontains $secret) { throw 'The expected encrypted secrets do not exist; public-only resume was refused.' } }
        $public = Read-LocalPublicIdentity
        $privateConfigured = $true
    } else {
        foreach ($secret in $secretNames) { if ($existingSecrets -ccontains $secret) { throw 'Signing secrets already exist. Do not rotate them; use -ResumePublicCommit only with the matching preserved public files.' } }
        if ((Test-Path -LiteralPath (Join-Path $PublicDirectory 'QQ_Service.cer')) -or (Test-Path -LiteralPath (Join-Path $PublicDirectory 'certificate.json'))) { throw 'Local public signing files already exist. Refusing to replace the previous identity.' }
        $before = [DateTime]::Now.AddMinutes(-5)
        $privateCertificate = New-SelfSignedCertificate -Type CodeSigningCert -Subject $publisherSubject -CertStoreLocation 'Cert:\CurrentUser\My' -KeyAlgorithm RSA -KeyLength 4096 -HashAlgorithm SHA256 -KeyUsage DigitalSignature -KeyExportPolicy Exportable -NotBefore $before -NotAfter $before.AddDays(1095) -TextExtension @('2.5.29.19={critical}{text}ca=0')
        [void][IO.Directory]::CreateDirectory($PublicDirectory)
        Write-NewPublicFile 'QQ_Service.cer' $privateCertificate.RawData
        $metadata = [ordered]@{ schemaVersion = 1; subject = $privateCertificate.Subject; sha1 = $privateCertificate.Thumbprint.ToUpperInvariant(); sha256 = (Hex-Sha256 $privateCertificate.RawData); notBefore = $privateCertificate.NotBefore.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ', [Globalization.CultureInfo]::InvariantCulture); notAfter = $privateCertificate.NotAfter.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ', [Globalization.CultureInfo]::InvariantCulture); usage = 'codeSigning' }
        Write-NewPublicFile 'certificate.json' ([Text.UTF8Encoding]::new($false).GetBytes(($metadata | ConvertTo-Json) + "`n"))
        $public = Read-LocalPublicIdentity
        $random = [Security.Cryptography.RandomNumberGenerator]::Create(); $randomBytes = [byte[]]::new(48)
        try { $random.GetBytes($randomBytes); $password = [Convert]::ToBase64String($randomBytes) }
        finally { $random.Dispose(); [Array]::Clear($randomBytes, 0, $randomBytes.Length) }
        $pfxPath = Join-Path $temporary 'certificate.pfx'
        Export-PfxCertificate -Cert $privateCertificate -FilePath $pfxPath -Password (ConvertTo-SecureString -String $password -AsPlainText -Force) -ChainOption EndEntityCertOnly | Out-Null
        $pfxBytes = [IO.File]::ReadAllBytes($pfxPath)
        try {
            $createdSecrets.Add('WINDOWS_SIGNING_PASSWORD')
            [void](Invoke-Gh -Arguments @('secret', 'set', 'WINDOWS_SIGNING_PASSWORD', '--repo', $repository, '--env', $environmentName) -InputText $password -SensitiveInput)
            $createdSecrets.Add('WINDOWS_SIGNING_PFX_BASE64')
            [void](Invoke-Gh -Arguments @('secret', 'set', 'WINDOWS_SIGNING_PFX_BASE64', '--repo', $repository, '--env', $environmentName) -InputText ([Convert]::ToBase64String($pfxBytes)) -SensitiveInput)
            $privateConfigured = $true
        } finally { [Array]::Clear($pfxBytes, 0, $pfxBytes.Length); $password = $null }
    }
    $commit = Commit-PublicIdentity $public
    Write-Host ('SUCCESS: encrypted signing secrets are restricted to main; only public certificate files were committed: ' + $commit)
    Write-Host ('Publisher SHA256: ' + $public.Metadata.sha256)
    Write-Host ('Local public files: ' + $PublicDirectory)
    Write-Host 'Return to the project conversation and report completion. This script did not merge or release the project, install trust, or retain a local private key.'
} catch {
    if (-not $privateConfigured) {
        # These names were absent before this attempt. Include a write whose
        # acknowledgement was lost, but never an existing publisher identity.
        $rollbackComplete = $true
        foreach ($secret in $createdSecrets) {
            try {
                $deleted = Invoke-Gh -Arguments @('secret', 'delete', $secret, '--repo', $repository, '--env', $environmentName) -AllowFailure -SensitiveInput
                if (-not $deleted.Success -and $deleted.Error -notmatch 'HTTP 404') { $rollbackComplete = $false }
            } catch { $rollbackComplete = $false }
        }
        if ($rollbackComplete) {
            foreach ($path in $ownedPublicFiles) {
                if (Test-Path -LiteralPath $path) {
                    if ((Get-Item -LiteralPath $path -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'An owned public file became a link; refusing cleanup.' }
                    Remove-Item -LiteralPath $path -Force
                }
            }
            Write-Warning 'Initialization did not complete. This attempt left no signing key, secret or orphan public file; retry after resolving the reported error.'
        } else {
            Write-Warning ('Initialization did not complete and secret rollback could not be confirmed. Preserve the PUBLIC files in ' + $PublicDirectory + '. Check both environment secret names before retrying; do not generate a replacement identity.')
        }
    } else {
        Write-Warning ('Encrypted secrets were saved. Keep the PUBLIC files in ' + $PublicDirectory + '; do not generate a replacement key. To retry only the atomic public commit, run this script with -ResumePublicCommit.')
    }
    throw
} finally {
    $cleanupErrors = [Collections.Generic.List[string]]::new()
    try {
        if ($null -ne $privateCertificate) {
            $certificatePath = 'Cert:\CurrentUser\My\' + $privateCertificate.Thumbprint
            if (Test-Path -LiteralPath $certificatePath) {
                $existing = Get-Item -LiteralPath $certificatePath
                if ((Hex-Sha256 $existing.RawData) -cne (Hex-Sha256 $privateCertificate.RawData)) { throw 'The temporary signer fingerprint changed.' }
                Remove-Item -LiteralPath $certificatePath -DeleteKey -Force
            }
        }
    } catch { $cleanupErrors.Add('Could not remove the temporary private certificate from CurrentUser/My.') }
    finally { if ($null -ne $privateCertificate) { $privateCertificate.Dispose() } }
    try { [Net.ServicePointManager]::SecurityProtocol = $oldTls }
    catch { $cleanupErrors.Add('Could not restore this process TLS settings.') }
    try {
        if (Test-Path -LiteralPath $temporary) {
            if ((Get-Item -LiteralPath $temporary -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'The setup temporary directory became a link; refusing recursive cleanup.' }
            Remove-Item -LiteralPath $temporary -Recurse -Force
        }
    } catch { $cleanupErrors.Add('Could not confirm cleanup of the private temporary directory.') }
    try { if ($ownsMutex) { $setupMutex.ReleaseMutex() } }
    catch { $cleanupErrors.Add('Could not release the local initializer lock.') }
    finally { if ($null -ne $setupMutex) { $setupMutex.Dispose() } }
    if ($cleanupErrors.Count) {
        foreach ($message in $cleanupErrors) { Write-Warning $message }
        throw 'Setup cleanup was incomplete. Check the reported CurrentUser certificate or temporary files before continuing.'
    }
}
