// This example has no top-level effects, dependencies, or model calls.
// Each invocation gets a fresh worker; do not rely on module globals as storage.

export async function run({ input, settings = {}, context = {} }) {
  const command = settings.prefix || '/ping';
  const note = typeof input?.message === 'string' ? input.message.slice(0, 200) : '';
  return {
    text: `群聊问候示例已就绪。账号配置：${context.profileId || '未提供'}；命令：${command}。${note ? `\n本次本地输入：${note}` : ''}`,
  };
}

export async function onMessage({ event, settings = {} }) {
  const command = settings.prefix || '/ping';
  if (typeof event?.text !== 'string' || event.text.trim() !== command) return null;
  // The host decides whether this reply can be sent to the current group.
  // Returning a reply never grants account or group sending permission.
  return { reply: settings.response || 'Pong!' };
}
