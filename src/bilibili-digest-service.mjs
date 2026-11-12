import { createBilibiliDigestService } from './bilibili-digests.mjs';
import { createBilibiliLibraryClient } from './bilibili-library.mjs';
import { readBilibiliDigestSources } from './bilibili-digest-sources.mjs';
import { normalizeBilibiliDigestToolInput, bilibiliDigestToolEffect } from './bilibili-digest-tools.mjs';
import { isBundledBilibiliServer } from './mcp-manager.mjs';
import { mcpSecretName } from './mcp-config.mjs';

const fail = (message, statusCode = 409) => Object.assign(new Error(message), { statusCode, code: 'BILIBILI_DIGEST_REJECTED' });

/** Host adapter only. Job control cannot be exposed by copying an MCP name:
 * the runtime and manager independently bind the bundled program, approval,
 * caller and original chat. No API key or callback URL goes into its child. */
export function createBilibiliDigestIntegration({ account, store, mcpManager, getRuntime, log = () => {},
  engineFactory = createBilibiliDigestService, clientFactory = createBilibiliLibraryClient,
  readSources = readBilibiliDigestSources, now = () => Date.now() } = {}) {
  let closed = false;
  const runtime = () => {
    if (closed) throw fail('账号后台正在退出，Bilibili 任务已停止。');
    const value = getRuntime();
    if (!value || typeof value.authorizeBilibiliJob !== 'function') throw fail('当前运行时尚未提供聊天后台任务。');
    return value;
  };
  const serverFor = binding => {
    const server = store.getConfig().mcp?.servers?.find(item => item.id === binding.serverId);
    if (!server?.enabled || !isBundledBilibiliServer(server)) throw fail('任务所属的内置 Bilibili MCP 配置已停用或改变。');
    return server;
  };
  const sessionFor = job => {
    const server = serverFor(job.binding);
    if (!server.envKeys.includes('BILIBILI_SESSDATA')) throw fail('读取本人收藏和稍后再看前，请在这个 MCP 服务的独立凭据中配置 BILIBILI_SESSDATA；不要把登录凭据发到聊天中。');
    const value = store.getSecret(mcpSecretName(server.id, 'env', 'BILIBILI_SESSDATA'));
    if (!value) throw fail('此 Bilibili MCP 尚未保存本人的登录凭据，请在已有 MCP 凭据栏设置后重新发起任务。');
    return value;
  };
  const authorize = async (job, options) => {
    if (closed) throw fail('账号已退出，后台任务已取消。');
    await runtime().authorizeBilibiliJob(job, options);
    if (closed || options?.signal?.aborted) throw fail('Bilibili 后台任务已取消。');
  };
  const engine = engineFactory({ store, getConfig: store.getConfig, now, log, authorize,
    readLibrary: async (job, options = {}) => {
      await authorize(job, { ...options, phase: 'read_library' });
      const client = clientFactory({ now, getSession: async () => {
        await authorize(job, { ...options, phase: 'read_credential' });
        return sessionFor(job);
      } });
      return readSources(job, { ...options, client, now,
        authorize: () => authorize(job, { ...options, phase: 'read_source' }) });
    },
    summarize: (content, options) => runtime().summarizeBilibiliItem(content, options),
    deliver: (job, options) => runtime().deliverBilibiliDigest(job, options?.text ?? job.result.text, options),
  });

  const control = async ({ action, input, tool, origin, binding, signal, requestText = '' } = {}) => {
    if (closed) throw fail('账号已退出，不能创建后台任务。');
    if (!origin || origin.profileId !== account.id || origin.actualQQ !== store.getConfig().botQQ) throw fail('后台任务的账号身份与当前聊天不一致。', 403);
    const actual = mcpManager.builtinBilibiliBinding?.(tool?.id);
    if (!actual || actual.remoteName !== action || actual.serverId !== tool.serverId
      || actual.connectionHash !== tool.connectionHash || actual.definitionHash !== tool.definitionHash) throw fail('只能通过当前已审批的内置 Bilibili MCP 管理后台任务。', 403);
    const effect = bilibiliDigestToolEffect(action);
    if (!effect || tool.effect !== effect) throw fail('后台任务创建和取消需要任务写入授权；网站读取权限不能代替它。', 403);
    if (signal?.aborted) throw fail('原聊天请求已取消，未创建后台任务。');
    const args = normalizeBilibiliDigestToolInput(action, input);
    if (action === 'queue_library_digest') {
      if (args.schedule.mode === 'daily' && (!/(?:每天|每日|每晚|每早|天天|daily|every\s+day)/iu.test(requestText)
        || /(?:不要|不用|别|取消|停止).{0,8}(?:每天|每日|每晚|daily)/iu.test(requestText))) {
        throw fail('这次原始消息没有明确要求每日重复任务；请说明“每天”及希望运行的时段，或先创建一次任务。', 400);
      }
      const job = { request: args, origin, binding };
      await authorize(job, { phase: 'queue', signal });
      sessionFor(job);
      return engine.queue(args, { origin, binding, signal });
    }
    if (action === 'library_digest_status') return engine.status({ ...args, origin });
    return engine.cancel({ ...args, origin });
  };
  return {
    control,
    engine,
    start: () => engine.start(),
    tick: value => engine.tick(value),
    reload: options => engine.reload(options),
    // A change to an unrelated MCP must not stop a valid recurring Bili task.
    async toolsChanged(event) {
      if (closed) return;
      const server = store.getConfig().mcp?.servers?.find(item => item.id === event?.serverId);
      if (server && isBundledBilibiliServer(server)) await engine.reload({ reason: 'MCP 工具或连接已变化，请在聊天中重新确认任务。' });
    },
    async close() { if (!closed) { closed = true; await engine.close(); } },
  };
}
