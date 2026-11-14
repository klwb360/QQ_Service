import { createHash, randomUUID } from 'node:crypto';

const BACKENDS = new Set(['napcat', 'snowluma']);
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const NATIVE_ID = /^-?[1-9]\d{0,19}$/u;
const fail = () => Object.assign(new Error('QQ 消息来源或消息引用无效。'), { code: 'QQ_MESSAGE_ORIGIN_INVALID', statusCode: 400 });
const plain = value => value && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));

/** Origins are host-created connection generations, never account or memory
 * identities. Every new socket must get a fresh generation. */
export function createQqMessageOrigin(backend) {
  if (!BACKENDS.has(backend)) throw fail();
  return Object.freeze({ backend, connectionId: randomUUID() });
}

export function normalizeQqMessageOrigin(value) {
  if (!plain(value) || Object.getOwnPropertySymbols(value).length) throw fail();
  const fields = Object.getOwnPropertyDescriptors(value);
  if (Object.keys(fields).length !== 2 || !Object.hasOwn(fields.backend || {}, 'value')
    || !Object.hasOwn(fields.connectionId || {}, 'value') || !BACKENDS.has(fields.backend.value)
    || typeof fields.connectionId.value !== 'string' || !UUID.test(fields.connectionId.value)) throw fail();
  return { backend: fields.backend.value, connectionId: fields.connectionId.value };
}

export const isQqNativeMessageId = value => typeof value === 'string' && NATIVE_ID.test(value);

/** The opaque cache ID is also the memory evidence ID. A nonnumeric transport
 * fallback is retained as history but can never become a QQ action target. */
export function qqMessageReference({ origin, nativeMessageId } = {}) {
  const source = normalizeQqMessageOrigin(origin);
  if (typeof nativeMessageId !== 'string' || !nativeMessageId.trim() || nativeMessageId.length > 300 || nativeMessageId.includes('\0')) throw fail();
  const value = isQqNativeMessageId(nativeMessageId) ? `n:${nativeMessageId}`
    : `h:${createHash('sha256').update(nativeMessageId).digest('hex')}`;
  return `qqref:v1:${source.backend}:${source.connectionId}:${value}`;
}

/** Parsing alone is not evidence. Callers must locate the visible stored row
 * and use matchesQqMessageOrigin before performing any QQ action. */
export function parseQqMessageReference(value) {
  if (typeof value !== 'string' || value.length > 180) return null;
  const match = /^qqref:v1:(napcat|snowluma):([a-f0-9-]{36}):(n:(-?[1-9]\d{0,19})|h:([a-f0-9]{64}))$/u.exec(value);
  if (!match || !UUID.test(match[2])) return null;
  return { origin: { backend: match[1], connectionId: match[2] }, nativeMessageId: match[4] || '',
    ...(match[5] ? { opaque: true } : {}) };
}

/** row.origin/nativeMessageId must come from the store's explicit provenance
 * columns, not from model input or a prefix guessed from a legacy message ID. */
export function matchesQqMessageOrigin(row, expected) {
  try {
    if (!plain(row) || !isQqNativeMessageId(row.nativeMessageId)) return false;
    const source = normalizeQqMessageOrigin(row.origin), target = normalizeQqMessageOrigin(expected);
    return source.backend === target.backend && source.connectionId === target.connectionId
      && row.messageId === qqMessageReference({ origin: source, nativeMessageId: row.nativeMessageId });
  } catch { return false; }
}
