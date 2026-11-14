[CmdletBinding()]
param([string]$ProjectRoot = (Split-Path -Parent $PSScriptRoot))

# Uses the actual initializer functions with a local, no-network fake gh.exe.
# No account authentication, certificate generation or signing secrets.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) { throw 'This native stdin regression requires Windows.' }
$directory = Join-Path ([IO.Path]::GetTempPath()) ('qq-signing-stdin-' + [Guid]::NewGuid().ToString('N'))
$originalEncoding = [Console]::InputEncoding
[void][IO.Directory]::CreateDirectory($directory)

function Assert-Input([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw ('Bootstrap stdin regression failed: ' + $Message) }
}

try {
    $tokens = $null; $parseErrors = $null
    $source = Join-Path $ProjectRoot 'signing/Initialize-GitHubSigning.ps1'
    $ast = [Management.Automation.Language.Parser]::ParseFile($source, [ref]$tokens, [ref]$parseErrors)
    Assert-Input ($parseErrors.Count -eq 0) 'initializer must parse'
    foreach ($name in @('Quote-ProcessArgument', 'Invoke-Gh', 'GitHub-Json')) {
        $definitions = @($ast.FindAll({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -ceq $name }, $false))
        Assert-Input ($definitions.Count -eq 1) 'the real helper function must be unique'
        . ([ScriptBlock]::Create($definitions[0].Extent.Text))
    }
    $fakeSource = @'
using System;
using System.IO;
using System.Security.Cryptography;
public static class BootstrapInputFixture {
    public static int Main(string[] args) {
        byte[] input;
        using (var memory = new MemoryStream()) {
            Console.OpenStandardInput().CopyTo(memory);
            input = memory.ToArray();
        }
        if (args.Length > 0 && args[0] == "--fail-echo") {
            Console.Error.Write(System.Text.Encoding.UTF8.GetString(input));
            return 4;
        }
        bool bom = input.Length >= 3 && input[0] == 239 && input[1] == 187 && input[2] == 191;
        string digest;
        using (var sha = SHA256.Create()) digest = BitConverter.ToString(sha.ComputeHash(input)).Replace("-", "");
        Console.WriteLine("{\"length\":" + input.Length + ",\"sha256\":\"" + digest + "\",\"hasBom\":" + (bom ? "true" : "false") + "}");
        return 0;
    }
}
'@
    $cs = Join-Path $directory 'input-fixture.cs'
    $script:ghExecutable = Join-Path $directory 'fake-gh.exe'
    [IO.File]::WriteAllText($cs, $fakeSource, [Text.UTF8Encoding]::new($false))
    $compiler = Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
    if (-not (Test-Path -LiteralPath $compiler)) { $compiler = Join-Path $env:WINDIR 'Microsoft.NET/Framework/v4.0.30319/csc.exe' }
    Assert-Input (Test-Path -LiteralPath $compiler) 'the Windows .NET Framework compiler must be available'
    & $compiler /nologo /target:exe (('/out:' + $script:ghExecutable)) $cs
    Assert-Input ($LASTEXITCODE -eq 0) 'native stdin fixture must compile'
    $unicodeJson = '{"message":"' + [char]0x4E2D + [char]0x6587 + '"}'
    $cases = @('{"deployment_branch_policy":{"protected_branches":false,"custom_branch_policies":true}}', $unicodeJson, 'ZHVtbXktcGZ4LXRlc3QtZGF0YQ==', 'Only-A-Dummy-Password-For-This-Test_1234')
    foreach ($forceBom in @($false, $true)) {
        if ($forceBom) { [Console]::InputEncoding = [Text.UTF8Encoding]::new($true) }
        else { [Console]::InputEncoding = $originalEncoding }
        $expectedCodePage = [Console]::InputEncoding.CodePage
        $expectedPreamble = [Convert]::ToBase64String([Console]::InputEncoding.GetPreamble())
        foreach ($text in $cases) {
            $received = (Invoke-Gh -Arguments @('--inspect') -InputText $text).Output | ConvertFrom-Json
            $bytes = [Text.UTF8Encoding]::new($false).GetBytes($text)
            $sha = [Security.Cryptography.SHA256]::Create()
            try { $expectedHash = ([BitConverter]::ToString($sha.ComputeHash($bytes))).Replace('-', '') }
            finally { $sha.Dispose() }
            Assert-Input ($received.length -eq $bytes.Length -and $received.sha256 -ceq $expectedHash -and $received.hasBom -eq $false) 'JSON and secrets must reach native stdin as exact UTF8 bytes without a BOM'
            Assert-Input ([Console]::InputEncoding.CodePage -eq $expectedCodePage -and [Convert]::ToBase64String([Console]::InputEncoding.GetPreamble()) -ceq $expectedPreamble) 'the parent console encoding must be restored'
        }
    }
    $dummy = 'DUMMY-SECRET-MUST-NOT-APPEAR-IN-AN-ERROR'
    $rejected = $false
    try { [void](Invoke-Gh -Arguments @('--fail-echo') -InputText $dummy -SensitiveInput) }
    catch {
        $rejected = $true
        Assert-Input (-not $_.Exception.Message.Contains($dummy)) 'native secret echoes must not be exposed in helper errors'
    }
    Assert-Input $rejected 'a failed native secret upload must fail closed'
    Write-Host ('PASS exact UTF8-no-BOM JSON/password/PFX stdin, forced BOM parent encoding restore and private error redaction on PowerShell ' + $PSVersionTable.PSVersion.ToString())
} finally {
    [Console]::InputEncoding = $originalEncoding
    if (Test-Path -LiteralPath $directory) { Remove-Item -LiteralPath $directory -Recurse -Force }
}
