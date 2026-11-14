[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'High')]
param(
    [string]$CertificateDirectory = $PSScriptRoot,
    [Parameter(DontShow = $true)][switch]$CiApproveOwnedRemovalDialog
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'QQServiceTrust.Common.ps1')
if ($CiApproveOwnedRemovalDialog -and $env:GITHUB_ACTIONS -ne 'true') { throw 'The hidden owned-removal switch is restricted to explicit GitHub Actions tests.' }

# An expired publisher must remain removable. Fingerprint, purpose, public-key
# and self-signature checks still apply; only the current-time check is skipped.
$publisher = Read-QQServiceTrustCertificate -CertificateDirectory $CertificateDirectory -AllowExpired
try {
    $present = @()
    foreach ($name in @('Root', 'TrustedPublisher')) {
        $store = Open-QQServiceUserStore -Name $name
        try { if (@(Get-QQServiceStoreCertificate -Store $store -Publisher $publisher).Count) { $present += $name } }
        finally { $store.Dispose() }
    }
    if (-not $present.Count) { Write-Output 'No matching QQ_Service trust entries are present for the current Windows user.'; return }
    Write-Host ('Publisher: ' + $publisher.Certificate.Subject)
    Write-Host ('SHA256:    ' + $publisher.Sha256)
    if (-not $PSCmdlet.ShouldProcess(('CurrentUser\' + ($present -join ', CurrentUser\')), 'Remove trust for this exact QQ_Service publisher')) { return }
    $removed = @()
    $removalOptions = @{}
    if ($CiApproveOwnedRemovalDialog) { $removalOptions.ApproveOwnedRemovalDialog = $true }
    try {
        foreach ($name in $present) {
            if (Remove-QQServiceUserTrustCertificate -Name $name -Publisher $publisher @removalOptions) { $removed += $name }
        }
    }
    catch {
        foreach ($name in $removed) {
            try {
                $importOptions = @{}
                if ($CiApproveOwnedRemovalDialog) { $importOptions.ApproveOwnedImportDialog = $true }
                [void](Add-QQServiceUserTrustCertificate -Name $name -Publisher $publisher @importOptions)
            }
            catch { Write-Warning ('Could not restore the QQ_Service entry in CurrentUser\' + $name + '. Run the removal script again to check it.') }
        }
        throw
    }
    Write-Output 'Removed the matching QQ_Service trust entries. Other publishers and private-key stores were not changed.'
}
finally { $publisher.Certificate.Dispose() }
