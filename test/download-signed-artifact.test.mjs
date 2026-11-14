import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, copyFile, readFile, writeFile, rm, symlink, lstat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { signedBundleNames, isTrustedMainRun, selectSignedArtifact, validateSignedBundleContents,
  createGitHubReader, findTrustedMainArtifact, downloadSignedArchive, extractSignedArchive } from '../scripts/download-signed-artifact.mjs';

const execute = promisify(execFile);
const sourceSha = 'a'.repeat(40), repositoryId = 1234, workflowId = 5678, runId = 9911;
const fixtures = fileURLToPath(new URL('./fixtures/signing/', import.meta.url));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const trustedRun = () => ({ id: runId, head_sha: sourceSha, head_branch: 'main', event: 'push',
  status: 'completed', conclusion: 'success', workflow_id: workflowId, path: '.github/workflows/windows.yml',
  repository: { id: repositoryId }, head_repository: { id: repositoryId } });
const trustedArtifact = () => ({ id: 1010, name: 'QQ_Service-Windows-x64-signed', expired: false,
  size_in_bytes: 100, digest: `sha256:${'b'.repeat(64)}`, expires_at: new Date(Date.now() + 86400000).toISOString(),
  workflow_run: { id: runId, head_sha: sourceSha, head_branch: 'main', repository_id: repositoryId, head_repository_id: repositoryId } });

async function bundleFixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'qq-signed-content-'));
  const certificate = JSON.parse(await readFile(path.join(fixtures, 'certificate.json'), 'utf8'));
  await copyFile(path.join(fixtures, 'QQ_Service.cer'), path.join(directory, 'QQ_Service.cer'));
  await copyFile(path.join(fixtures, 'certificate.json'), path.join(directory, 'certificate.json'));
  const executable = signedBundleNames('0.8.0')[0], bytes = Buffer.from('MZ harmless content fixture, not executable code');
  await writeFile(path.join(directory, executable), bytes);
  await writeFile(path.join(directory, `${executable}.sha256`), `${hash(bytes)}  ${executable}\n`);
  const manifest = { schemaVersion: 1, sourceSha, timestampRequired: true,
    certificate: { subject: certificate.subject, sha1: certificate.sha1, sha256: certificate.sha256 },
    artifact: { name: executable, sha256: hash(bytes) }, inner: { name: 'QQ_Service.exe', sha256: 'c'.repeat(64) } };
  await writeFile(path.join(directory, 'signing-manifest.json'), JSON.stringify(manifest));
  for (const name of signedBundleNames('0.8.0').filter(name => name.endsWith('.ps1') || name === 'README.txt')) {
    await writeFile(path.join(directory, name), 'public fixture content');
  }
  return { directory, certificate, executable, bytes, manifest, close: () => rm(directory, { recursive: true, force: true }) };
}

test('signed release selection accepts only a successful exact-repository main workflow and source commit', () => {
  const options = { sourceSha, repositoryId, workflowId };
  assert.equal(isTrustedMainRun(trustedRun(), options), true);
  assert.equal(isTrustedMainRun({ ...trustedRun(), event: 'workflow_dispatch' }, options), true);
  for (const patch of [
    { head_sha: 'd'.repeat(40) }, { head_branch: 'fix/model-presets' }, { head_branch: 'v0.8.0' },
    { event: 'pull_request' }, { event: 'pull_request_target' }, { status: 'in_progress' }, { conclusion: 'failure' },
    { workflow_id: workflowId + 1 }, { path: '.github/workflows/other.yml' },
    { repository: { id: 9999 } }, { head_repository: { id: 9999 } },
  ]) assert.equal(isTrustedMainRun({ ...trustedRun(), ...patch }, options), false, JSON.stringify(patch));
});

test('unsigned, expired, oversized, digestless and foreign-run artifacts cannot supply a signed release', () => {
  const options = { sourceSha, repositoryId, runId };
  assert.equal(selectSignedArtifact([trustedArtifact()], options)?.id, 1010);
  for (const patch of [
    { name: 'QQ_Service-Windows-x64' }, { expired: true }, { expires_at: '2000-01-01T00:00:00Z' },
    { size_in_bytes: 0 }, { size_in_bytes: 300 * 1024 * 1024 }, { digest: null },
    { workflow_run: { ...trustedArtifact().workflow_run, id: runId + 1 } },
    { workflow_run: { ...trustedArtifact().workflow_run, head_sha: 'd'.repeat(40) } },
    { workflow_run: { ...trustedArtifact().workflow_run, head_repository_id: 9999 } },
  ]) assert.equal(selectSignedArtifact([{ ...trustedArtifact(), ...patch }], options), null, JSON.stringify(patch));
});

test('artifact discovery never reads artifacts of same-name PR, tag, fork or failed workflow runs', async () => {
  const requests = [];
  const reader = async relative => {
    requests.push(relative);
    if (relative.includes('/runs?')) return { workflow_runs: [
      { ...trustedRun(), id: 1001, event: 'pull_request' },
      { ...trustedRun(), id: 1002, head_branch: 'v0.8.0' },
      { ...trustedRun(), id: 1003, conclusion: 'failure' },
      { ...trustedRun(), id: 1004, head_repository: { id: 777 } }, trustedRun(),
    ] };
    assert.equal(relative, `/actions/runs/${runId}/artifacts?per_page=100`);
    return { artifacts: [trustedArtifact()] };
  };
  const found = await findTrustedMainArtifact({ reader, sourceSha, repositoryId, workflowId });
  assert.equal(found.run.id, runId); assert.equal(found.artifact.id, 1010); assert.equal(requests.length, 2);
});

test('metadata requests pin GitHub API and do not expose tokens or response text in failures', async () => {
  const calls = [], token = 'fixture-token-DO-NOT-PRINT';
  const reader = createGitHubReader({ repository: 'owner/QQ_Service', token, fetchImpl: async (url, options) => {
    calls.push({ url, options }); return new Response(JSON.stringify({ id: 1234 }), { status: 200 });
  } });
  assert.deepEqual(await reader(''), { id: 1234 });
  assert.equal(calls[0].url, 'https://api.github.com/repos/owner/QQ_Service');
  assert.equal(calls[0].options.headers.authorization, `Bearer ${token}`);
  assert.equal(calls[0].options.redirect, 'error');
  await assert.rejects(reader('https://evil.invalid/'), /Invalid GitHub metadata path/u);
  const denied = createGitHubReader({ repository: 'owner/QQ_Service', token,
    fetchImpl: async () => new Response(`secret ${token}`, { status: 403 }) });
  await assert.rejects(denied(''), cause => cause.message === 'GitHub metadata request failed (HTTP 403).');
  const crashed = createGitHubReader({ repository: 'owner/QQ_Service', token,
    fetchImpl: async () => { throw new Error(token); } });
  await assert.rejects(crashed(''), cause => !cause.message.includes(token));
});

test('signed archive download drops authorization on redirects and verifies the archive digest', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'qq-signed-download-'));
  const bytes = Buffer.from('fixture ZIP bytes, no executable code'), calls = [];
  const artifact = { ...trustedArtifact(), size_in_bytes: bytes.length, digest: `sha256:${hash(bytes)}` };
  try {
    await downloadSignedArchive({ repository: 'owner/QQ_Service', artifact, token: 'private-fixture-token',
      destination: path.join(directory, 'artifact.zip'), fetchImpl: async (url, options) => {
        calls.push({ url, options });
        return calls.length === 1
          ? new Response(null, { status: 302, headers: { location: 'https://results.blob.core.windows.net/signed?fixture=1' } })
          : new Response(bytes);
      } });
    assert.equal(calls.length, 2);
    assert.equal(calls[0].options.headers.authorization, 'Bearer private-fixture-token');
    assert.deepEqual(calls[1].options.headers, {});
    assert.deepEqual(await readFile(path.join(directory, 'artifact.zip')), bytes);
    await assert.rejects(downloadSignedArchive({ repository: 'owner/QQ_Service', artifact, token: 'private-fixture-token',
      destination: path.join(directory, 'wrong.zip'), fetchImpl: async () => new Response(Buffer.from('changed artifact')) }), /checksum does not match/u);
    await assert.rejects(downloadSignedArchive({ repository: 'owner/QQ_Service', artifact, token: 'private-fixture-token',
      destination: path.join(directory, 'unsafe.zip'), fetchImpl: async () => new Response(null,
        { status: 302, headers: { location: 'http://unsafe.invalid/download' } }) }), /unsafe artifact redirect/u);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('bundle contents bind all nine public files to the reviewed certificate, source SHA and final executable checksum', async () => {
  const fixture = await bundleFixture();
  try {
    const result = await validateSignedBundleContents(fixture.directory,
      { version: '0.8.0', sourceSha, expectedCertificate: fixture.certificate });
    assert.equal(result.executable, fixture.executable); assert.equal(result.files.length, 9);
    await assert.rejects(validateSignedBundleContents(fixture.directory,
      { version: '0.8.0', sourceSha: 'e'.repeat(40), expectedCertificate: fixture.certificate }), /receipt is not bound/u);
    await assert.rejects(validateSignedBundleContents(fixture.directory,
      { version: '0.8.0', sourceSha, expectedCertificate: { ...fixture.certificate, sha256: 'F'.repeat(64) } }), /differs from the pinned/u);
    await writeFile(path.join(fixture.directory, fixture.executable), Buffer.from('MZ altered executable'));
    await assert.rejects(validateSignedBundleContents(fixture.directory,
      { version: '0.8.0', sourceSha, expectedCertificate: fixture.certificate }), /checksum does not match/u);
  } finally { await fixture.close(); }
});

test('missing timestamps, linked files and private extras fail the release bundle content gate', async () => {
  const fixture = await bundleFixture();
  try {
    await writeFile(path.join(fixture.directory, 'signing-manifest.json'), JSON.stringify({ ...fixture.manifest, timestampRequired: false }));
    await assert.rejects(validateSignedBundleContents(fixture.directory,
      { version: '0.8.0', sourceSha, expectedCertificate: fixture.certificate }), /receipt is not bound/u);
    await writeFile(path.join(fixture.directory, 'signing-manifest.json'), JSON.stringify(fixture.manifest));
    await writeFile(path.join(fixture.directory, 'private.pfx'), 'this must never be published');
    await assert.rejects(validateSignedBundleContents(fixture.directory,
      { version: '0.8.0', sourceSha, expectedCertificate: fixture.certificate }), /unexpected files/u);
    await rm(path.join(fixture.directory, 'private.pfx'));
    await rm(path.join(fixture.directory, 'README.txt'));
    if (process.platform !== 'win32') {
      await symlink(path.join(fixture.directory, 'certificate.json'), path.join(fixture.directory, 'README.txt'));
      await assert.rejects(validateSignedBundleContents(fixture.directory,
        { version: '0.8.0', sourceSha, expectedCertificate: fixture.certificate }), /linked or unexpected/u);
    }
    assert.throws(() => signedBundleNames('../0.8.0'), /version is invalid/u);
  } finally { await fixture.close(); }
});

test('Windows archive extraction rejects traversal before writing any archive entry', { skip: process.platform !== 'win32' }, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'qq-signed-zip-'));
  try {
    const archive = path.join(directory, 'unsafe.zip');
    await execute('pwsh', ['-NoProfile', '-NonInteractive', '-Command', `
      Add-Type -AssemblyName System.IO.Compression.FileSystem
      $zip = [System.IO.Compression.ZipFile]::Open($env:QQ_TEST_ARCHIVE, [System.IO.Compression.ZipArchiveMode]::Create)
      try {
        $names = @($env:QQ_TEST_NAMES | ConvertFrom-Json)
        $names += '../escaped.txt'
        foreach ($name in $names) {
          $entry = $zip.CreateEntry($name)
          $writer = [IO.StreamWriter]::new($entry.Open())
          try { $writer.Write('fixture') } finally { $writer.Dispose() }
        }
      } finally { $zip.Dispose() }
    `], { env: { ...process.env, QQ_TEST_ARCHIVE: archive, QQ_TEST_NAMES: JSON.stringify(signedBundleNames('0.8.0')) }, windowsHide: true });
    await assert.rejects(extractSignedArchive({ archive, destination: path.join(directory, 'unpacked'), version: '0.8.0' }));
    await assert.rejects(lstat(path.join(directory, 'escaped.txt')), cause => cause.code === 'ENOENT');
    await assert.rejects(lstat(path.join(directory, 'unpacked')), cause => cause.code === 'ENOENT');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
