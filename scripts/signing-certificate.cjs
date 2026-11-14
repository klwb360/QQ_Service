'use strict';

// Public certificate metadata only. Private keys never enter this module or
// the electron-builder configuration object (and therefore cannot be logged).
const fs = require('node:fs');
const path = require('node:path');
const { X509Certificate, createHash } = require('node:crypto');

const FIELDS = ['schemaVersion', 'subject', 'sha1', 'sha256', 'notBefore', 'notAfter', 'usage'];
const CODE_SIGNING_OID = '1.3.6.1.5.5.7.3.3';

function fail(message) {
  return Object.assign(new Error(`Signing certificate rejected: ${message}`), { code: 'SIGNING_CERTIFICATE_INVALID' });
}

function regularFile(file, maximumBytes) {
  const info = fs.lstatSync(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size < 1 || info.size > maximumBytes) throw fail('invalid public certificate resource');
  return fs.readFileSync(file);
}

function readSigningCertificate({ directory = path.resolve(__dirname, '..', 'signing'), now = new Date() } = {}) {
  const root = path.resolve(directory);
  const information = fs.lstatSync(root);
  if (!information.isDirectory() || information.isSymbolicLink()) throw fail('public certificate directory must be a real directory');
  let certificate, metadata, encoded;
  try {
    encoded = regularFile(path.join(root, 'QQ_Service.cer'), 64 * 1024);
    certificate = new X509Certificate(encoded);
    metadata = JSON.parse(regularFile(path.join(root, 'certificate.json'), 16 * 1024).toString('utf8'));
  } catch (cause) {
    if (cause.code === 'SIGNING_CERTIFICATE_INVALID') throw cause;
    throw fail('public certificate or metadata could not be read');
  }
  if (!encoded.equals(certificate.raw)) throw fail('public certificate must contain exactly one DER certificate');
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)
    || Object.keys(metadata).length !== FIELDS.length || Object.keys(metadata).some(key => !FIELDS.includes(key))
    || metadata.schemaVersion !== 1 || metadata.usage !== 'codeSigning') throw fail('invalid metadata shape');
  const sha1 = createHash('sha1').update(certificate.raw).digest('hex').toUpperCase();
  const sha256 = createHash('sha256').update(certificate.raw).digest('hex').toUpperCase();
  if (metadata.sha1 !== sha1 || metadata.sha256 !== sha256) throw fail('public certificate fingerprint mismatch');
  if (metadata.subject !== certificate.subject || certificate.subject !== 'CN=QQ_Service Self-Signed Publisher') throw fail('public certificate subject mismatch');
  const notBefore = new Date(certificate.validFrom).toISOString();
  const notAfter = new Date(certificate.validTo).toISOString();
  const utcDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(value) ? Date.parse(value) : NaN;
  if (utcDate(metadata.notBefore) !== Date.parse(notBefore) || utcDate(metadata.notAfter) !== Date.parse(notAfter)) throw fail('public certificate validity metadata mismatch');
  const current = now instanceof Date ? now.getTime() : NaN;
  if (!Number.isFinite(current) || current < Date.parse(notBefore) || current >= Date.parse(notAfter)) throw fail('public certificate is not currently valid');
  if (certificate.ca || certificate.keyUsage?.length !== 1 || certificate.keyUsage[0] !== CODE_SIGNING_OID) throw fail('certificate is not dedicated to code signing');
  if (certificate.publicKey.asymmetricKeyType !== 'rsa' || certificate.publicKey.asymmetricKeyDetails?.modulusLength !== 4096) throw fail('RSA-4096 public key required');
  if (certificate.issuer !== certificate.subject || !certificate.verify(certificate.publicKey)) throw fail('expected the fixed self-signed publisher certificate');
  return { directory: root, certificate, metadata: { ...metadata }, sha1, sha256, notBefore, notAfter };
}

function portableName(version) {
  if (typeof version !== 'string' || version.length > 64
    || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u.test(version)) throw fail('invalid application version');
  return `QQ_Service-${version}-Windows-x64.exe`;
}

function createSignedBuildConfiguration({ projectRoot, version, certificateDirectory, now } = {}) {
  const root = path.resolve(projectRoot || path.join(__dirname, '..'));
  const publicCertificate = readSigningCertificate({ directory: certificateDirectory || path.join(root, 'signing'), now });
  return {
    extends: path.join(root, 'electron-builder.yml'),
    forceCodeSigning: true,
    win: {
      signExecutable: true,
      // Positive suffixes take priority over negative suffixes in our locked
      // electron-builder. All other EXEs retain the vendor's exact bytes.
      signExts: ['QQ_Service.exe', portableName(version), '!.exe'],
      signtoolOptions: {
        certificateSha1: publicCertificate.sha1,
        signingHashAlgorithms: ['sha256'],
        rfc3161TimeStampServer: 'https://timestamp.digicert.com',
      },
    },
  };
}

module.exports = { readSigningCertificate, createSignedBuildConfiguration, portableName };
