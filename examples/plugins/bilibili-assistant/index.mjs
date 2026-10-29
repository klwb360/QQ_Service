import { createBilibiliClient } from './http.mjs';

// Imports have no network or account side effects. The host supplies only this
// plugin's own declared settings/secrets after checking account/tool grants.
export async function run() {
  return { text: 'Bilibili 工具已就绪。可搜索、读取热门与视频简介；发表评论需要额外的写入授权和当前插件登录凭据。此检查不联网，也不验证真实登录。' };
}

export async function callTool({ name, arguments: args = {}, settings = {}, secrets = {} }) {
  const client = createBilibiliClient();
  let value;
  if (name === 'popular_videos') value = await client.popular(args, settings, secrets);
  else if (name === 'search_videos') value = await client.search(args, settings, secrets);
  else if (name === 'video_details') value = await client.details(args, settings, secrets);
  else if (name === 'comment_and_mention') value = await client.commentAndMention(args, settings, secrets);
  else throw new Error('不支持的 Bilibili 工具。');
  let text = JSON.stringify(value);
  for (const key of ['sessdata', 'csrf']) if (typeof secrets[key] === 'string' && secrets[key]) text = text.split(secrets[key]).join('[已隐藏]');
  if (text.length > 6000) throw new Error('Bilibili 结果过长，请缩小条数或需求后重新查询。');
  return { text };
}
