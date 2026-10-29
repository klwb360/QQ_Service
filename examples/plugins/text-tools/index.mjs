// Self-contained, read-only demonstration. No filesystem, network, or model calls.
// The host validates the declared tool name and arguments before invoking this code.

export async function run() {
  return { text: '文本统计工具已就绪。授权 text-tools/count_text 后，可通过群工具指令让 AI 按需调用。' };
}

export async function callTool({ name, arguments: args }) {
  if (name !== 'count_text') throw new Error('不支持的工具。');
  if (typeof args?.text !== 'string') throw new TypeError('text 必须为文本。');
  const text = args.text;
  const characters = Array.from(text);
  return {
    text: JSON.stringify({
      characters: characters.length,
      charactersWithoutWhitespace: characters.filter(character => !/\s/u.test(character)).length,
      lines: text.length ? text.split(/\r\n|\r|\n/u).length : 0,
    }),
  };
}
