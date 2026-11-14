[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'High')]
param([string]$CertificateDirectory = $PSScriptRoot)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'QQServiceTrust.Common.ps1')

$publisher = Read-QQServiceTrustCertificate -CertificateDirectory $CertificateDirectory
try {
    $missing = @()
    foreach ($name in @('Root', 'TrustedPublisher')) {
        $store = Open-QQServiceUserStore -Name $name
        try { if (@(Get-QQServiceStoreCertificate -Store $store -Publisher $publisher).Count -eq 0) { $missing += $name } }
        finally { $store.Dispose() }
    }
    if (-not $missing.Count) { Write-Output 'QQ_Service is already trusted for the current Windows user.'; return }
    Write-Host ('Publisher: ' + $publisher.Certificate.Subject)
    Write-Host ('SHA256:    ' + $publisher.Sha256)
    Write-Host ('Valid to:  ' + $publisher.Certificate.NotAfter.ToUniversalTime().ToString('u'))
    Write-Host 'Compare this fingerprint with the public certificate metadata in the source commit before continuing.'
    if (-not $PSCmdlet.ShouldProcess(('CurrentUser\' + ($missing -join ', CurrentUser\')), 'Trust the displayed QQ_Service code-signing publisher')) { return }
    $added = @()
    try {
        foreach ($name in $missing) {
            if (Add-QQServiceUserTrustCertificate -Name $name -Publisher $publisher) { $added += $name }
        }
    }
    catch {
        foreach ($name in $added) {
            try {
                $store = Open-QQServiceUserStore -Name $name -Writable
                try { foreach ($item in @(Get-QQServiceStoreCertificate -Store $store -Publisher $publisher)) { $store.Remove($item) } }
                finally { $store.Dispose() }
            }
            catch { Write-Warning ('Could not roll back the new QQ_Service entry in CurrentUser\' + $name + '. Run the removal script to check it.') }
        }
        throw
    }
    Write-Output 'QQ_Service trust installed for the current Windows user. No machine-wide store or execution policy was changed.'
}
finally { $publisher.Certificate.Dispose() }
