import { createHash, X509Certificate } from 'node:crypto';
import { lstat, mkdir, mkdtemp, open, readFile, readdir, rm, copyFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const API = 'https://api.github.com';
const ARTIFACT_NAME = 'QQ_Service-Windows-x64-signed';
const WORKFLOW_PATH = '.github/workflows/windows.yml';
const MAX_ARCHIVE_BYTES = 256 * 1024 * 1024;
const MAX_EXPANDED_BYTES = 512 * 1024 * 1024;
const MAX_JSON_BYTES = 2 * 1024 * 1024;
const fail = message => Object.assign(new Error(message), { code: 'SIGNED_ARTIFACT_INVALID' });
const validSha = value => typeof value === 'string' && /^[a-f0-9]{40}$/u.test(value);
const digest = value => createHash('sha256').update(value).digest('hex');
const upperHex = (value, length) => typeof value === 'string' && new RegExp(`^[A-Fa-f0-9]{${length}}$`, 'u').test(value)
  ? value.toUpperCase() : null;

export function signedBundleNames(version) {
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?(?:\+[A-Za-z0-9.-]+)?$/u.test(version)) throw fail('The application version is invalid.');
  const executable = `QQ_Service-${version}-Windows-x64.exe`;
  return [executable, `${executable}.sha256`, 'QQ_Service.cer', 'certificate.json', 'signing-manifest.json',
    'Install-QQServiceTrust.ps1', 'Remove-QQServiceTrust.ps1', 'QQServiceTrust.Common.ps1', 'README.txt'];
}

/** Only a successful run of this repository's main workflow may supply a
 * production signature. A tag run, PR run, fork or same-name workflow cannot.
 */
export function isTrustedMainRun(run, { sourceSha, workflowId, repositoryId }) {
  return Boolean(run && validSha(sourceSha) && Number.isSafeInteger(workflowId) && Number.isSafeInteger(repositoryId)
    && run.head_sha === sourceSha && run.head_branch === 'main'
    && ['push', 'workflow_dispatch'].includes(run.event)
    && run.status === 'completed' && run.conclusion === 'success'
    && run.workflow_id === workflowId && run.path === WORKFLOW_PATH
    && run.repository?.id === repositoryId && run.head_repository?.id === repositoryId);
}

export function selectSignedArtifact(artifacts, { sourceSha, runId, repositoryId, now = Date.now() }) {
  const matches = (Array.isArray(artifacts) ? artifacts : []).filter(item => item?.name === ARTIFACT_NAME
    && item.expired === false && Number.isSafeInteger(item.id) && item.id > 0
    && Number.isFinite(item.size_in_bytes) && item.size_in_bytes > 0 && item.size_in_bytes <= MAX_ARCHIVE_BYTES
    && /^sha256:[a-f0-9]{64}$/u.test(item.digest || '')
    && Number.isFinite(Date.parse(item.expires_at)) && Date.parse(item.expires_at) > now
    && item.workflow_run?.id === runId && item.workflow_run?.head_sha === sourceSha
    && item.workflow_run?.head_branch === 'main'
    && item.workflow_run?.repository_id === repositoryId && item.workflow_run?.head_repository_id === repositoryId);
  return matches.sort((a, b) => b.id - a.id)[0] || null;
}

async function jsonFile(file, limit = 65536) {
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size > limit) throw fail('A signing metadata file is missing or invalid.');
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch { throw fail('A signing metadata file is not valid JSON.'); }
}

/** Content checks are separate from Windows Authenticode verification. The
 * command-line release path always performs both, in that order.
 */
export async function validateSignedBundleContents(directory, { version, sourceSha, expectedCertificate }) {
  if (!validSha(sourceSha)) throw fail('The requested source commit is invalid.');
  const expectedSha256 = upperHex(expectedCertificate?.sha256, 64);
  const expectedSha1 = upperHex(expectedCertificate?.sha1, 40);
  if (!expectedSha256 || !expectedSha1 || expectedCertificate?.usage !== 'codeSigning') throw fail('The pinned signing certificate is invalid.');
  const names = signedBundleNames(version);
  const entries = await readdir(directory, { withFileTypes: true });
  if (entries.length !== names.length || entries.some(entry => !entry.isFile() || entry.isSymbolicLink() || !names.includes(entry.name))) {
    throw fail('The signed bundle contains missing, linked or unexpected files.');
  }
  const metadata = await jsonFile(path.join(directory, 'certificate.json'));
  const manifest = await jsonFile(path.join(directory, 'signing-manifest.json'));
  const cer = await readFile(path.join(directory, 'QQ_Service.cer'));
  if (cer.length > 32768 || digest(cer).toUpperCase() !== expectedSha256) throw fail('The public certificate differs from the pinned publisher.');
  let certificate;
  try { certificate = new X509Certificate(cer); } catch { throw fail('The public certificate cannot be parsed.'); }
  if (certificate.fingerprint.replaceAll(':', '') !== expectedSha1 || certificate.fingerprint256.replaceAll(':', '') !== expectedSha256
    || upperHex(metadata.sha1, 40) !== expectedSha1 || upperHex(metadata.sha256, 64) !== expectedSha256
    || metadata.schemaVersion !== 1 || metadata.usage !== 'codeSigning'
    || metadata.subject !== expectedCertificate.subject || certificate.subject !== expectedCertificate.subject) {
    throw fail('The certificate identity does not match the reviewed publisher.');
  }
  const executable = names[0];
  if (manifest.schemaVersion !== 1 || manifest.sourceSha !== sourceSha || manifest.timestampRequired !== true
    || manifest.certificate?.subject !== expectedCertificate.subject
    || upperHex(manifest.certificate?.sha1, 40) !== expectedSha1
    || upperHex(manifest.certificate?.sha256, 64) !== expectedSha256
    || manifest.artifact?.name !== executable || !/^[a-f0-9]{64}$/u.test(manifest.artifact?.sha256 || '')
    || manifest.inner?.name !== 'QQ_Service.exe' || !/^[a-f0-9]{64}$/u.test(manifest.inner?.sha256 || '')) {
    throw fail('The signing receipt is not bound to this commit, executable and publisher.');
  }
  const executableInfo = await lstat(path.join(directory, executable));
  if (executableInfo.size < 2 || executableInfo.size > MAX_EXPANDED_BYTES) throw fail('The signed executable has an invalid size.');
  const bytes = await readFile(path.join(directory, executable));
  const actual = digest(bytes);
  if (bytes.subarray(0, 2).toString() !== 'MZ' || actual !== manifest.artifact.sha256) throw fail('The signed executable checksum does not match its receipt.');
  const checksum = (await readFile(path.join(directory, `${executable}.sha256`), 'utf8')).replace(/^\uFEFF/u, '').trim();
  if (checksum !== `${actual}  ${executable}`) throw fail('The final SHA256 file does not match the signed executable.');
  return { executable, sha256: actual, sourceSha, certificateSha256: expectedSha256, files: names };
}

async function readJsonResponse(response) {
  const length = Number(response.headers.get('content-length'));
  if (Number.isFinite(length) && length > MAX_JSON_BYTES) throw fail('GitHub metadata exceeded the allowed size.');
  const reader = response.body?.getReader();
  if (!reader) throw fail('GitHub returned empty metadata.');
  const buffers = []; let bytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > MAX_JSON_BYTES) throw fail('GitHub metadata exceeded the allowed size.');
      buffers.push(Buffer.from(chunk.value));
    }
    return JSON.parse(Buffer.concat(buffers).toString('utf8'));
  } catch (cause) {
    if (cause.code === 'SIGNED_ARTIFACT_INVALID') throw cause;
    throw fail('GitHub returned invalid metadata.');
  } finally { await reader.cancel().catch(() => {}); }
}

export function createGitHubReader({ repository, token, fetchImpl = fetch }) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository || '') || !token) throw fail('Repository access is not configured.');
  const prefix = `/repos/${repository}`;
  return async relative => {
    if ((relative !== '' && !relative.startsWith('/')) || relative.includes('..') || relative.includes('#')) throw fail('Invalid GitHub metadata path.');
    let response;
    try {
      response = await fetchImpl(`${API}${prefix}${relative}`, { headers: {
        accept: 'application/vnd.github+json', authorization: `Bearer ${token}`, 'x-github-api-version': '2022-11-28',
      }, redirect: 'error', signal: AbortSignal.timeout(20000) });
    } catch { throw fail('GitHub metadata could not be retrieved.'); }
    if (!response.ok) throw fail(`GitHub metadata request failed (HTTP ${response.status}).`);
    return readJsonResponse(response);
  };
}

export async function findTrustedMainArtifact({ reader, sourceSha, repositoryId, workflowId, now = Date.now() }) {
  const page = await reader(`/actions/workflows/${workflowId}/runs?head_sha=${sourceSha}&per_page=100`);
  const runs = (Array.isArray(page.workflow_runs) ? page.workflow_runs : [])
    .filter(run => isTrustedMainRun(run, { sourceSha, repositoryId, workflowId })).sort((a, b) => b.id - a.id);
  for (const run of runs) {
    const result = await reader(`/actions/runs/${run.id}/artifacts?per_page=100`);
    const artifact = selectSignedArtifact(result.artifacts, { sourceSha, runId: run.id, repositoryId, now });
    if (artifact) return { run, artifact };
  }
  return null;
}

export async function downloadSignedArchive({ repository, artifact, token, destination, fetchImpl = fetch }) {
  let address = `${API}/repos/${repository}/actions/artifacts/${artifact.id}/zip`;
  let response;
  for (let redirects = 0; redirects <= 5; redirects++) {
    try {
      response = await fetchImpl(address, { redirect: 'manual', signal: AbortSignal.timeout(90000), headers: redirects === 0
        ? { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' } : {} });
    } catch { throw fail('The signed artifact could not be downloaded.'); }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const next = response.headers.get('location');
      await response.body?.cancel().catch(() => {});
      let target;
      try { target = new URL(next, address); } catch { throw fail('GitHub returned an invalid artifact redirect.'); }
      if (target.protocol !== 'https:' || target.username || target.password || redirects === 5) throw fail('GitHub returned an unsafe artifact redirect.');
      // Never forward the repository token to signed blob URLs or later hops.
      address = target.href; continue;
    }
    break;
  }
  if (!response?.ok || !response.body) throw fail('GitHub did not return the signed artifact archive.');
  const file = await open(destination, 'wx', 0o600);
  const hash = createHash('sha256'); let size = 0;
  try {
    for await (const chunk of response.body) {
      size += chunk.byteLength;
      if (size > MAX_ARCHIVE_BYTES) throw fail('The signed artifact exceeded its archive limit.');
      hash.update(chunk);
      let offset = 0;
      while (offset < chunk.byteLength) {
        const written = await file.write(chunk, offset, chunk.byteLength - offset, null);
        if (!written.bytesWritten) throw fail('The signed archive could not be written completely.');
        offset += written.bytesWritten;
      }
    }
    if (size !== artifact.size_in_bytes || `sha256:${hash.digest('hex')}` !== artifact.digest) throw fail('The GitHub artifact archive checksum does not match.');
  } catch (cause) {
    await response.body.cancel?.().catch(() => {});
    if (cause.code === 'SIGNED_ARTIFACT_INVALID') throw cause;
    throw fail('The signed artifact archive could not be saved.');
  } finally { await file.close(); }
}

const EXTRACT_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$names = @($env:QQ_SIGNED_ALLOWED_NAMES | ConvertFrom-Json)
$seen = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
$archive = [System.IO.Compression.ZipFile]::OpenRead($env:QQ_SIGNED_ARCHIVE)
try {
  [long]$total = 0
  foreach ($entry in $archive.Entries) {
    if ($names -cnotcontains $entry.FullName -or -not $seen.Add($entry.FullName)) { throw 'Unexpected or duplicated signed bundle entry.' }
    $total += $entry.Length
    if ($total -gt ${MAX_EXPANDED_BYTES}) { throw 'Signed bundle expansion limit exceeded.' }
  }
  if ($seen.Count -ne $names.Count) { throw 'Signed bundle entries are incomplete.' }
} finally { $archive.Dispose() }
[System.IO.Compression.ZipFile]::ExtractToDirectory($env:QQ_SIGNED_ARCHIVE, $env:QQ_SIGNED_DESTINATION)
`;

export async function extractSignedArchive({ archive, destination, version }) {
  if (process.platform !== 'win32') throw fail('Signed bundle archive checks must run on Windows.');
  await execute('pwsh', ['-NoProfile', '-NonInteractive', '-Command', EXTRACT_SCRIPT], { windowsHide: true, timeout: 120000,
    env: { ...process.env, QQ_SIGNED_ARCHIVE: archive, QQ_SIGNED_DESTINATION: destination,
      QQ_SIGNED_ALLOWED_NAMES: JSON.stringify(signedBundleNames(version)) } });
}

export async function downloadSignedArtifact({ repository, sourceSha, token, projectRoot, outputDirectory,
  waitMs = 30 * 60 * 1000, pollMs = 15000, reader: suppliedReader } = {}) {
  if (process.platform !== 'win32') throw fail('Release signature verification must run on Windows.');
  if (!validSha(sourceSha) || !Number.isFinite(waitMs) || waitMs < 0 || waitMs > 30 * 60 * 1000) throw fail('The signed build request is invalid.');
  const metadata = await jsonFile(path.join(projectRoot, 'package.json'));
  const expectedCertificate = await jsonFile(path.join(projectRoot, 'signing', 'certificate.json'));
  const names = signedBundleNames(metadata.version);
  const reader = suppliedReader || createGitHubReader({ repository, token });
  const repo = await reader('');
  const workflow = await reader('/actions/workflows/windows.yml');
  if (!Number.isSafeInteger(repo.id) || repo.full_name?.toLowerCase() !== repository.toLowerCase()
    || !Number.isSafeInteger(workflow.id) || workflow.path !== WORKFLOW_PATH) throw fail('The expected repository or workflow could not be identified.');
  const deadline = Date.now() + waitMs;
  let selected;
  do {
    selected = await findTrustedMainArtifact({ reader, sourceSha, repositoryId: repo.id, workflowId: workflow.id });
    if (selected) break;
    if (Date.now() >= deadline) throw fail('No matching signed main build is available. Re-run that main commit build; unsigned releases are not allowed.');
    console.log('Waiting for the same-commit signed main build.');
    await new Promise(resolve => setTimeout(resolve, Math.min(pollMs, deadline - Date.now())));
  } while (true);
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'qq-signed-release-'));
  try {
    const archive = path.join(temporary, 'signed.zip'), extracted = path.join(temporary, 'bundle');
    await downloadSignedArchive({ repository, artifact: selected.artifact, token, destination: archive });
    await extractSignedArchive({ archive, destination: extracted, version: metadata.version });
    const result = await validateSignedBundleContents(extracted, { version: metadata.version, sourceSha, expectedCertificate });
    await execute('pwsh', ['-NoProfile', '-NonInteractive', '-File', path.join(projectRoot, 'scripts', 'windows-signing.ps1'),
      '-Action', 'VerifyBundle', '-ProjectRoot', projectRoot, '-BundleDirectory', extracted, '-SourceSha', sourceSha],
    { windowsHide: true, timeout: 120000 });
    await mkdir(outputDirectory, { recursive: false });
    for (const name of names) await copyFile(path.join(extracted, name), path.join(outputDirectory, name));
    console.log(JSON.stringify({ sourceSha, runId: selected.run.id, artifactId: selected.artifact.id, ...result }));
    return result;
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  downloadSignedArtifact({ repository: process.env.GITHUB_REPOSITORY, sourceSha: process.env.GITHUB_SHA,
    token: process.env.GITHUB_TOKEN, projectRoot: process.cwd(), outputDirectory: path.resolve('release-assets') })
    .catch(cause => { console.error(cause.code === 'SIGNED_ARTIFACT_INVALID' ? cause.message : 'Signed release verification failed.'); process.exitCode = 1; });
}
