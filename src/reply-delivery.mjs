/**
 * Pure presentation planning for an already validated reply. Permission,
 * interruption, transport chunking and actual delivery records belong to the
 * caller. Model output can suggest text boundaries, never timing or actions.
 */
export const DEFAULT_REPLY_DELIVERY_SETTINGS = Object.freeze({
  enabled: true,
  maxMessages: 3,
  pauseMs: 800,
});

const MAX_TEXT = 12000;
const MAX_MESSAGES = 3;
const MAX_PAUSE_MS = 1500;
const MAX_TOTAL_PAUSE_MS = 4000;
const MODES = new Set(['auto', 'chat', 'complete']);

function invalidPlan() {
  return Object.assign(new Error('回复内容或分条计划无效，请重试。'), {
    code: 'REPLY_DELIVERY_INVALID', status: 502,
  });
}

const boundedNumber = (value, fallback, minimum, maximum) => typeof value === 'number' && Number.isFinite(value)
  ? Math.min(maximum, Math.max(minimum, Math.floor(value))) : fallback;

/** Read only the current human request, not retrieved instructions or history. */
function requestsOneMessage(requestText) {
  if (typeof requestText !== 'string') return false;
  const request = requestText.slice(0, MAX_TEXT);
  if (/(?:不要|不用|别|无需|不必|请勿)(?:再|给我)?(?:拆分|分条|分段|分开发|拆开发|拆成多条|分成多条)/u.test(request)) return true;
  if (/(?:不要|不用|别)(?:一次|一条|完整)/u.test(request)) return false;
  return /(?:一次(?:性)?(?:完整)?(?:发完|发送|发|输出)|完整(?:地)?(?:一次(?:性)?发|输出|发送|发给我)|一条(?:消息)?(?:发完|发送|发|回复))/u.test(request)
    || /\b(?:in (?:one|a single) (?:message|response)|(?:do not|don't) (?:split|break)(?: it| this)?(?: up| into)|send(?: it)?(?: all)? at once)\b/iu.test(request);
}

/** Formatting is deliberately conservative: the low-level sender may still
 * need technical chunks, but presentation must not rearrange these answers.
 */
function hasProtectedStructure(text, requestText) {
  if (/```|~~~|`[^`\n]+`/u.test(text)) return true;
  if (/(?:https?:\/\/|www\.)\S+|!?\[[^\]\n]+\]\([^\n]+\)/iu.test(text)) return true;
  if (/^\s*(?:#{1,6}\s|>\s?|[-*+]\s|(?:\d+[.)、]|[一二三四五六七八九十]+[、.])\s*|[（(]\d+[）)]\s*)/mu.test(text)) return true;
  if (/^.*\|.*\|.*$/mu.test(text) || /^\s*(?:[-*_]\s*){3,}$/mu.test(text)) return true;
  if (/^\s*(?:\{|\[|<\?xml\b|<(?:html|table|pre|code)\b)/imu.test(text)) return true;
  if (/(?:通知|公告|操作步骤|注意事项|行动项|任务清单|截止时间|原文依据|通知汇总|详细说明|使用说明|总结|结论)[：:]/u.test(text)) return true;
  if (typeof requestText === 'string' && /(?:总结|汇总|通知|公告|详细说明|操作步骤|列出步骤|列个清单|完整代码|完整文章|完整故事)/u.test(requestText.slice(0, MAX_TEXT))) return true;
  // Long prose is often a requested explanation or narrative. Avoid turning
  // it into arbitrary chat bubbles; transport retains its own length limit.
  return text.length > 1600;
}

function suggestedMessages(messages) {
  if (messages === undefined) return null;
  if (!Array.isArray(messages) || messages.length > MAX_MESSAGES) throw invalidPlan();
  if (!messages.length) return null;
  let length = 0;
  return messages.map(message => {
    if (typeof message !== 'string' || !message.trim() || (length += message.length) > MAX_TEXT) throw invalidPlan();
    return message.trim();
  });
}

function combineToLimit(parts, maxMessages) {
  if (parts.length <= maxMessages) return parts;
  // Preserve every paragraph in order, including the remainder. There is no
  // character slicing here: the sender owns technical transport boundaries.
  return [...parts.slice(0, maxMessages - 1), parts.slice(maxMessages - 1).join('\n\n')];
}

function paragraphMessages(text, maxMessages) {
  if (!/\n\s*\n/u.test(text) || text.length > 900) return null;
  const parts = text.split(/\n\s*\n/u).map(part => part.trim()).filter(Boolean);
  if (parts.length < 2 || parts.some(part => part.length > 360 || part.includes('\n'))) return null;
  const limited = combineToLimit(parts, maxMessages);
  return limited.every(part => part.length <= 500) ? limited : null;
}

/** Only obvious sentence boundaries in short unstructured prose are used.
 * Quotes/brackets protect punctuation inside them; periods are excluded to
 * avoid breaking decimals, abbreviations and domains in old text-only output.
 */
function sentenceMessages(text, maxMessages) {
  if (text.includes('\n') || text.length < 50 || text.length > 600) return null;
  const opens = new Map([['“', '”'], ['‘', '’'], ['「', '」'], ['『', '』'], ['（', '）'], ['(', ')'], ['[', ']'], ['【', '】'], ['{', '}']]);
  const closes = new Set(opens.values());
  const stack = [];
  const parts = [];
  let straightQuote = '';
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === '"' && text[index - 1] !== '\\') {
      straightQuote = straightQuote ? '' : '"';
      continue;
    }
    if (opens.has(character)) stack.push(opens.get(character));
    else if (closes.has(character)) {
      if (stack.at(-1) === character) stack.pop();
      else return null;
    }
    if (stack.length || straightQuote || !/[。！？!?]/u.test(character)) continue;
    // Keep repeated punctuation and closing straight quotes with the sentence.
    let end = index + 1;
    while (end < text.length && /[。！？!?"']/u.test(text[end])) end += 1;
    const sentence = text.slice(start, end).trim();
    if (sentence) parts.push(sentence);
    start = end;
    index = end - 1;
  }
  if (stack.length || straightQuote) return null;
  const remainder = text.slice(start).trim();
  if (remainder) parts.push(remainder);
  if (parts.length < 2 || parts.some(part => part.length < 8)) return null;
  // Group adjacent sentences so long answers never become a burst of tiny
  // messages. Equal-size targets are stable and need no additional model call.
  const target = Math.ceil(text.length / Math.min(parts.length, maxMessages));
  const groups = [];
  let current = '';
  for (const part of parts) {
    if (current && current.length >= target && groups.length < maxMessages - 1) {
      groups.push(current);
      current = '';
    }
    current += part;
  }
  if (current) groups.push(current);
  return groups.length > 1 ? groups : null;
}

function delaysFor(messages, pauseMs, inferenceMs) {
  // A slow model has already made the user wait. At five seconds, send all
  // remaining bubbles immediately; never delay the first bubble at all.
  const elapsed = typeof inferenceMs === 'number' && Number.isFinite(inferenceMs) ? Math.max(0, inferenceMs) : 0;
  const waitingFactor = Math.max(0, 1 - Math.max(0, elapsed - 1500) / 3500);
  let remainingBudget = MAX_TOTAL_PAUSE_MS;
  return messages.map((text, index) => {
    let delayMs = 0;
    if (index && pauseMs) {
      const lengthAllowance = Math.min(700, Math.max(0, text.length - 60) * 4);
      delayMs = Math.min(remainingBudget, Math.round(Math.min(MAX_PAUSE_MS, pauseMs + lengthAllowance) * waitingFactor));
      remainingBudget -= delayMs;
    }
    return { text, delayMs };
  });
}

/**
 * text is the authoritative complete reply. Optional messages must reconstruct
 * it exactly using blank lines; inconsistent suggestions are ignored safely.
 * mode comes from validated replyMode, requestText from the current human.
 * Returned delayMs is a wait BEFORE that bubble, not a model-selected timer.
 */
export function createReplyDeliveryPlan({ text = '', messages, mode = 'auto', settings = {}, inferenceMs = 0, requestText = '' } = {}) {
  if (typeof text !== 'string' || text.length > MAX_TEXT || !MODES.has(mode)) throw invalidPlan();
  const suggested = suggestedMessages(messages);
  const body = text.trim();
  if (!body) return { segments: [], source: 'empty', mode };
  const options = settings && typeof settings === 'object' && !Array.isArray(settings) ? settings : {};
  const maxMessages = boundedNumber(options.maxMessages, DEFAULT_REPLY_DELIVERY_SETTINGS.maxMessages, 1, MAX_MESSAGES);
  const pauseMs = boundedNumber(options.pauseMs, DEFAULT_REPLY_DELIVERY_SETTINGS.pauseMs, 0, MAX_PAUSE_MS);
  const keepComplete = options.enabled === false || maxMessages === 1 || mode === 'complete'
    || requestsOneMessage(requestText) || hasProtectedStructure(body, requestText);
  if (keepComplete) return { segments: [{ text: body, delayMs: 0 }], source: 'single', mode: 'complete' };

  let parts;
  let source;
  if (suggested?.join('\n\n') === body) {
    parts = combineToLimit(suggested, maxMessages);
    source = 'model';
  } else {
    parts = paragraphMessages(body, maxMessages);
    source = 'paragraphs';
    if (!parts) {
      parts = sentenceMessages(body, maxMessages);
      source = 'sentences';
    }
  }
  if (!parts) return { segments: [{ text: body, delayMs: 0 }], source: 'single', mode };
  return { segments: delaysFor(parts, pauseMs, inferenceMs), source, mode };
}
