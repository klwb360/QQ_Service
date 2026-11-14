import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { deflateSync } from 'node:zlib';
import { createQqAssetStore, QQ_ASSET_LIMITS } from '../src/qq-assets.mjs';

const actualQQ = '111111', groupId = '222222', otherGroup = '333333';
const gif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==', 'base64');
const authorize = () => true;
const code = expected => error => error.code === expected;
function fixture(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-assets-test-'));
  const config = { botQQ: actualQQ, groups: [{ id: groupId, read: true }, { id: otherGroup, read: true }, { id: '444444', read: false }] };
  const store = createQqAssetStore({ dataDir, getConfig: () => config });
  t.after(() => { store.dispose(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  const upload = (extra = {}) => store.import({ actualQQ, groupIds: [groupId], kind: 'sticker', name: '开心表情.gif',
    dataBase64: gif.toString('base64'), description: '开心地笑', tags: ['开心'], emotion: '开心', usage: '表示赞同', avoidWhen: '严肃通知', ...extra });
  const input = row => ({ assetId: row.assetId, actualQQ, groupId, authorize });
  const blob = row => path.join(dataDir, 'qq-assets', 'blobs', `${row.assetId}-${row.sha256}.blob`);
  const manifest = path.join(dataDir, 'qq-assets', 'manifest.json');
  return { store, dataDir, config, upload, input, blob, manifest };
}
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ crc >>> 1 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function pngChunk(type, body) {
  const bytes = Buffer.alloc(body.length + 12);
  bytes.writeUInt32BE(body.length); bytes.write(type, 4, 4, 'latin1'); body.copy(bytes, 8);
  bytes.writeUInt32BE(crc32(bytes.subarray(4, bytes.length - 4)), bytes.length - 4); return bytes;
}
function png(width = 1, height = 1) {
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(Buffer.from([0, 255, 0, 0, 255]))), pngChunk('IEND', Buffer.alloc(0))]);
}
function jpeg(width = 1, height = 1) {
  const frame = Buffer.from([0xff, 0xc0, 0, 11, 8, 0, height, 0, width, 1, 1, 0x11, 0]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), frame, Buffer.from([0xff, 0xda, 0, 8, 1, 1, 0, 0, 63, 0, 0, 0xff, 0xd9])]);
}
function webp(width = 1, height = 1) {
  const bytes = Buffer.alloc(26); bytes.write('RIFF'); bytes.writeUInt32LE(18, 4); bytes.write('WEBPVP8L', 8);
  bytes.writeUInt32LE(5, 16); bytes[20] = 0x2f; bytes.writeUInt32LE(width - 1 | (height - 1) << 14, 21); return bytes;
}
function office(extension = 'docx', extras = []) {
  const main = { docx: 'word/document.xml', xlsx: 'xl/workbook.xml', pptx: 'ppt/presentation.xml' }[extension];
  const entries = ['[Content_Types].xml', '_rels/.rels', main, ...extras].map(value => ({ bytes: Buffer.from('<xml/>'), extra: Buffer.alloc(0), ...(typeof value === 'string' ? { name: value } : value) }));
  const locals = [], centrals = []; let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name), local = Buffer.alloc(30), central = Buffer.alloc(46), crc = crc32(entry.bytes);
    local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x800, 6);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(entry.bytes.length, 18); local.writeUInt32LE(entry.bytes.length, 22); local.writeUInt16LE(name.length, 26); local.writeUInt16LE(entry.extra.length, 28);
    central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x800, 8);
    central.writeUInt32LE(crc, 16); central.writeUInt32LE(entry.bytes.length, 20); central.writeUInt32LE(entry.bytes.length, 24);
    central.writeUInt16LE(name.length, 28); central.writeUInt16LE(entry.extra.length, 30); central.writeUInt32LE(offset, 42);
    const bytes = Buffer.concat([local, name, entry.extra, entry.bytes]); locals.push(bytes); centrals.push(Buffer.concat([central, name, entry.extra])); offset += bytes.length;
  }
  const directory = Buffer.concat(centrals), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

test('owner uploads are durable opaque assets; model-facing lists expose only bounded metadata', async t => {
  const f = fixture(t), row = f.upload({ groupIds: [groupId, otherGroup] });
  assert.match(row.assetId, /^asset_[a-f0-9]{32}$/u); assert.equal(row.version, 1); assert.equal(row.analysisSource, 'owner');
  assert.deepEqual(row.groupIds, [groupId, otherGroup]); assert.equal(row.mimeType, 'image/gif');
  const list = f.store.list({ actualQQ, groupId, query: '开心 赞同' });
  assert.equal(list.assets.length, 1); assert.equal(list.assets[0].assetId, row.assetId); assert.equal(list.hasMore, false);
  assert.equal(list.assets[0].groupId, groupId); assert.equal(list.assets[0].size, gif.length); assert.equal(list.assets[0].byteLength, gif.length);
  for (const field of ['path', 'file', 'url', 'bytes', 'dataBase64', 'groupIds']) assert.equal(own(list.assets[0], field), false);
  const second = createQqAssetStore({ dataDir: f.dataDir, getConfig: () => f.config }); t.after(() => second.dispose());
  assert.deepEqual(second.list({ actualQQ, groupId }), f.store.list({ actualQQ, groupId }));
  const described = await f.store.describe(f.input(row)); assert.equal(described.description, '开心地笑'); assert.equal(own(described, 'bytes'), false);
  const resolved = await f.store.resolve(f.input(row)); assert(Buffer.isBuffer(resolved.bytes)); assert.deepEqual(resolved.bytes, gif);
  resolved.bytes.fill(0); resolved.tags.push('caller-mutation');
  assert.deepEqual((await second.resolve(f.input(row))).bytes, gif); assert.deepEqual(second.list({ actualQQ, groupId }).assets[0].tags, ['开心']);
  assert.deepEqual(fs.readdirSync(path.dirname(f.blob(row))), [`${row.assetId}-${row.sha256}.blob`]);
});
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

test('profile, actual QQ and explicitly readable group scopes cannot be widened by model parameters', async t => {
  const f = fixture(t), row = f.upload();
  for (const input of [{ actualQQ: '999999', groupIds: [groupId] }, { groupIds: ['444444'] }, { groupIds: [] }, { groupIds: [groupId, groupId] }]) {
    assert.throws(() => f.upload(input), code('QQ_ASSET_DENIED'));
  }
  assert.equal(f.store.list({ actualQQ, groupId: otherGroup }).assets.length, 0);
  await assert.rejects(f.store.resolve({ ...f.input(row), groupId: otherGroup }), code('QQ_ASSET_DENIED'));
  await assert.rejects(f.store.resolve({ ...f.input(row), actualQQ: '999999' }), code('QQ_ASSET_DENIED'));
  await assert.rejects(f.store.resolve({ ...f.input(row), kind: 'file' }), code('QQ_ASSET_DENIED'));
  assert.throws(() => f.store.list({ actualQQ, groupId, groupIds: [otherGroup] }), code('QQ_ASSET_INPUT_INVALID'));
  const otherData = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-assets-profile-'));
  const other = createQqAssetStore({ dataDir: otherData, getConfig: () => f.config });
  t.after(() => { other.dispose(); fs.rmSync(otherData, { recursive: true, force: true }); });
  assert.equal(other.list({ actualQQ, groupId }).assets.length, 0);
  await assert.rejects(other.resolve(f.input(row)), code('QQ_ASSET_NOT_FOUND'));
});

test('PNG/JPEG/GIF/WebP headers and dimensions are verified without loading image decoders', async t => {
  const f = fixture(t);
  for (const [name, bytes, mime] of [['pic.png', png(), 'image/png'], ['pic.jpg', jpeg(), 'image/jpeg'], ['pic.gif', gif, 'image/gif'], ['pic.webp', webp(), 'image/webp']]) {
    const row = f.upload({ kind: 'image', name, dataBase64: bytes.toString('base64') });
    assert.equal(row.mimeType, mime); assert.equal(row.width, 1); assert.equal(row.height, 1);
    assert.deepEqual((await f.store.resolve(f.input(row))).bytes, bytes);
  }
  for (const bytes of [Buffer.from('not a picture'), png(9000, 1), png(8192, 8192), webp(9000, 1), gif.subarray(0, -1), Buffer.concat([gif, Buffer.from('extra')])]) {
    assert.throws(() => f.upload({ dataBase64: bytes.toString('base64') }), code('QQ_ASSET_INPUT_INVALID'));
  }
  const corrupt = png(); corrupt[corrupt.length - 1] ^= 1;
  assert.throws(() => f.upload({ dataBase64: corrupt.toString('base64') }), code('QQ_ASSET_INPUT_INVALID'));
  const maskedMagic = Buffer.from(gif); maskedMagic[0] |= 128;
  assert.throws(() => f.upload({ dataBase64: maskedMagic.toString('base64') }), code('QQ_ASSET_INPUT_INVALID'));
});

test('oversized and noncanonical base64, paths and unsafe names are rejected before persistence', t => {
  const f = fixture(t);
  for (const dataBase64 of [gif.toString('base64').replace(/=+$/u, ''), `data:image/gif;base64,${gif.toString('base64')}`, '/tmp/local.png', 'http://127.0.0.1/private', 'Zg==\n', 'Zh==', Buffer.alloc(QQ_ASSET_LIMITS.imageBytes + 1).toString('base64')]) {
    assert.throws(() => f.upload({ dataBase64 }), code('QQ_ASSET_INPUT_INVALID'));
  }
  for (const name of ['../x.gif', 'C:\\secret.gif', 'name/part.gif', 'file\nname.gif', 'CON.gif', 'bad.gif.', 'x\u202e.exe']) assert.throws(() => f.upload({ name }), code('QQ_ASSET_INPUT_INVALID'));
  assert.throws(() => f.upload({ path: '/tmp/anything' }), code('QQ_ASSET_INPUT_INVALID'));
  assert.equal(fs.readdirSync(path.join(f.dataDir, 'qq-assets', 'blobs')).length, 0);
});

test('documents use a fixed text/PDF/OOXML allowlist; raw archives and executable extensions cannot pass', async t => {
  const f = fixture(t);
  for (const [name, bytes] of [['notice.txt', Buffer.from('通知正文')], ['readme.md', Buffer.from('# Guide')], ['rows.csv', Buffer.from('a,b\n1,2')], ['data.json', Buffer.from('{"a":1}')],
    ['notice.pdf', Buffer.from('%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF\n')], ...['docx', 'xlsx', 'pptx'].map(ext => [`work.${ext}`, office(ext)])]) {
    const row = f.upload({ kind: 'file', name, dataBase64: bytes.toString('base64') });
    assert.equal(row.kind, 'file'); assert.deepEqual((await f.store.resolve({ ...f.input(row), kind: 'file' })).bytes, bytes);
  }
  for (const name of ['run.exe', 'run.bat', 'run.cmd', 'run.ps1', 'run.lnk', 'run.dll', 'bundle.zip', 'macro.docm', 'macro.xlsm']) {
    assert.throws(() => f.upload({ kind: 'file', name, dataBase64: office().toString('base64') }), code('QQ_ASSET_INPUT_INVALID'));
  }
  assert.throws(() => f.upload({ kind: 'file', name: 'bad.txt', dataBase64: Buffer.from([0, 255]).toString('base64') }), code('QQ_ASSET_INPUT_INVALID'));
  assert.throws(() => f.upload({ kind: 'file', name: 'bad.pdf', dataBase64: Buffer.from('not pdf').toString('base64') }), code('QQ_ASSET_INPUT_INVALID'));
  assert.throws(() => f.upload({ kind: 'file', name: 'wrong.xlsx', dataBase64: office('docx').toString('base64') }), code('QQ_ASSET_INPUT_INVALID'));
});

test('OOXML central directories reject traversal, duplicates, macros, embedded code, encryption and zip bombs', t => {
  const f = fixture(t), bad = [office('docx', ['../escape.xml']), office('docx', ['word/document.xml']), office('docx', ['word/vbaProject.bin']),
    office('docx', ['word/embeddings/anything.xml']), office('docx', ['payload.exe']), office('docx', ['word/../other.xml']),
    office('docx', ['word/.. /other.xml']), office('docx', ['word/. /other.xml']), office('docx', ['word/．．/other.xml']), office('docx', ['word/CON.xml'])];
  const encrypted = office(), directory = encrypted.readUInt32LE(encrypted.length - 6);
  encrypted.writeUInt16LE(0x801, 6); encrypted.writeUInt16LE(0x801, directory + 8); bad.push(encrypted);
  const bomb = office(), central = bomb.readUInt32LE(bomb.length - 6);
  bomb.writeUInt16LE(8, 8); bomb.writeUInt16LE(8, central + 10); bomb.writeUInt32LE(10_000_000, 22); bomb.writeUInt32LE(10_000_000, central + 24); bad.push(bomb);
  const alternateName = Buffer.from('../escape.xml'), unicodePath = Buffer.alloc(9 + alternateName.length);
  unicodePath.writeUInt16LE(0x7075); unicodePath.writeUInt16LE(5 + alternateName.length, 2); unicodePath[4] = 1;
  unicodePath.writeUInt32LE(crc32(Buffer.from('word/safe.xml')), 5); alternateName.copy(unicodePath, 9);
  bad.push(office('docx', [{ name: 'word/safe.xml', extra: unicodePath }]));
  const zip64 = Buffer.alloc(20); zip64.writeUInt16LE(1); zip64.writeUInt16LE(16, 2);
  bad.push(office('docx', [{ name: 'word/safe.xml', extra: zip64 }]));
  for (const bytes of bad) assert.throws(() => f.upload({ kind: 'file', name: 'work.docx', dataBase64: bytes.toString('base64') }), code('QQ_ASSET_INPUT_INVALID'));
});

test('owner edits and vision annotations use optimistic versions and never alter access through annotations', async t => {
  const f = fixture(t), first = f.upload(), revision = first.version;
  const annotated = f.store.annotate({ assetId: first.assetId, actualQQ, expectedVersion: revision, source: 'vision', modelFingerprint: 'a'.repeat(64),
    description: '这是一张开心的表情包', tags: ['微笑'], emotion: '高兴', usage: '轻松闲聊', avoidWhen: '严肃通知' });
  assert.equal(annotated.version, revision + 1); assert.equal(annotated.analysisSource, 'vision'); assert.deepEqual(annotated.groupIds, [groupId]);
  assert.equal((await f.store.describe(f.input(first))).modelFingerprint, 'a'.repeat(64));
  assert.throws(() => f.store.annotate({ assetId: first.assetId, actualQQ, expectedVersion: revision, source: 'vision', modelFingerprint: 'a'.repeat(64) }), code('QQ_ASSET_CONFLICT'));
  assert.throws(() => f.store.annotate({ assetId: first.assetId, actualQQ, expectedVersion: annotated.version, source: 'vision', modelFingerprint: 'a'.repeat(64), groupIds: [otherGroup] }), code('QQ_ASSET_INPUT_INVALID'));
  const edited = f.store.update({ assetId: first.assetId, actualQQ, expectedVersion: annotated.version, name: '手动名称.gif', groupIds: [otherGroup], usage: '换了使用场景' });
  assert.equal(edited.analysisSource, 'owner'); assert.equal(own(edited, 'modelFingerprint'), false);
  assert.equal(f.store.list({ actualQQ, groupId }).assets.length, 0); assert.equal(f.store.list({ actualQQ, groupId: otherGroup }).assets.length, 1);
  assert.throws(() => f.store.remove({ assetId: first.assetId, actualQQ, expectedVersion: annotated.version }), code('QQ_ASSET_CONFLICT'));
  assert.equal(f.store.remove({ assetId: first.assetId, actualQQ, expectedVersion: edited.version }).removed, true);
  assert.throws(() => f.store.annotate({ assetId: first.assetId, actualQQ, expectedVersion: edited.version, source: 'vision', modelFingerprint: 'a'.repeat(64) }), code('QQ_ASSET_NOT_FOUND'));
  assert.equal(fs.existsSync(f.blob(first)), false);
});

test('resolve rechecks cancellation, permissions, versions and immutable bytes at asynchronous boundaries', async t => {
  const f = fixture(t), row = f.upload(); let checks = 0;
  await assert.rejects(f.store.resolve({ ...f.input(row), authorize: () => {
    if (++checks === 2) f.config.groups[0].read = false; return true;
  } }), code('QQ_ASSET_DENIED'));
  f.config.groups[0].read = true; checks = 0;
  await assert.rejects(f.store.resolve({ ...f.input(row), authorize: () => {
    if (++checks === 3) f.store.update({ assetId: row.assetId, actualQQ, expectedVersion: row.version, tags: ['changed'] }); return true;
  } }), code('QQ_ASSET_INTEGRITY'));
  const controller = new AbortController(); controller.abort();
  await assert.rejects(f.store.resolve({ ...f.input(row), signal: controller.signal }), code('QQ_ASSET_CANCELLED'));
  await assert.rejects(f.store.resolve({ ...f.input(row), authorize: undefined }), code('QQ_ASSET_DENIED'));
  const exact = Object.assign(new Error('Runtime was revoked'), { code: 'RUNTIME_REVOKED' }); checks = 0;
  await assert.rejects(f.store.resolve({ ...f.input(row), authorize: () => { if (++checks === 5) throw exact; } }), error => error === exact);
});

test('deleted or externally changed assets cannot supply late bytes or follow symlinks', async t => {
  const f = fixture(t), row = f.upload(); let checks = 0;
  await assert.rejects(f.store.resolve({ ...f.input(row), authorize: () => {
    if (++checks === 3) { const changed = Buffer.from(gif); changed[20] ^= 1; fs.writeFileSync(f.blob(row), changed); } return true;
  } }), code('QQ_ASSET_INTEGRITY'));
  fs.writeFileSync(f.blob(row), gif);
  const replacement = path.join(f.dataDir, 'replacement'); fs.writeFileSync(replacement, gif);
  fs.unlinkSync(f.blob(row));
  try { fs.symlinkSync(replacement, f.blob(row)); }
  catch (error) { if (process.platform === 'win32' && error.code === 'EPERM') return; throw error; }
  await assert.rejects(f.store.resolve(f.input(row)), code('QQ_ASSET_INTEGRITY'));
  fs.unlinkSync(f.blob(row)); fs.writeFileSync(f.blob(row), gif); checks = 0;
  await assert.rejects(f.store.resolve({ ...f.input(row), authorize: () => {
    if (++checks === 2) f.store.remove({ assetId: row.assetId, actualQQ, expectedVersion: row.version }); return true;
  } }), code('QQ_ASSET_NOT_FOUND'));
});

test('metadata remains bounded, exported copies cannot mutate permissions, and malformed manifests fail closed', t => {
  const f = fixture(t), row = f.upload({ description: '中'.repeat(1200), tags: Array.from({ length: 20 }, (_, i) => `${i}${'文'.repeat(38)}`), usage: '用'.repeat(400), avoidWhen: '避'.repeat(400) });
  row.groupIds.push(otherGroup); assert.equal(f.store.list({ actualQQ, groupId: otherGroup }).assets.length, 0);
  for (let i = 0; i < 5; i++) f.upload({ description: '中'.repeat(1200), usage: '用'.repeat(400), avoidWhen: '避'.repeat(400) });
  const list = f.store.list({ actualQQ, groupId, limit: 50 });
  assert(Buffer.byteLength(JSON.stringify(list)) <= QQ_ASSET_LIMITS.listBytes); assert.equal(list.hasMore, true);
  const document = JSON.parse(fs.readFileSync(f.manifest, 'utf8')); document.assets[0].path = '/etc/passwd';
  fs.writeFileSync(f.manifest, JSON.stringify(document)); assert.throws(() => f.store.list({ actualQQ, groupId }), code('QQ_ASSET_INTEGRITY'));
});

test('quota checks preserve the prior manifest and do not write an extra blob', t => {
  const f = fixture(t), first = f.upload(), original = JSON.parse(fs.readFileSync(f.manifest, 'utf8'));
  const full = structuredClone(original);
  full.assets = Array.from({ length: 1000 }, (_, i) => ({ ...first, assetId: i ? `asset_${i.toString(16).padStart(32, '0')}` : first.assetId }));
  for (const row of full.assets) delete row.size;
  fs.writeFileSync(f.manifest, JSON.stringify(full));
  assert.throws(() => f.upload(), code('QQ_ASSET_QUOTA')); assert.equal(fs.readdirSync(path.dirname(f.blob(first))).length, 1);
  const bytesFull = structuredClone(original);
  bytesFull.assets = Array.from({ length: 10 }, (_, i) => ({ ...original.assets[0], assetId: i ? `asset_${i.toString(16).padStart(32, '0')}` : first.assetId,
    kind: 'file', name: 'stored.txt', mimeType: 'text/plain', byteLength: QQ_ASSET_LIMITS.fileBytes }));
  fs.writeFileSync(f.manifest, JSON.stringify(bytesFull));
  assert.throws(() => f.upload(), code('QQ_ASSET_QUOTA')); assert.equal(fs.readdirSync(path.dirname(f.blob(first))).length, 1);
});

test('dispose blocks all subsequent reads and writes while preserving persisted files', async t => {
  const f = fixture(t), row = f.upload(); f.store.dispose();
  assert.throws(() => f.store.list({ actualQQ, groupId }), code('QQ_ASSET_CLOSED'));
  assert.throws(() => f.upload(), code('QQ_ASSET_CLOSED'));
  await assert.rejects(f.store.describe(f.input(row)), code('QQ_ASSET_CLOSED'));
  assert.equal(fs.existsSync(f.blob(row)), true);
});

test('a lost manifest cannot initialize a fresh library or garbage-collect existing approved bytes', t => {
  const f = fixture(t), row = f.upload(), previous = fs.readFileSync(f.manifest);
  fs.unlinkSync(f.manifest);
  assert.throws(() => f.store.list({ actualQQ, groupId }), code('QQ_ASSET_INTEGRITY'));
  assert.throws(() => f.upload({ name: 'other.gif' }), code('QQ_ASSET_INTEGRITY'));
  assert.deepEqual(fs.readFileSync(f.blob(row)), gif);
  fs.writeFileSync(f.manifest, previous);
  assert.equal(f.store.list({ actualQQ, groupId }).assets[0].assetId, row.assetId);
});

test('manifest symlinks fail closed even when the platform does not provide O_NOFOLLOW', t => {
  const f = fixture(t), row = f.upload(), external = path.join(f.dataDir, 'untrusted-manifest.json');
  fs.renameSync(f.manifest, external);
  try { fs.symlinkSync(external, f.manifest); }
  catch (error) { if (process.platform === 'win32' && error.code === 'EPERM') { t.skip('Windows native symlink creation is unavailable'); return; } throw error; }
  const original = fs.openSync;
  fs.openSync = function(file, flags, mode) { return original.call(fs, file, typeof flags === 'number' ? flags & ~(fs.constants.O_NOFOLLOW || 0) : flags, mode); };
  try { assert.throws(() => f.store.list({ actualQQ, groupId }), code('QQ_ASSET_INTEGRITY')); assert.equal(fs.existsSync(f.blob(row)), true); }
  finally { fs.openSync = original; }
});

test('owner-only SHA dedup searches beyond the model list window without widening any group scope', t => {
  const f = fixture(t);
  for (let i = 0; i < 55; i++) f.upload({ name: `variant-${i}.gif`, dataBase64: Buffer.concat([gif.subarray(0, -1), Buffer.from([0x21, 0xfe, 1, i, 0, 0x3b])]).toString('base64') });
  const target = f.upload({ name: 'target.gif' });
  assert.equal(f.store.list({ actualQQ, groupId, limit: 50 }).assets.some(row => row.assetId === target.assetId), false);
  const found = f.store.findBySha({ actualQQ, groupIds: [groupId], sha256: target.sha256, kind: 'sticker' });
  assert.equal(found.assetId, target.assetId); assert.deepEqual(found.groupIds, [groupId]);
  assert.equal(own(found, 'bytes'), false); assert.equal(own(found, 'path'), false);
  assert.equal(f.store.findBySha({ actualQQ, groupIds: [groupId, otherGroup], sha256: target.sha256, kind: 'sticker' }), null);
  assert.equal(f.store.findBySha({ actualQQ, groupIds: [otherGroup], sha256: target.sha256, kind: 'sticker' }), null);
  assert.throws(() => f.store.findBySha({ actualQQ: '999999', groupIds: [groupId], sha256: target.sha256, kind: 'sticker' }), code('QQ_ASSET_DENIED'));
  assert.deepEqual(f.store.list({ actualQQ, groupId }).assets[0].groupId, groupId);
});
