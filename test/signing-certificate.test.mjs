import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { readSigningCertificate, createSignedBuildConfiguration, portableName } = require('../scripts/signing-certificate.cjs');
const source = path.resolve('test/fixtures/signing');
const fixtureMetadata = JSON.parse(fs.readFileSync(path.join(source, 'certificate.json'), 'utf8'));
const fixtureNow = new Date(Date.parse(fixtureMetadata.notBefore) + 60_000);

function copyPublicCertificate(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-signing-public-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  for (const name of ['QQ_Service.cer', 'certificate.json']) fs.copyFileSync(path.join(source, name), path.join(directory, name));
  const metadata = JSON.parse(fs.readFileSync(path.join(directory, 'certificate.json'), 'utf8'));
  return { directory, metadata, write(value) { fs.writeFileSync(path.join(directory, 'certificate.json'), JSON.stringify(value)); } };
}

test('checked-in public fixture contains only a pinned code-signing certificate', () => {
  const result = readSigningCertificate({ directory: source, now: fixtureNow });
  assert.equal(result.certificate.publicKey.asymmetricKeyDetails.modulusLength, 4096);
  assert.equal(result.metadata.usage, 'codeSigning');
  assert.match(result.sha1, /^[A-F0-9]{40}$/u); assert.match(result.sha256, /^[A-F0-9]{64}$/u);
  assert.equal(result.certificate.ca, false);
  assert.ok(result.certificate.keyUsage.includes('1.3.6.1.5.5.7.3.3'));
  assert.equal(result.certificate.subject, 'CN=QQ_Service Self-Signed Publisher');
  assert.deepEqual(fs.readFileSync(path.join(source, 'QQ_Service.cer')), result.certificate.raw);
});

test('production signing resources contain a current valid public code-signing certificate',
  { skip: !fs.existsSync(path.resolve('signing/QQ_Service.cer')) && 'production certificate provisioning pending' }, () => {
    const result = readSigningCertificate({ directory: path.resolve('signing') });
    assert.equal(result.metadata.usage, 'codeSigning');
    assert.notEqual(result.sha256, fixtureMetadata.sha256, 'production publisher must not reuse the disposable test certificate');
  });

test('certificate fingerprint, purpose, metadata and time cannot silently drift', t => {
  const f = copyPublicCertificate(t);
  for (const change of [{ sha1: '0'.repeat(40) }, { sha256: '0'.repeat(64) }, { subject: 'Wrong publisher' },
    { usage: 'serverAuth' }, { notAfter: '2030-01-01T00:00:00.000Z' }, { unexpected: true }]) {
    f.write({ ...f.metadata, ...change });
    assert.throws(() => readSigningCertificate({ directory: f.directory, now: fixtureNow }), { code: 'SIGNING_CERTIFICATE_INVALID' });
  }
  f.write(f.metadata);
  assert.throws(() => readSigningCertificate({ directory: f.directory, now: new Date(Date.parse(f.metadata.notBefore) - 1) }), /not currently valid/u);
  assert.throws(() => readSigningCertificate({ directory: f.directory, now: new Date(Date.parse(f.metadata.notAfter) + 1) }), /not currently valid/u);
  fs.writeFileSync(path.join(f.directory, 'QQ_Service.cer'), 'not a certificate');
  assert.throws(() => readSigningCertificate({ directory: f.directory }), { code: 'SIGNING_CERTIFICATE_INVALID' });
});

test('public certificate container cannot include PEM wrappers or appended private material', t => {
  const f = copyPublicCertificate(t), original = readSigningCertificate({ directory: f.directory, now: fixtureNow }).certificate;
  for (const bytes of [Buffer.from(original.toString()), Buffer.concat([original.raw, Buffer.from('appended private material')])]) {
    fs.writeFileSync(path.join(f.directory, 'QQ_Service.cer'), bytes);
    assert.throws(() => readSigningCertificate({ directory: f.directory }), { code: 'SIGNING_CERTIFICATE_INVALID' });
  }
});

test('signed overlay signs only own current-version executables through the official SHA256 signing path', () => {
  const config = createSignedBuildConfiguration({ projectRoot: process.cwd(), version: '0.8.0', certificateDirectory: source, now: fixtureNow });
  assert.equal(config.extends, path.resolve('electron-builder.yml'));
  assert.equal(config.forceCodeSigning, true); assert.equal(config.win.signExecutable, true);
  assert.deepEqual(config.win.signExts, ['QQ_Service.exe', 'QQ_Service-0.8.0-Windows-x64.exe', '!.exe']);
  assert.deepEqual(config.win.signtoolOptions.signingHashAlgorithms, ['sha256']);
  assert.equal(config.win.signtoolOptions.rfc3161TimeStampServer, 'http://timestamp.digicert.com');
  assert.equal(config.win.signtoolOptions.certificateSha1, readSigningCertificate({ directory: source, now: fixtureNow }).sha1);
  const { WinPackager } = require('app-builder-lib');
  const shouldSign = file => WinPackager.prototype.shouldSignFile.call({ platformSpecificBuildOptions: config.win }, file, true);
  assert.equal(shouldSign('dist/win-unpacked/QQ_Service.exe'), true);
  assert.equal(shouldSign('dist/QQ_Service-0.8.0-Windows-x64.exe'), true);
  for (const file of ['dist/win-unpacked/resources/runtime/node.exe', 'dist/win-unpacked/chrome_crashpad_handler.exe',
    'dist/QQ_Service-0.8.1-Windows-x64.exe', 'dist/QQ_Service-0.8.0-Windows-x64-Setup.exe', 'dist/__uninstaller.exe']) assert.equal(shouldSign(file), false, file);
  assert.equal(Object.hasOwn(config.win.signtoolOptions, 'sign'), false, 'no no-op custom signing hook');
  assert.equal(Object.hasOwn(config.win.signtoolOptions, 'certificatePassword'), false, 'private password never enters builder config');
});

test('application version cannot introduce a path or command fragment into signing filenames', () => {
  for (const version of ['../0.8.0', '0.8.0/other', '0.8.0\\other', '0.8.0:stream', '', null]) assert.throws(() => portableName(version));
  assert.equal(portableName('0.8.0-beta.1'), 'QQ_Service-0.8.0-beta.1-Windows-x64.exe');
});
