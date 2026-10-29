import { createHash } from 'node:crypto';
import { validateToolInput } from './tool-schema.mjs';

const fail = message => Object.assign(new Error(message), { status: 400 });
const checkSignal = signal => { if (signal?.aborted) throw Object.assign(fail('工具请求已取消。'), { status: 409 }); };
export const toolFunctionName = id => `tool_${createHash('sha256').update(id).digest('hex').slice(0, 24)}`;
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
export const toolCallFingerprint = (id, args) => createHash('sha256').update(`${id}:${JSON.stringify(canonical(args))}`).digest('hex');

/** The model can choose only from this request's already-authorized tools.
 * Validate the whole proposed batch before performing any external operation.
 * Failures never retry an external operation or switch billing channels.
 */
export async function runToolConversation({ messages, tools, infer, execute, signal, maxCalls = 3 }) {
  if (!Number.isInteger(maxCalls) || maxCalls < 1 || maxCalls > 3) throw fail('工具调用上限无效。');
  const byName = new Map(tools.map(tool => [tool.name, tool]));
  if (byName.size !== tools.length) throw fail('工具名称重复。');
  const definitions = tools.map(tool => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.inputSchema } }));
  const conversation = structuredClone(messages);
  const seen = new Set(), writes = new Set(), used = [];
  for (let round = 0; round <= maxCalls; round++) {
    checkSignal(signal);
    const available = used.length < maxCalls;
    const result = await infer(conversation, available ? definitions : [], { toolChoice: available ? 'auto' : 'none' });
    checkSignal(signal);
    const proposed = result?.toolCalls ?? [];
    if (!Array.isArray(proposed)) throw fail('模型工具调用格式无效。');
    if (!proposed.length) {
      if (typeof result?.text !== 'string' || !result.text.trim()) throw fail('模型没有返回工具调用或文字结果。');
      const { reasoningContent, ...visible } = result;
      return { ...visible, toolExecutions: used.length, toolNames: [...used] };
    }
    if (proposed.length > maxCalls - used.length) throw fail('工具调用超过本次上限，请缩小需求。');
    if (result.reasoningContent != null && (typeof result.reasoningContent !== 'string' || Buffer.byteLength(result.reasoningContent) > 128 * 1024)) throw fail('工具续传字段无效或超过长度限制。');
    const batchIds = new Set(), batchWrites = new Set();
    const batch = proposed.map(call => {
      if (!call || call.type !== 'function' || typeof call.id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(call.id)
        || seen.has(call.id) || batchIds.has(call.id)) throw fail('模型工具调用 ID 无效或重复。');
      batchIds.add(call.id);
      const tool = byName.get(call.function?.name);
      if (!tool) throw fail('模型请求了未授权或不存在的工具。');
      const encoded = call.function?.arguments;
      if (typeof encoded !== 'string' || Buffer.byteLength(encoded) > 16 * 1024) throw fail('工具参数必须是有界的 JSON 文本。');
      let input;
      try { input = JSON.parse(encoded); } catch { throw fail('工具参数 JSON 格式无效。'); }
      const validated = validateToolInput(tool.inputSchema, input);
      const signature = tool.effect === 'write' ? `${tool.id}:${JSON.stringify(canonical(validated))}` : null;
      if (signature && (writes.has(signature) || batchWrites.has(signature))) throw fail('本次请求不能重复提交同一个外部写入操作。');
      if (signature) batchWrites.add(signature);
      return { call, tool, input: validated, signature };
    });
    conversation.push({ role: 'assistant', content: result.text || null, tool_calls: proposed,
      ...(typeof result.reasoningContent === 'string' ? { reasoning_content: result.reasoningContent } : {}) });
    for (const { call, tool, input, signature } of batch) {
      checkSignal(signal);
      seen.add(call.id);
      if (signature) writes.add(signature);
      const value = await execute(tool, input);
      checkSignal(signal);
      used.push(tool.id);
      // Tool output is data. Never promote it to a system instruction.
      const content = JSON.stringify(value ?? { text: '' });
      if (Buffer.byteLength(content) > 32 * 1024) throw fail('工具返回结果体积过大。');
      conversation.push({ role: 'tool', tool_call_id: call.id, content });
    }
  }
  throw fail('工具调用达到上限，未生成最终回答。');
}
