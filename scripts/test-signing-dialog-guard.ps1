[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
. (Join-Path $projectRoot 'signing/QQServiceTrust.Common.ps1')
Initialize-QQServiceOwnedWindowDiagnostics

# Static text transcribed from the observed Windows Security Warning format.
# Only the test publisher/fingerprint values are deterministic substitutions.
# These tests call the actual native helper's pure predicate; no window is
# enumerated, activated or clicked, and no certificate store is modified.
$expectedName = 'QQ_Service Self-Signed Publisher'
$expectedSha1 = '0123456789ABCDEF0123456789ABCDEF01234567'
$groupedHash = ((0..4 | ForEach-Object { $expectedSha1.Substring($_ * 8, 8) }) -join ' ')
$body = @"
You are about to install a certificate from a certification authority (CA) claiming to represent:

$expectedName

Windows cannot validate that the certificate is actually from "$expectedName". You should confirm its origin by contacting "$expectedName". The following number will assist you in this process:

Thumbprint (sha1):
$groupedHash

Warning:
If you install this root certificate, Windows will automatically trust any certificate issued by this CA. Installing a certificate with an unconfirmed thumbprint is a security risk. If you click "Yes" you acknowledge this risk.

Do you want to install this certificate?
"@
$body = $body.Replace("`r`n", "`n")
$script:checked = 0

function Assert-DialogGuard {
    param(
        [Parameter(Mandatory = $true)][string]$Case,
        [AllowNull()][string]$Title = 'Security Warning',
        [AllowNull()][string]$Text = $body,
        [AllowNull()][string]$Sha1 = $expectedSha1,
        [AllowNull()][string]$Name = $expectedName,
        [bool]$Expected = $false
    )
    $actual = [QQServiceOwnedTrustWindows]::MatchesExpectedImportText($Title, $Text, $Sha1, $Name)
    if ($actual -ne $Expected) { throw ('Dialog predicate failed for ' + $Case + ': expected ' + $Expected + ', got ' + $actual + '.') }
    $script:checked++
}

Assert-DialogGuard -Case 'observed complete Windows dialog' -Expected $true
Assert-DialogGuard -Case 'CRLF static controls and padded body' -Text ("`r`n" + $body.Replace("`n", "`r`n") + "`r`n") -Expected $true
Assert-DialogGuard -Case 'lowercase displayed SHA1 groups' -Text ($body.Replace($groupedHash, $groupedHash.ToLowerInvariant())) -Expected $true
Assert-DialogGuard -Case 'fingerprint groups separated by native control whitespace' -Text ($body.Replace($groupedHash, $groupedHash.Replace(' ', "`r`n"))) -Expected $true

Assert-DialogGuard -Case 'same subject but different complete fingerprint' -Text ($body.Replace($groupedHash, '11234567 89ABCDEF 01234567 89ABCDEF 01234567'))
Assert-DialogGuard -Case 'same dialog but wrong expected fingerprint' -Sha1 '1123456789ABCDEF0123456789ABCDEF01234567'
Assert-DialogGuard -Case 'claim has a different subject' -Text ($body.Replace(("`n" + $expectedName + "`n"), "`nAnother publisher`n"))
Assert-DialogGuard -Case 'quoted claimed subject differs' -Text ($body.Replace(('actually from "' + $expectedName + '".'), 'actually from "Another publisher".'))
Assert-DialogGuard -Case 'same fingerprint but different expected subject' -Name 'Another publisher'
Assert-DialogGuard -Case 'partial expected subject' -Name 'QQ_Service'
Assert-DialogGuard -Case 'regex metacharacters in expected subject cannot match arbitrary text' -Name 'QQ_Service.*Publisher'
Assert-DialogGuard -Case 'certificate removal rather than installation' -Text ($body.Replace('about to install a certificate', 'about to remove a certificate').Replace('want to install this certificate?', 'want to remove this certificate?'))
Assert-DialogGuard -Case 'wrong operation at final question' -Text ($body.Replace('Do you want to install this certificate?', 'Do you want to export this certificate?'))
Assert-DialogGuard -Case 'wrong window title' -Title 'Windows Security'
Assert-DialogGuard -Case 'title with a misleading suffix' -Title 'Security Warning - another process'
Assert-DialogGuard -Case 'missing window title' -Title $null
Assert-DialogGuard -Case 'duplicate fingerprint labels even with the same hash' -Text ($body.Replace('Warning:', ("Thumbprint (sha1):`n" + $groupedHash + "`nWarning:")))
Assert-DialogGuard -Case 'second issuer claim' -Text ($body.Replace('Warning:', "claiming to represent:`nAnother publisher`nWarning:"))
Assert-DialogGuard -Case 'truncated fingerprint group' -Text ($body.Replace($groupedHash, $groupedHash.Substring(0, $groupedHash.Length - 1)))
Assert-DialogGuard -Case 'missing fingerprint group' -Text ($body.Replace($groupedHash, $groupedHash.Substring(0, $groupedHash.Length - 9)))
Assert-DialogGuard -Case 'sixth fingerprint group sharing the expected prefix' -Text ($body.Replace($groupedHash, ($groupedHash + ' DEADBEEF')))
Assert-DialogGuard -Case 'one appended hex digit' -Text ($body.Replace($groupedHash, ($groupedHash + '0')))
Assert-DialogGuard -Case 'ungrouped fingerprint is not the observed dialog field' -Text ($body.Replace($groupedHash, $expectedSha1))
Assert-DialogGuard -Case 'unrelated field between fingerprint and warning' -Text ($body.Replace('Warning:', "Issuer: Another publisher`nWarning:"))
Assert-DialogGuard -Case 'missing warning field after hash' -Text ($body.Replace('Warning:', 'Notice:'))
Assert-DialogGuard -Case 'short expected fingerprint' -Sha1 ($expectedSha1.Substring(0, 32))
Assert-DialogGuard -Case 'lowercase expected fingerprint is not canonical pinned metadata' -Sha1 ($expectedSha1.ToLowerInvariant())
Assert-DialogGuard -Case 'newline injected into expected subject' -Name ($expectedName + "`nAnother publisher")
Assert-DialogGuard -Case 'oversized expected subject' -Name ('A' * 257)
Assert-DialogGuard -Case 'missing body' -Text $null
Assert-DialogGuard -Case 'oversized body' -Text ($body + ('A' * 8193))

# Exact public static text captured from the owned Windows removal dialog in
# the native fixture run. The full serial and SHA1 are matched independently;
# the legacy MD5 field is only a structural terminator, never a trust pin.
$removalSha1 = '534B3EBF286213B6970092FBBD4CD0C192B13CC8'
$removalHash = '534B3EBF 286213B6 970092FB BD4CD0C1 92B13CC8'
$removalSerial = '2BF64B3CDE7669A5451174AC5DE14442'
$groupedSerial = '2BF64B3C DE7669A5 451174AC 5DE14442'
$removalBody = @"
Do you want to DELETE the following certificate from the Root Store?

Subject : QQ_Service Self-Signed Publisher
Issuer : Self Issued
Time Validity : Saturday, November 14, 2026 through Sunday, November 15, 2026
Serial Number : $groupedSerial
Thumbprint (sha1) : $removalHash
Thumbprint (md5) : D9DCDE99 A4F69D63 66660F74 98F51FF0
"@
$removalBody = $removalBody.Replace("`r`n", "`n")

function Assert-RemovalDialogGuard {
    param(
        [Parameter(Mandatory = $true)][string]$Case,
        [AllowNull()][string]$Title = 'Root Certificate Store',
        [AllowNull()][string]$Text = $removalBody,
        [AllowNull()][string]$Sha1 = $removalSha1,
        [AllowNull()][string]$Name = $expectedName,
        [AllowNull()][string]$Serial = $removalSerial,
        [bool]$Expected = $false
    )
    $actual = [QQServiceOwnedTrustWindows]::MatchesExpectedRemovalText($Title, $Text, $Sha1, $Name, $Serial)
    if ($actual -ne $Expected) { throw ('Removal dialog predicate failed for ' + $Case + ': expected ' + $Expected + ', got ' + $actual + '.') }
    $script:checked++
}

Assert-RemovalDialogGuard -Case 'captured full Root Certificate Store dialog' -Expected $true
Assert-RemovalDialogGuard -Case 'native controls separated by multiple spaces' -Text ($removalBody.Replace("`n", '  ')) -Expected $true
Assert-RemovalDialogGuard -Case 'lowercase displayed serial and SHA1' -Text ($removalBody.Replace($removalHash, $removalHash.ToLowerInvariant()).Replace($groupedSerial, $groupedSerial.ToLowerInvariant())) -Expected $true
Assert-RemovalDialogGuard -Case 'wrong operation despite identical identity fields' -Text ($removalBody.Replace('DELETE', 'EXPORT'))
Assert-RemovalDialogGuard -Case 'installation dialog is not a removal operation' -Title 'Security Warning' -Text $body
Assert-RemovalDialogGuard -Case 'wrong window title' -Title 'Certificate Store'
Assert-RemovalDialogGuard -Case 'title with untrusted suffix' -Title 'Root Certificate Store - Another Application'
Assert-RemovalDialogGuard -Case 'same SHA1 but wrong displayed subject' -Text ($removalBody.Replace('Subject : QQ_Service Self-Signed Publisher', 'Subject : Another publisher'))
Assert-RemovalDialogGuard -Case 'subject sharing the expected prefix' -Text ($removalBody.Replace('Subject : QQ_Service Self-Signed Publisher', 'Subject : QQ_Service Self-Signed Publisher Administrator'))
Assert-RemovalDialogGuard -Case 'different expected subject' -Name 'Another publisher'
Assert-RemovalDialogGuard -Case 'issuer not self issued' -Text ($removalBody.Replace('Issuer : Self Issued', 'Issuer : Another Authority'))
Assert-RemovalDialogGuard -Case 'wrong displayed full SHA1' -Text ($removalBody.Replace($removalHash, '634B3EBF 286213B6 970092FB BD4CD0C1 92B13CC8'))
Assert-RemovalDialogGuard -Case 'wrong expected full SHA1' -Sha1 '634B3EBF286213B6970092FBBD4CD0C192B13CC8'
Assert-RemovalDialogGuard -Case 'truncated displayed SHA1' -Text ($removalBody.Replace($removalHash, '534B3EBF 286213B6 970092FB BD4CD0C1 92B13CC'))
Assert-RemovalDialogGuard -Case 'sixth SHA1 group sharing the expected prefix' -Text ($removalBody.Replace($removalHash, ($removalHash + ' DEADBEEF')))
Assert-RemovalDialogGuard -Case 'wrong displayed full serial' -Text ($removalBody.Replace($groupedSerial, '3BF64B3C DE7669A5 451174AC 5DE14442'))
Assert-RemovalDialogGuard -Case 'wrong expected full serial' -Serial '3BF64B3CDE7669A5451174AC5DE14442'
Assert-RemovalDialogGuard -Case 'truncated serial sharing the expected prefix' -Text ($removalBody.Replace($groupedSerial, '2BF64B3C DE7669A5 451174AC 5DE1444'))
Assert-RemovalDialogGuard -Case 'extra serial group sharing the expected prefix' -Text ($removalBody.Replace($groupedSerial, ($groupedSerial + ' DEADBEEF')))
Assert-RemovalDialogGuard -Case 'missing expected serial' -Serial $null
Assert-RemovalDialogGuard -Case 'duplicate subject fields' -Text ($removalBody.Replace('Issuer :', "Subject : Another publisher`nIssuer :"))
Assert-RemovalDialogGuard -Case 'duplicate fingerprint fields' -Text ($removalBody.Replace('Thumbprint (md5) :', ("Thumbprint (sha1) : " + $removalHash + "`nThumbprint (md5) :")))
Assert-RemovalDialogGuard -Case 'duplicate serial fields' -Text ($removalBody.Replace('Thumbprint (sha1) :', ("Serial Number : " + $groupedSerial + "`nThumbprint (sha1) :")))
Assert-RemovalDialogGuard -Case 'SHA1 present only as unrelated MD5 text' -Text ($removalBody.Replace($removalHash, '634B3EBF 286213B6 970092FB BD4CD0C1 92B13CC8').Replace('D9DCDE99 A4F69D63 66660F74 98F51FF0', $removalHash))
Assert-RemovalDialogGuard -Case 'unexpected field between SHA1 and MD5' -Text ($removalBody.Replace('Thumbprint (md5) :', "Issuer : Another Authority`nThumbprint (md5) :"))
Assert-RemovalDialogGuard -Case 'missing body' -Text $null
Assert-RemovalDialogGuard -Case 'oversized body' -Text ($removalBody + ('A' * 8193))

Write-Output ('PASS ' + $script:checked + ' actual dialog-predicate cases; no windows or certificate stores were touched.')
