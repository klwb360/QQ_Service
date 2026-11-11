const MAX_OUTPUT_BYTES = 256 * 1024;

function failure(message, status = 502) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function combineSignal(signal, timeoutMs) {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function safeError(value, secret = '') {
  const text = String(value || '未知错误');
  return (secret ? text.split(secret).join('[已隐藏]') : text)
    .replace(/Bearer\s+\S+/gi, 'Bearer [已隐藏]')
    .replace(/\b(?:sk-|eyJ)[A-Za-z0-9._-]+/g, '[已隐藏]')
    .slice(0, 500);
}

/** Providers never select another billing channel when one channel fails. */
export function createProviders({ fetchImpl = globalThis.fetch } = {}) {
  async function chatCompletion({ messages, config, apiKey, signal, provider, label, official = false, tools, toolChoice = 'auto' }) {
    if (!apiKey) throw failure(`尚未设置 ${label} API Key，请在模型配置的密钥栏填写并保存。`, 400);
    if (!config?.enabled) throw failure(`${label} 模块尚未启用，请先在模型配置中开启。`, 400);
    if (signal?.aborted) throw failure('模型请求已取消。', 409);
    let base;
    try {
      base = new URL(String(config.baseUrl).replace(/\/+$/, '') + '/');
      if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash) throw new Error();
      if (official && (base.hostname !== 'api.deepseek.com' || base.port || !['/', '/v1/'].includes(base.pathname))) throw new Error();
    } catch {
      throw failure(official ? 'DeepSeek 官方地址应为 https://api.deepseek.com 或其 /v1 地址；其他服务请添加兼容 API。' : `${label} 地址须使用 HTTPS，且不能携带账号、密码或查询参数。`, 400);
    }
    if (!config.model) throw failure(`${label} 尚未设置模型名称，请填写服务商提供的模型 ID。`, 400);
    const url = new URL('chat/completions', base);
    // Current Kimi K3 models require a fixed temperature. The documented
    // compatible request omits it and lets the service apply its own default;
    // keep the user's stored preference for other models and custom endpoints.
    const fixedKimiTemperature = ['api.moonshot.cn', 'api.moonshot.ai'].includes(base.hostname)
      && ['kimi-k3', 'kimi-k3.1-pro', 'kimi-k3.1-pro-highspeed'].includes(config.model);
    let response;
    try {
      response = await fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        redirect: 'error',
        body: JSON.stringify({
          model: config.model,
          messages,
          stream: false,
          max_tokens: config.maxTokens,
          ...(!fixedKimiTemperature ? { temperature: config.temperature } : {}),
          ...(tools !== undefined ? { tools, tool_choice: toolChoice, parallel_tool_calls: false } : {}),
        }),
        signal: combineSignal(signal, 60_000),
      });
    } catch (error) {
      if (signal?.aborted) throw failure('模型请求已取消。', 409);
      if (error.name === 'TimeoutError' || error.name === 'AbortError') throw failure(`${label} 请求超时，请检查网络后重试。`);
      throw failure(`${label} 网络连接失败：${safeError(error.message, apiKey)}；请检查 API 地址和网络。`);
    }
    let payload;
    try {
      const raw = await response.text();
      if (Buffer.byteLength(raw) > MAX_OUTPUT_BYTES) throw new Error('响应超过大小限制');
      payload = JSON.parse(raw);
    } catch {
      throw failure(`${label} 返回了无法解析的响应（HTTP ${response.status}），请确认服务兼容 Chat Completions 接口。`);
    }
    if (signal?.aborted) throw failure('模型请求已取消。', 409);
    if (!response.ok) {
      const guidance = [401, 403].includes(response.status) ? '请检查 API Key 及其访问权限'
        : response.status === 429 ? '请检查服务商额度或请求频率，稍后重试'
          : response.status === 404 ? '请检查 API 基础地址和模型 ID'
            : '请检查密钥、额度、模型名称和参数';
      throw failure(`${label} 请求失败（HTTP ${response.status}）：${safeError(payload?.error?.message || '服务返回错误', apiKey)}；${guidance}。`);
    }
    const message = payload?.choices?.[0]?.message;
    const text = message?.content;
    const calls = message?.tool_calls;
    if ((calls != null && !Array.isArray(calls)) || (calls?.length && (!tools?.length || toolChoice === 'none' || calls.length > 3))) throw failure(`${label} 返回了无效或未授权的工具调用。`);
    if ((!Array.isArray(calls) || !calls.length) && (typeof text !== 'string' || !text.trim())) throw failure(`${label} 没有返回可用的文字回答，请检查模型是否支持文字聊天或工具调用。`);
    const truncated = payload.choices[0].finish_reason === 'length';
    if (truncated && calls?.length) throw failure(`${label} 的工具调用输出被截断，本次未执行工具。`);
    const reasoning = tools !== undefined ? message?.reasoning_content : undefined;
    if (reasoning != null && (typeof reasoning !== 'string' || Buffer.byteLength(reasoning) > 128 * 1024)) throw failure(`${label} 的工具续传字段无效或超过长度限制。`);
    return { provider, text: (typeof text === 'string' ? text.trim() : '') + (truncated ? '\n\n[模型输出达到长度限制，回答可能不完整。]' : ''), ...(calls?.length ? { toolCalls: calls } : {}), ...(typeof reasoning === 'string' ? { reasoningContent: reasoning } : {}), usage: payload.usage || null, truncated };
  }

  const deepseek = args => chatCompletion({ ...args, provider: 'deepseek', label: 'DeepSeek', official: true });
  const compatible = args => chatCompletion({ ...args, provider: args.provider || args.config?.id, label: safeError(args.config?.label || '兼容 API') });

  return { deepseek, compatible };
}
