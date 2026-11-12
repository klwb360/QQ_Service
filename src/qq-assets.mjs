import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes, randomUUID } from 'node:crypto';

export const QQ_ASSET_LIMITS = Object.freeze({ imageBytes: 8 * 1024 * 1024, fileBytes: 20 * 1024 * 1024,
  totalBytes: 200 * 1024 * 1024, assets: 1000, side: 8192, pixels: 32_000_000,
  frames: 100, animationPixels: 64_000_000, listBytes: 24 * 1024 });
const ID = /^asset_[a-f0-9]{32}$/u, HASH = /^[a-f0-9]{64}$/u, QQ = /^[1-9]\d{3,19}$/u;
const KINDS = new Set(['image', 'sticker', 'file']);
const TEXT_EXTENSIONS = new Set(['.txt', '.md', '.csv', '.json']);
const OFFICE = { '.docx': ['word/document.xml', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  '.xlsx': ['xl/workbook.xml', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  '.pptx': ['ppt/presentation.xml', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'] };
const own = (value, name) => Object.prototype.hasOwnProperty.call(value, name);
const fail = (message, code = 'QQ_ASSET_INPUT_INVALID', statusCode = 400) => Object.assign(new Error(message), { code, statusCode });
const denied = () => fail('素材不属于当前账号及明确允许读取的群。', 'QQ_ASSET_DENIED', 403);
const integrity = () => fail('素材文件或清单已改变，无法使用未经核对的内容。', 'QQ_ASSET_INTEGRITY', 409);
const cancelled = () => fail('素材读取已取消。', 'QQ_ASSET_CANCELLED', 409);
const closed = () => fail('素材库已关闭。', 'QQ_ASSET_CLOSED', 409);
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
function fields(input, allowed) {
  if (!plain(input) || Object.getOwnPropertySymbols(input).length || Object.entries(Object.getOwnPropertyDescriptors(input))
    .some(([name, descriptor]) => !allowed.includes(name) || !own(descriptor, 'value'))) throw fail('素材参数包含不支持的字段。');
}
function text(value, label, max, { empty = true } = {}) {
  if (typeof value !== 'string' || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) throw fail(`${label}格式或长度不正确。`);
  const result = value.normalize('NFC').trim();
  if (result.length > max || !empty && !result) throw fail(`${label}格式或长度不正确。`);
  return result;
}
function nameOf(value) {
  const result = text(value, '素材名称', 120, { empty: false }).normalize('NFKC');
  if (result.length > 120 || /[\\/:*?"<>|\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(result) || /^[. ]|[. ]$/u.test(result)
    || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(result)) throw fail('素材名称不能包含路径、保留文件名或特殊路径字符。');
  return result;
}
function tagsOf(value = []) {
  if (!Array.isArray(value) || value.length > 20) throw fail('素材最多设置20个标签。');
  return [...new Set(Array.from(value, item => text(item, '素材标签', 40, { empty: false })))];
}
function metadata(input, defaults = {}) {
  return { tags: own(input, 'tags') ? tagsOf(input.tags) : structuredClone(defaults.tags || []),
    description: own(input, 'description') ? text(input.description, '素材描述', 1200) : defaults.description || '',
    emotion: own(input, 'emotion') ? text(input.emotion, '情绪', 80) : defaults.emotion || '',
    usage: own(input, 'usage') ? text(input.usage, '使用场景', 400) : defaults.usage || '',
    avoidWhen: own(input, 'avoidWhen') ? text(input.avoidWhen, '避免使用的场景', 400) : defaults.avoidWhen || '' };
}
function dimensions(width, height) {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1
    || width > QQ_ASSET_LIMITS.side || height > QQ_ASSET_LIMITS.side || width * height > QQ_ASSET_LIMITS.pixels) throw fail('图片宽高或像素数超过素材上限。');
  return { width, height };
}
function animation(frames, pixels) {
  if (!Number.isSafeInteger(frames) || frames < 1 || frames > QQ_ASSET_LIMITS.frames || !Number.isSafeInteger(pixels)
    || pixels < 1 || pixels > QQ_ASSET_LIMITS.animationPixels) throw fail('动图帧数或累计像素超过素材上限。');
}
const crcTable = Array.from({ length: 256 }, (_, value) => {
  for (let i = 0; i < 8; i++) value = value & 1 ? 0xedb88320 ^ value >>> 1 : value >>> 1;
  return value >>> 0;
});
function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) value = crcTable[(value ^ byte) & 255] ^ value >>> 8;
  return (value ^ 0xffffffff) >>> 0;
}
function png(bytes) {
  let offset = 8, size, data = false, ended = false, chunks = 0, frames = 1, animated = false, frameHeaders = 0;
  while (offset + 12 <= bytes.length && ++chunks <= 10000) {
    const length = bytes.readUInt32BE(offset), end = offset + 12 + length;
    if (end > bytes.length) throw fail('PNG数据已截断。');
    const kind = bytes.toString('latin1', offset + 4, offset + 8), start = offset + 8;
    if (!/^[A-Za-z]{4}$/u.test(kind) || crc32(bytes.subarray(offset + 4, end - 4)) !== bytes.readUInt32BE(end - 4)) throw fail('PNG块校验失败。');
    if (!size && kind !== 'IHDR') throw fail('PNG缺少首个图像头。');
    if (kind === 'IHDR') {
      if (size || length !== 13) throw fail('PNG图像头不正确。');
      size = dimensions(bytes.readUInt32BE(start), bytes.readUInt32BE(start + 4));
      const depth = bytes[start + 8], color = bytes[start + 9];
      if (!({ 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] }[color]?.includes(depth))
        || bytes[start + 10] || bytes[start + 11] || bytes[start + 12] > 1) throw fail('PNG图像编码不受支持。');
    } else if (kind === 'acTL') {
      if (length !== 8 || data || animated) throw fail('PNG动画头不正确。');
      animated = true;
      frames = bytes.readUInt32BE(start);
      if (!frames) throw fail('PNG动画没有图像帧。');
      animation(frames, size.width * size.height * frames);
    } else if (kind === 'fcTL') {
      if (!animated || length !== 26 || ++frameHeaders > frames) throw fail('PNG动画帧头不正确。');
      const frame = dimensions(bytes.readUInt32BE(start + 4), bytes.readUInt32BE(start + 8));
      if (frame.width + bytes.readUInt32BE(start + 12) > size.width || frame.height + bytes.readUInt32BE(start + 16) > size.height) throw fail('PNG动画帧超出画布。');
    } else if (kind === 'IDAT') data ||= length > 0;
    else if (kind === 'IEND') {
      if (length || !data || end !== bytes.length) throw fail('PNG结尾或图像内容不正确。');
      ended = true; break;
    }
    offset = end;
  }
  if (!size || !ended || animated && frameHeaders !== frames) throw fail('PNG数据不完整。');
  return { ...size, frames, mimeType: 'image/png' };
}
function gif(bytes) {
  if (bytes.length < 14) throw fail('GIF数据不完整。');
  const size = dimensions(bytes.readUInt16LE(6), bytes.readUInt16LE(8));
  let offset = 13 + (bytes[10] & 128 ? 3 * (2 << (bytes[10] & 7)) : 0), frames = 0, pixels = 0, blocks = 0;
  const subBlocks = () => {
    let total = 0;
    while (offset < bytes.length && ++blocks <= 100000) {
      const length = bytes[offset++]; if (!length) return total;
      if (offset + length > bytes.length) throw fail('GIF数据块已截断。');
      offset += length; total += length;
    }
    throw fail('GIF数据块不完整。');
  };
  while (offset < bytes.length) {
    const kind = bytes[offset++];
    if (kind === 0x3b) {
      if (!frames || offset !== bytes.length) throw fail('GIF结尾或图像帧不正确。');
      return { ...size, frames, mimeType: 'image/gif' };
    }
    if (kind === 0x21) { if (offset >= bytes.length) throw fail('GIF扩展不完整。'); offset++; subBlocks(); continue; }
    if (kind !== 0x2c || offset + 9 > bytes.length) throw fail('GIF图像帧不正确。');
    const left = bytes.readUInt16LE(offset), top = bytes.readUInt16LE(offset + 2);
    const frame = dimensions(bytes.readUInt16LE(offset + 4), bytes.readUInt16LE(offset + 6));
    if (left + frame.width > size.width || top + frame.height > size.height) throw fail('GIF图像帧超出画布。');
    const packed = bytes[offset + 8]; offset += 9;
    if (packed & 128) offset += 3 * (2 << (packed & 7));
    if (offset >= bytes.length || bytes[offset] < 2 || bytes[offset] > 8) throw fail('GIF图像编码不正确。');
    offset++; if (!subBlocks()) throw fail('GIF图像没有内容。');
    frames++; pixels += frame.width * frame.height; animation(frames, Math.max(pixels, size.width * size.height * frames));
  }
  throw fail('GIF数据没有结束。');
}
function jpeg(bytes) {
  let offset = 2, size, scans = 0;
  while (offset < bytes.length) {
    if (bytes[offset++] !== 0xff) throw fail('JPEG标记不正确。');
    while (bytes[offset] === 0xff) offset++;
    const marker = bytes[offset++];
    if (marker === 0xd9) {
      if (!size || !scans || offset !== bytes.length) throw fail('JPEG结尾不正确。');
      return { ...size, frames: 1, mimeType: 'image/jpeg' };
    }
    if (marker === undefined || [0, 0xd8].includes(marker) || marker >= 0xd0 && marker <= 0xd7 || offset + 2 > bytes.length) throw fail('JPEG图像结构不正确。');
    const length = bytes.readUInt16BE(offset), end = offset + length;
    if (length < 2 || end > bytes.length) throw fail('JPEG数据已截断。');
    if ([0xc0, 0xc1, 0xc2].includes(marker)) {
      if (size || length < 11 || bytes[offset + 2] !== 8 || bytes[offset + 7] < 1 || bytes[offset + 7] > 4 || length !== 8 + 3 * bytes[offset + 7]) throw fail('JPEG图像头不正确。');
      size = dimensions(bytes.readUInt16BE(offset + 5), bytes.readUInt16BE(offset + 3));
    } else if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) throw fail('JPEG图像编码不受支持。');
    offset = end;
    if (marker === 0xda) {
      if (!size || ++scans > 100 || length < 8 || bytes[end - length + 2] < 1 || bytes[end - length + 2] > 4
        || length !== 6 + 2 * bytes[end - length + 2]) throw fail('JPEG扫描头不正确。');
      while (offset < bytes.length) {
        if (bytes[offset] !== 0xff) { offset++; continue; }
        const next = bytes[offset + 1];
        if (next === 0 || next >= 0xd0 && next <= 0xd7) { offset += 2; continue; }
        break;
      }
    }
  }
  throw fail('JPEG数据没有结束。');
}
const uint24 = (bytes, offset) => bytes[offset] + bytes[offset + 1] * 256 + bytes[offset + 2] * 65536;
function webpFrame(kind, bytes) {
  if (kind === 'VP8 ' && bytes.length >= 10 && !(bytes[0] & 1) && bytes.subarray(3, 6).equals(Buffer.from([0x9d, 0x01, 0x2a]))) return dimensions(bytes.readUInt16LE(6) & 0x3fff, bytes.readUInt16LE(8) & 0x3fff);
  if (kind === 'VP8L' && bytes.length >= 5 && bytes[0] === 0x2f) {
    const bits = bytes.readUInt32LE(1);
    if (bits >>> 29) throw fail('WebP无损编码版本不受支持。');
    return dimensions((bits & 0x3fff) + 1, (bits >>> 14 & 0x3fff) + 1);
  }
  throw fail('WebP图像头不正确。');
}
function webp(bytes) {
  if (bytes.length < 20 || bytes.readUInt32LE(4) + 8 !== bytes.length) throw fail('WebP容器长度不正确。');
  let offset = 12, canvas, still, frames = 0, pixels = 0, animated = false, animationHeader = false, chunks = 0;
  while (offset + 8 <= bytes.length && ++chunks <= 10000) {
    const kind = bytes.toString('latin1', offset, offset + 4), length = bytes.readUInt32LE(offset + 4);
    const start = offset + 8, end = start + length, next = end + (length & 1);
    if (next > bytes.length) throw fail('WebP数据块已截断。');
    const payload = bytes.subarray(start, end);
    if (kind === 'VP8X') {
      if (canvas || offset !== 12 || length !== 10 || payload[0] & 0xc1 || payload[1] || payload[2] || payload[3]) throw fail('WebP扩展图像头不正确。');
      canvas = dimensions(uint24(payload, 4) + 1, uint24(payload, 7) + 1); animated = Boolean(payload[0] & 2);
    } else if (kind === 'VP8 ' || kind === 'VP8L') {
      if (still || animated) throw fail('WebP重复或冲突图像帧。');
      still = webpFrame(kind, payload);
    } else if (kind === 'ANIM') {
      if (!canvas || !animated || animationHeader || frames || length !== 6) throw fail('WebP动画头不正确。');
      animationHeader = true;
    } else if (kind === 'ANMF') {
      if (!canvas || !animated || !animationHeader || length < 24) throw fail('WebP动画帧不正确。');
      const frame = dimensions(uint24(payload, 6) + 1, uint24(payload, 9) + 1);
      if (uint24(payload, 0) * 2 + frame.width > canvas.width || uint24(payload, 3) * 2 + frame.height > canvas.height) throw fail('WebP动画帧超出画布。');
      let inner = 16, found = false;
      while (inner + 8 <= payload.length) {
        const innerKind = payload.toString('latin1', inner, inner + 4), innerLength = payload.readUInt32LE(inner + 4), innerEnd = inner + 8 + innerLength;
        if (innerEnd + (innerLength & 1) > payload.length) throw fail('WebP动画帧已截断。');
        if (innerKind === 'VP8 ' || innerKind === 'VP8L') {
          if (found) throw fail('WebP动画帧包含多个图像。');
          const encoded = webpFrame(innerKind, payload.subarray(inner + 8, innerEnd));
          if (encoded.width !== frame.width || encoded.height !== frame.height) throw fail('WebP动画尺寸不一致。');
          found = true;
        } else if (innerKind !== 'ALPH') throw fail('WebP动画子块不受支持。');
        inner = innerEnd + (innerLength & 1);
      }
      if (!found || inner !== payload.length) throw fail('WebP动画缺少完整图像。');
      frames++; pixels += frame.width * frame.height; animation(frames, Math.max(pixels, canvas.width * canvas.height * frames));
    }
    offset = next;
  }
  if (offset !== bytes.length || animated && !frames || !animated && !still) throw fail('WebP图像内容不完整。');
  if (canvas && still && (canvas.width !== still.width || canvas.height !== still.height)) throw fail('WebP画布尺寸不一致。');
  return { ...(canvas || still), frames: animated ? frames : 1, mimeType: 'image/webp' };
}
function imageInfo(bytes) {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return png(bytes);
  if (['GIF87a', 'GIF89a'].includes(bytes.toString('latin1', 0, 6))) return gif(bytes);
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return jpeg(bytes);
  if (bytes.toString('latin1', 0, 4) === 'RIFF' && bytes.toString('latin1', 8, 12) === 'WEBP') return webp(bytes);
  throw fail('仅支持经过图像头验证的PNG、JPEG、GIF或WebP图片。');
}
function zipExtra(bytes, start, length) {
  let offset = start; const end = start + length, seen = new Set();
  while (offset < end) {
    if (offset + 4 > end) throw fail('Office扩展字段已截断。');
    const id = bytes.readUInt16LE(offset), size = bytes.readUInt16LE(offset + 2); offset += 4;
    if (offset + size > end || seen.has(id) || ![0x5455, 0x000a, 0x5855, 0x7875].includes(id)) throw fail('Office扩展字段不能重定义路径、尺寸或加密格式。');
    seen.add(id);
    if (id === 0x000a) {
      // NTFS timestamps only; do not accept unknown reparse/link attributes.
      if (size !== 32 || bytes.readUInt16LE(offset + 4) !== 1 || bytes.readUInt16LE(offset + 6) !== 24) throw fail('Office NTFS扩展仅支持时间戳。');
    }
    offset += size;
  }
}
function officeInfo(bytes, extension) {
  if (bytes.length < 22 || bytes.readUInt32LE(0) !== 0x04034b50) throw fail('Office文件缺少受支持的ZIP容器。');
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) if (bytes.readUInt32LE(i) === 0x06054b50 && i + 22 + bytes.readUInt16LE(i + 20) === bytes.length) { end = i; break; }
  if (end < 0 || bytes.readUInt16LE(end + 4) || bytes.readUInt16LE(end + 6)) throw fail('Office压缩目录不完整或采用多卷格式。');
  const count = bytes.readUInt16LE(end + 10), size = bytes.readUInt32LE(end + 12), start = bytes.readUInt32LE(end + 16);
  if (!count || count > 2048 || bytes.readUInt16LE(end + 8) !== count || start + size !== end) throw fail('Office压缩目录超限或不受支持。');
  let offset = start, expanded = 0;
  const names = new Set(), ranges = [];
  for (let i = 0; i < count; i++) {
    if (offset + 46 > end || bytes.readUInt32LE(offset) !== 0x02014b50) throw fail('Office中央目录不正确。');
    const flags = bytes.readUInt16LE(offset + 8), method = bytes.readUInt16LE(offset + 10), crc = bytes.readUInt32LE(offset + 16);
    const compressed = bytes.readUInt32LE(offset + 20), uncompressed = bytes.readUInt32LE(offset + 24);
    const nameLength = bytes.readUInt16LE(offset + 28), extra = bytes.readUInt16LE(offset + 30), comment = bytes.readUInt16LE(offset + 32), local = bytes.readUInt32LE(offset + 42);
    if (flags & (1 | 0x40 | 0x2000) || ![0, 8].includes(method) || !nameLength || nameLength > 1024 || extra > 4096
      || bytes.readUInt16LE(offset + 34) || offset + 46 + nameLength + extra + comment > end
      || method === 0 && compressed !== uncompressed || uncompressed > 64 * 1024 * 1024 || uncompressed > Math.max(1, compressed) * 200
      || (expanded += uncompressed) > 100 * 1024 * 1024) throw fail('Office压缩条目含加密、异常压缩比或超大内容。');
    const rawName = bytes.subarray(offset + 46, offset + 46 + nameLength);
    zipExtra(bytes, offset + 46 + nameLength, extra);
    let name;
    try { name = new TextDecoder('utf-8', { fatal: true }).decode(rawName).normalize('NFC'); } catch { throw fail('Office条目名称编码不受支持。'); }
    const key = name.toLowerCase();
    if (!name || name.length > 240 || /[\\:\u0000-\u001f\u007f]/u.test(name) || name.startsWith('/')
      || name.split('/').some((part, index, all) => {
        if (!part) return index !== all.length - 1;
        const normalized = part.normalize('NFKC');
        return ['.', '..'].includes(normalized) || /^\s|[.\s]$/u.test(normalized) || /[\\/:\u202a-\u202e\u2066-\u2069]/u.test(normalized)
          || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(normalized);
      })
      || names.has(key) || (bytes.readUInt32LE(offset + 38) >>> 16 & 0xf000) === 0xa000
      || /(?:vba|macro|activex|embeddings|externallinks)/iu.test(name)
      || !name.endsWith('/') && !/\.(?:xml|rels|png|jpe?g|gif|webp|bmp|emf|wmf|tiff?)$/iu.test(name)) throw fail('Office条目包含宏、嵌入对象、重复或不安全路径。');
    names.add(key);
    if (local + 30 > start || bytes.readUInt32LE(local) !== 0x04034b50 || bytes.readUInt16LE(local + 6) !== flags
      || bytes.readUInt16LE(local + 8) !== method || bytes.readUInt16LE(local + 26) !== nameLength) throw fail('Office本地条目与目录不一致。');
    const localExtra = bytes.readUInt16LE(local + 28), content = local + 30 + nameLength + localExtra;
    if (localExtra > 4096 || content + compressed > start || !bytes.subarray(local + 30, local + 30 + nameLength).equals(rawName)
      || !(flags & 8) && (bytes.readUInt32LE(local + 14) !== crc || bytes.readUInt32LE(local + 18) !== compressed || bytes.readUInt32LE(local + 22) !== uncompressed)) throw fail('Office本地数据范围或校验字段不一致。');
    zipExtra(bytes, local + 30 + nameLength, localExtra);
    ranges.push([local, content + compressed]); offset += 46 + nameLength + extra + comment;
  }
  ranges.sort((a, b) => a[0] - b[0]);
  if (offset !== end || ranges[0][0] !== 0 || ranges.some((range, i) => i && range[0] < ranges[i - 1][1])
    || !['[content_types].xml', '_rels/.rels', OFFICE[extension][0]].every(name => names.has(name))) throw fail('Office文件类型、条目范围或必要内容不匹配。');
  return { mimeType: OFFICE[extension][1] };
}
function fileInfo(bytes, name) {
  const extension = path.extname(name).toLowerCase();
  if (TEXT_EXTENSIONS.has(extension)) {
    let value;
    try { value = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw fail('文本素材必须使用UTF-8编码。'); }
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) throw fail('文本素材包含二进制控制字符。');
    return { mimeType: ({ '.txt': 'text/plain', '.md': 'text/markdown', '.csv': 'text/csv', '.json': 'application/json' })[extension] };
  }
  if (extension === '.pdf') {
    if (!/^%PDF-(?:1\.[0-7]|2\.0)[\r\n ]/u.test(bytes.toString('latin1', 0, 12)) || !/%%EOF\s*$/u.test(bytes.subarray(Math.max(0, bytes.length - 1024)).toString('latin1'))) throw fail('PDF头或结束标记不正确。');
    return { mimeType: 'application/pdf' };
  }
  if (own(OFFICE, extension)) return officeInfo(bytes, extension);
  throw fail('文件仅支持txt、md、csv、json、pdf、docx、xlsx和pptx，不支持可执行文件、宏文件或普通压缩包。');
}
function decode(value, max) {
  if (typeof value !== 'string' || !value.length || value.length > 4 * Math.ceil(max / 3)
    || value.length % 4 || /[^A-Za-z0-9+/=]/u.test(value)
    || value.includes('=') && !/^[^=]*={1,2}$/u.test(value)) throw fail('素材必须使用有界、标准的Base64字节，不接受路径、URL或data URL。');
  const bytes = Buffer.from(value, 'base64');
  if (!bytes.length || bytes.length > max || bytes.toString('base64') !== value) throw fail('素材字节为空、超限或Base64编码不规范。');
  return bytes;
}

/** Managed owner-uploaded bytes only. Model tools receive opaque asset IDs and
 * cached descriptions, never local paths, credentials or arbitrary fetch URLs. */
export function createQqAssetStore({ dataDir, getConfig, now = () => Date.now() } = {}) {
  if (typeof dataDir !== 'string' || !path.isAbsolute(dataDir) || typeof getConfig !== 'function' || typeof now !== 'function') throw fail('素材库配置不正确。');
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const directory = path.join(fs.realpathSync(dataDir), 'qq-assets'), blobs = path.join(directory, 'blobs'), manifestFile = path.join(directory, 'manifest.json');
  let disposed = false;
  function directories() {
    for (const location of [directory, blobs]) {
      try {
        const stat = fs.lstatSync(location);
        const real = fs.realpathSync(location), expected = path.resolve(location);
        if (!stat.isDirectory() || stat.isSymbolicLink() || (process.platform === 'win32' ? real.toLowerCase() !== expected.toLowerCase() : real !== expected)) throw integrity();
      } catch { throw integrity(); }
    }
  }
  const alive = () => { if (disposed) throw closed(); directories(); };
  for (const location of [directory, blobs]) {
    fs.mkdirSync(location, { recursive: true, mode: 0o700 });
    const stat = fs.lstatSync(location); if (!stat.isDirectory() || stat.isSymbolicLink()) throw integrity();
  }
  directories();
  const timestamp = () => { const value = now(); if (!Number.isFinite(value)) throw fail('素材时间不可用。'); return new Date(value).toISOString(); };
  const scope = (actualQQ, groupIds) => {
    if (typeof actualQQ !== 'string' || !QQ.test(actualQQ) || !Array.isArray(groupIds) || !groupIds.length || groupIds.length > 100
      || groupIds.some(id => typeof id !== 'string' || !QQ.test(id)) || new Set(groupIds).size !== groupIds.length) throw denied();
    const config = getConfig();
    if (config?.botQQ !== actualQQ || groupIds.some(id => !config.groups?.some(group => group.id === id && group.read === true))) throw denied();
    return groupIds;
  };
  const location = row => path.join(blobs, `${row.assetId}-${row.sha256}.blob`);
  function validateRow(row) {
    if (!plain(row) || Object.keys(row).some(key => !['assetId', 'actualQQ', 'groupIds', 'kind', 'name', 'sha256', 'byteLength', 'width', 'height', 'frames',
      'mimeType', 'tags', 'description', 'emotion', 'usage', 'avoidWhen', 'analysisSource', 'modelFingerprint', 'version', 'createdAt', 'updatedAt'].includes(key))
      || typeof row.assetId !== 'string' || !ID.test(row.assetId) || typeof row.actualQQ !== 'string' || !QQ.test(row.actualQQ)
      || typeof row.sha256 !== 'string' || !HASH.test(row.sha256) || !KINDS.has(row.kind)
      || !Number.isSafeInteger(row.version) || row.version < 1 || !Number.isSafeInteger(row.byteLength) || row.byteLength < 1
      || row.byteLength > (row.kind === 'file' ? QQ_ASSET_LIMITS.fileBytes : QQ_ASSET_LIMITS.imageBytes)
      || !Array.isArray(row.groupIds) || !row.groupIds.length || row.groupIds.length > 100 || row.groupIds.some(id => typeof id !== 'string' || !QQ.test(id))
      || new Set(row.groupIds).size !== row.groupIds.length || !['owner', 'vision'].includes(row.analysisSource)
      || typeof row.createdAt !== 'string' || typeof row.updatedAt !== 'string' || row.createdAt.length > 64 || row.updatedAt.length > 64
      || !Number.isFinite(Date.parse(row.createdAt)) || !Number.isFinite(Date.parse(row.updatedAt))) throw integrity();
    try {
      if (nameOf(row.name) !== row.name || JSON.stringify(metadata(row)) !== JSON.stringify({ tags: row.tags, description: row.description, emotion: row.emotion, usage: row.usage, avoidWhen: row.avoidWhen })) throw integrity();
      if (row.kind !== 'file') { dimensions(row.width, row.height); animation(row.frames, row.width * row.height * row.frames); }
      const validMime = row.kind === 'file' ? ['text/plain', 'text/markdown', 'text/csv', 'application/json', 'application/pdf', ...Object.values(OFFICE).map(value => value[1])]
        : ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
      if (!validMime.includes(row.mimeType) || row.modelFingerprint !== undefined && (typeof row.modelFingerprint !== 'string' || !HASH.test(row.modelFingerprint))
        || row.analysisSource === 'vision' && !row.modelFingerprint || row.analysisSource === 'owner' && row.modelFingerprint !== undefined) throw integrity();
    } catch { throw integrity(); }
    return row;
  }
  function load() {
    alive();
    try {
      if (!fs.existsSync(manifestFile)) {
        if (fs.readdirSync(blobs).some(name => /^asset_[a-f0-9]{32}-[a-f0-9]{64}\.blob$/u.test(name))) throw integrity();
        return { schemaVersion: 1, revision: 0, assets: [] };
      }
      const selected = fs.lstatSync(manifestFile);
      if (!selected.isFile() || selected.isSymbolicLink() || selected.nlink !== 1 || selected.size > 16 * 1024 * 1024) throw integrity();
      const handle = fs.openSync(manifestFile, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
      let bytes;
      try {
        const stat = fs.fstatSync(handle);
        if (!stat.isFile() || stat.nlink !== 1 || stat.size > 16 * 1024 * 1024 || stat.dev !== selected.dev || stat.ino !== selected.ino) throw integrity();
        const bounded = Buffer.allocUnsafe(stat.size + 1); let offset = 0;
        while (offset < bounded.length) { const read = fs.readSync(handle, bounded, offset, bounded.length - offset, offset); if (!read) break; offset += read; }
        const after = fs.fstatSync(handle);
        const currentFile = fs.lstatSync(manifestFile);
        if (offset !== stat.size || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || !currentFile.isFile() || currentFile.isSymbolicLink()
          || currentFile.dev !== stat.dev || currentFile.ino !== stat.ino || currentFile.size !== stat.size || currentFile.mtimeMs !== stat.mtimeMs) throw integrity();
        bytes = bounded.subarray(0, offset);
      } finally { fs.closeSync(handle); }
      const state = JSON.parse(bytes.toString('utf8'));
      if (!plain(state) || Object.keys(state).some(key => !['schemaVersion', 'revision', 'assets'].includes(key))
        || state.schemaVersion !== 1 || !Number.isSafeInteger(state.revision) || state.revision < 0
        || !Array.isArray(state.assets) || state.assets.length > QQ_ASSET_LIMITS.assets) throw integrity();
      state.assets.forEach(validateRow);
      if (new Set(state.assets.map(row => row.assetId)).size !== state.assets.length || state.assets.reduce((sum, row) => sum + row.byteLength, 0) > QQ_ASSET_LIMITS.totalBytes) throw integrity();
      return state;
    } catch (error) { if (error.code === 'QQ_ASSET_CLOSED') throw error; throw integrity(); }
  }
  function save(state) {
    const temporary = path.join(directory, `.manifest-${randomUUID()}.tmp`);
    const document = `${JSON.stringify(state)}\n`;
    if (Buffer.byteLength(document) > 16 * 1024 * 1024) throw fail('素材描述清单已达到容量上限，请精简后重试。', 'QQ_ASSET_QUOTA', 413);
    try {
      const handle = fs.openSync(temporary, 'wx', 0o600);
      try { fs.writeFileSync(handle, document); fs.fsyncSync(handle); } finally { fs.closeSync(handle); }
      fs.renameSync(temporary, manifestFile);
    } finally { fs.rmSync(temporary, { force: true }); }
  }
  function mutate(operation) {
    alive();
    const lock = path.join(directory, '.mutation.lock'); let handle;
    for (let attempt = 0; attempt < 2; attempt++) {
      try { handle = fs.openSync(lock, 'wx', 0o600); }
      catch (error) {
        if (error.code !== 'EEXIST') throw fail('素材目录暂时无法写入，请检查存储空间和目录权限。', 'QQ_ASSET_STORAGE_UNAVAILABLE', 503);
        let old;
        try {
          const stat = fs.lstatSync(lock); if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 100) throw new Error();
          const reader = fs.openSync(lock, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
          try { old = JSON.parse(fs.readFileSync(reader, 'utf8')); } finally { fs.closeSync(reader); }
          if (!Number.isSafeInteger(old.pid) || old.pid < 1) throw new Error();
          try { process.kill(old.pid, 0); throw new Error(); } catch (error) { if (error.code !== 'ESRCH') throw error; }
          fs.unlinkSync(lock);
        } catch { throw fail('素材库正在修改，请稍后重试。', 'QQ_ASSET_BUSY', 409); }
      }
      if (handle !== undefined) {
        try { fs.writeFileSync(handle, JSON.stringify({ pid: process.pid })); }
        catch { try { fs.closeSync(handle); } finally { fs.rmSync(lock, { force: true }); } throw fail('素材目录暂时无法写入，请检查存储空间和目录权限。', 'QQ_ASSET_STORAGE_UNAVAILABLE', 503); }
        break;
      }
    }
    if (handle === undefined) throw fail('素材库正在修改，请稍后重试。', 'QQ_ASSET_BUSY', 409);
    try {
      const state = load(), retained = new Set(state.assets.map(row => path.basename(location(row))));
      if (!fs.existsSync(manifestFile)) save(state);
      for (const entry of fs.readdirSync(blobs, { withFileTypes: true })) {
        if ((entry.isFile() || entry.isSymbolicLink()) && /^asset_[a-f0-9]{32}-[a-f0-9]{64}\.blob$/u.test(entry.name) && !retained.has(entry.name)) fs.unlinkSync(path.join(blobs, entry.name));
      }
      return operation(state);
    }
    finally { try { fs.closeSync(handle); } finally { fs.rmSync(lock, { force: true }); } }
  }
  const snapshot = (row, groupId) => {
    const { groupIds, ...result } = row;
    return { ...structuredClone(result), ...(groupId ? { groupId } : { groupIds: [...groupIds] }), size: row.byteLength };
  };
  const find = (state, assetId, actualQQ) => {
    if (typeof assetId !== 'string' || !ID.test(assetId) || typeof actualQQ !== 'string' || !QQ.test(actualQQ)) throw fail('素材标识不正确。');
    const row = state.assets.find(item => item.assetId === assetId && item.actualQQ === actualQQ);
    if (!row) throw fail('当前范围内没有该素材。', 'QQ_ASSET_NOT_FOUND', 404);
    return row;
  };
  const version = (row, expectedVersion) => { if (!Number.isSafeInteger(expectedVersion) || expectedVersion !== row.version) throw fail('素材已被修改，请刷新后重试。', 'QQ_ASSET_CONFLICT', 409); };
  async function check({ signal, authorize }) {
    alive(); if (signal?.aborted) throw cancelled();
    if (typeof authorize !== 'function') throw denied();
    if (await authorize() === false) throw denied();
    alive(); if (signal?.aborted) throw cancelled();
  }
  const readIO = async operation => { try { return await operation(); } catch { throw integrity(); } };
  function current(input, expected) {
    scope(input.actualQQ, [input.groupId]);
    const row = find(load(), input.assetId, input.actualQQ);
    if (!row.groupIds.includes(input.groupId) || input.kind !== undefined && row.kind !== input.kind) throw denied();
    if (expected && (row.version !== expected.version || row.sha256 !== expected.sha256 || row.byteLength !== expected.byteLength)) throw integrity();
    return row;
  }
  const finish = state => { state.revision++; save(state); };
  return {
    import(input) {
      fields(input, ['actualQQ', 'groupIds', 'kind', 'name', 'dataBase64', 'tags', 'description', 'emotion', 'usage', 'avoidWhen']);
      if (!KINDS.has(input.kind)) throw fail('素材类型仅支持image、sticker或file。');
      scope(input.actualQQ, input.groupIds);
      const name = nameOf(input.name), bytes = decode(input.dataBase64, input.kind === 'file' ? QQ_ASSET_LIMITS.fileBytes : QQ_ASSET_LIMITS.imageBytes);
      const info = input.kind === 'file' ? fileInfo(bytes, name) : imageInfo(bytes), extra = metadata(input), stamp = timestamp();
      return mutate(state => {
        scope(input.actualQQ, input.groupIds);
        if (state.assets.length >= QQ_ASSET_LIMITS.assets || state.assets.reduce((sum, row) => sum + row.byteLength, 0) + bytes.length > QQ_ASSET_LIMITS.totalBytes) throw fail('素材库最多1000项、合计200 MiB，请先删除不再使用的素材。', 'QQ_ASSET_QUOTA', 413);
        const row = { assetId: `asset_${randomBytes(16).toString('hex')}`, actualQQ: input.actualQQ, groupIds: [...input.groupIds], kind: input.kind, name,
          sha256: createHash('sha256').update(bytes).digest('hex'), byteLength: bytes.length, ...info, ...extra,
          analysisSource: 'owner', version: 1, createdAt: stamp, updatedAt: stamp };
        const file = location(row);
        let handle;
        try {
          handle = fs.openSync(file, 'wx', 0o600); fs.writeFileSync(handle, bytes); fs.fsyncSync(handle);
        } catch {
          if (handle !== undefined) { fs.closeSync(handle); handle = undefined; fs.rmSync(file, { force: true }); }
          throw fail('素材字节写入未完成，请检查存储空间后重试。', 'QQ_ASSET_STORAGE_UNAVAILABLE', 503);
        } finally { if (handle !== undefined) fs.closeSync(handle); }
        try { state.assets.push(row); finish(state); } catch (error) { fs.rmSync(file, { force: true }); throw error; }
        return snapshot(row);
      });
    },
    list(input) {
      fields(input, ['actualQQ', 'groupId', 'kind', 'query', 'limit']);
      scope(input.actualQQ, [input.groupId]);
      if (input.kind !== undefined && !KINDS.has(input.kind)) throw fail('素材类型不正确。');
      const query = text(input.query ?? '', '检索文字', 200).normalize('NFKC').toLowerCase().split(/\s+/u).filter(Boolean);
      const limit = input.limit ?? 20;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw fail('素材列表条数须为1–50。');
      const rows = load().assets.filter(row => row.actualQQ === input.actualQQ && row.groupIds.includes(input.groupId)
        && (input.kind === undefined || row.kind === input.kind) && query.every(term => [row.name, row.description, ...row.tags, row.emotion, row.usage, row.avoidWhen].join(' ').normalize('NFKC').toLowerCase().includes(term)));
      const result = { assets: [], hasMore: false };
      for (const row of rows) {
        if (result.assets.length >= limit) break;
        const item = snapshot(row, input.groupId);
        if (Buffer.byteLength(JSON.stringify({ ...result, assets: [...result.assets, item] })) > QQ_ASSET_LIMITS.listBytes) break;
        result.assets.push(item);
      }
      result.hasMore = rows.length > result.assets.length; return result;
    },
    findBySha(input) {
      fields(input, ['actualQQ', 'groupIds', 'sha256', 'kind']);
      scope(input.actualQQ, input.groupIds);
      if (input.kind !== 'sticker' || typeof input.sha256 !== 'string' || !HASH.test(input.sha256)) throw fail('收藏表情查重需要sticker类型和有效内容摘要。');
      const row = load().assets.find(item => item.actualQQ === input.actualQQ && item.kind === 'sticker' && item.sha256 === input.sha256
        && input.groupIds.every(id => item.groupIds.includes(id)));
      return row ? snapshot(row) : null;
    },
    async describe(input) {
      fields(input, ['assetId', 'actualQQ', 'groupId', 'kind', 'signal', 'authorize']);
      await check(input); const row = current(input); await check(input); current(input, row);
      return snapshot(row, input.groupId);
    },
    async resolve(input) {
      fields(input, ['assetId', 'actualQQ', 'groupId', 'kind', 'signal', 'authorize']);
      await check(input); const row = structuredClone(current(input)); await check(input); current(input, row);
      let handle, bytes;
      try {
        const selectedBefore = await readIO(() => fs.promises.lstat(location(row)));
        await check(input); current(input, row);
        if (!selectedBefore.isFile() || selectedBefore.isSymbolicLink() || selectedBefore.nlink !== 1 || selectedBefore.size !== row.byteLength) throw integrity();
        handle = await readIO(() => fs.promises.open(location(row), fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0)));
        await check(input); current(input, row);
        const before = await readIO(() => handle.stat());
        await check(input); current(input, row);
        if (!before.isFile() || before.nlink !== 1 || before.size !== row.byteLength || before.dev !== selectedBefore.dev || before.ino !== selectedBefore.ino) throw integrity();
        const buffer = Buffer.allocUnsafe(row.byteLength + 1); let offset = 0;
        while (offset < buffer.length) {
          const read = await readIO(() => handle.read(buffer, offset, Math.min(256 * 1024, buffer.length - offset), offset));
          await check(input); current(input, row);
          if (!read.bytesRead) break; offset += read.bytesRead;
        }
        const after = await readIO(() => handle.stat());
        await check(input); current(input, row);
        const selected = await readIO(() => fs.promises.lstat(location(row)));
        await check(input); current(input, row);
        if (offset !== row.byteLength || before.dev !== after.dev || before.ino !== after.ino || before.mtimeMs !== after.mtimeMs
          || after.size !== row.byteLength || !after.isFile() || after.nlink !== 1 || !selected.isFile() || selected.isSymbolicLink()
          || selected.dev !== before.dev || selected.ino !== before.ino || selected.size !== after.size || selected.mtimeMs !== after.mtimeMs) throw integrity();
        bytes = Buffer.from(buffer.subarray(0, offset));
        if (createHash('sha256').update(bytes).digest('hex') !== row.sha256) throw integrity();
        const info = row.kind === 'file' ? fileInfo(bytes, row.name) : imageInfo(bytes);
        if (Object.entries(info).some(([key, value]) => row[key] !== value)) throw integrity();
      } catch (error) {
        if (['ENOENT', 'EACCES', 'EPERM', 'ELOOP', 'EISDIR', 'EINVAL', 'EBADF'].includes(error.code)) throw integrity();
        throw error;
      } finally { try { await handle?.close(); } catch {} }
      await check(input); current(input, row);
      return { ...snapshot(row, input.groupId), bytes };
    },
    update(input) {
      fields(input, ['assetId', 'actualQQ', 'expectedVersion', 'name', 'groupIds', 'tags', 'description', 'emotion', 'usage', 'avoidWhen']);
      return mutate(state => {
        const row = find(state, input.assetId, input.actualQQ); version(row, input.expectedVersion);
        scope(input.actualQQ, input.groupIds ?? row.groupIds);
        const name = own(input, 'name') ? nameOf(input.name) : row.name;
        if (row.kind === 'file' && path.extname(name).toLowerCase() !== path.extname(row.name).toLowerCase()) throw fail('文件素材不能通过重命名改变文件类型。');
        Object.assign(row, metadata(input, row), { name, groupIds: [...(input.groupIds ?? row.groupIds)], analysisSource: 'owner', updatedAt: timestamp(), version: row.version + 1 });
        delete row.modelFingerprint; finish(state); return snapshot(row);
      });
    },
    annotate(input) {
      fields(input, ['assetId', 'actualQQ', 'expectedVersion', 'description', 'tags', 'emotion', 'usage', 'avoidWhen', 'source', 'modelFingerprint']);
      if (input.source !== 'vision' || typeof input.modelFingerprint !== 'string' || !HASH.test(input.modelFingerprint)) throw fail('图像分析需要vision来源与模型摘要。');
      return mutate(state => {
        const row = find(state, input.assetId, input.actualQQ); version(row, input.expectedVersion); scope(input.actualQQ, row.groupIds);
        if (!['image', 'sticker'].includes(row.kind)) throw fail('仅图片和表情包支持图像分析。');
        Object.assign(row, metadata(input, row), { analysisSource: 'vision', modelFingerprint: input.modelFingerprint, updatedAt: timestamp(), version: row.version + 1 });
        finish(state); return snapshot(row);
      });
    },
    remove(input) {
      fields(input, ['assetId', 'actualQQ', 'expectedVersion']);
      return mutate(state => {
        const row = find(state, input.assetId, input.actualQQ); version(row, input.expectedVersion); scope(input.actualQQ, row.groupIds);
        state.assets = state.assets.filter(item => item.assetId !== row.assetId); finish(state);
        fs.rmSync(location(row), { force: true }); return { assetId: row.assetId, removed: true };
      });
    },
    dispose() { disposed = true; },
  };
}
