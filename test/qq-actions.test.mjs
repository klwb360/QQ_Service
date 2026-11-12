import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createStore } from '../src/store.mjs';
import { executeBuiltinQQTool, listBuiltinQQTools, BUILTIN_QQ_TOOL_IDS } from '../src/qq-tools.mjs';
import { sendQqFile } from '../src/qq-media-delivery.mjs';

const actualQQ = '111111', groupId = '222222', userId = '333333';
const row = (fields = {}) => ({ actualQQ, groupId, userId, messageId: '-12345', role: 'user', text: '真实收到的本群文字',
  time: Math.floor(Date.now() / 1000), displayName: '群友', delivery: 'received', ...fields });
const person = (id = userId, fields = {}) => ({ group_id: groupId, user_id: id, nickname: '群友昵称', card: '群名片', role: 'member', ...fields });
const deferred = () => { let resolve; return { promise: new Promise(done => { resolve = done; }), resolve }; };
function fixture(options = {}) {
  const calls = [], sent = [], media = []; let checks = 0;
  const context = { actualQQ, groupId, signal: options.signal,
    authorize: async () => { checks++; return options.authorize?.(); },
    store: options.store || { conversation: { list: async args => {
      assert.deepEqual(args, { actualQQ, groupId, limit: 100 }); return options.rows || [row()];
    } }, conversationState: { filterHistory: async args => options.filter ? options.filter(args) : args.messages } },
    action: async (name, params, extra) => {
      calls.push({ name, params: structuredClone(params) });
      if (options.action) return options.action(name, params, extra);
      if (name === 'get_group_member_info') return person(params.user_id);
      if (name === 'get_group_member_list') return [person()];
      return null;
    },
    sendMessage: async args => {
      sent.push(structuredClone(args)); return options.sendMessage ? options.sendMessage(args) : { messageId: '-9988' };
    },
    ...(options.assets ? { assets: options.assets } : {}),
    ...Object.fromEntries(['sendImage', 'sendFile', 'sendSticker', 'sendForward', 'recallMessage'].filter(name => options[name]).map(name => [name, async args => {
      media.push({ name, args: structuredClone(args) }); return options[name](args);
    }])),
    ...(options.getConnectionStatus ? { getConnectionStatus: options.getConnectionStatus } : {}),
  };
  return { context, calls, sent, media, checks: () => checks,
    invoke: (name, args = {}) => executeBuiltinQQTool(`qq:${name}`, args, context) };
}
const isInvalid = error => error.statusCode === 400;
const isDenied = error => error.code === 'QQ_ACTION_DENIED' && error.statusCode === 403;

test('the fixed eighteen-tool directory preserves cached reads and marks only actual QQ writes as write effects', () => {
  const tools = listBuiltinQQTools();
  assert.equal(tools.length, 18); assert.deepEqual(tools.map(tool => tool.id), BUILTIN_QQ_TOOL_IDS);
  assert.deepEqual(tools.filter(tool => tool.effect === 'write').map(tool => tool.id), ['qq:poke_member', 'qq:send_message', 'qq:react_message',
    'qq:send_image', 'qq:send_file', 'qq:forward_messages', 'qq:recall_own_message', 'qq:send_sticker']);
  assert.ok(tools.filter(tool => tool.id.startsWith('qq:current_group_')).every(tool => tool.effect === 'read'));
  assert.ok(tools.every(tool => tool.source === 'qq' && tool.inputSchema.additionalProperties === false));
  tools[0].inputSchema.properties.unapproved = { type: 'string' };
  assert.equal(listBuiltinQQTools()[0].inputSchema.properties.unapproved, undefined);
});

const approvedAsset = (fields = {}) => {
  const bytes = Buffer.from('host-approved content');
  return { assetId: 'asset-001', actualQQ, groupId, kind: 'image', name: 'approved.png', bytes,
    sha256: createHash('sha256').update(bytes).digest('hex'), ...fields };
};

test('group info and connection status expose only the current verified identity and bounded summary fields', async () => {
  const f = fixture({ action: async name => {
    assert.equal(name, 'get_group_info');
    return { group_id: groupId, group_name: '摄影群', member_count: 12, max_member_count: 2000,
      token: 'secret-token', group_remark: 'private remark' };
  }, getConnectionStatus: async () => ({ actualQQ, connected: true, online: true, state: 'connected', transport: 'ws',
    connector: 'napcat', url: 'ws://private-token', token: 'secret-token', anotherQQ: '999999' }) });
  assert.deepEqual(await f.invoke('current_group_info'), { groupId, name: '摄影群', memberCount: 12, maxMemberCount: 2000 });
  assert.deepEqual(f.calls, [{ name: 'get_group_info', params: { group_id: groupId, no_cache: true } }]);
  assert.deepEqual(await f.invoke('connection_status'), { actualQQ, connected: true, online: true, state: 'connected', transport: 'ws', connector: 'napcat' });
  const wrong = fixture({ action: async () => ({ group_id: '999999' }), getConnectionStatus: async () => ({ actualQQ: '999999', connected: true }) });
  await assert.rejects(wrong.invoke('current_group_info'), error => error.statusCode === 502);
  await assert.rejects(wrong.invoke('connection_status'), error => error.statusCode === 502);
});

test('asset listing and saved descriptions stay scoped and never expose bytes, paths, URLs or invoke vision', async () => {
  const resolve = () => { assert.fail('description/list must not resolve bytes or call a vision service'); };
  const f = fixture({ assets: {
    list: async args => {
      assert.deepEqual(args, { actualQQ, groupId, kind: 'sticker', query: '开心', limit: 1 });
      return { assets: [approvedAsset({ kind: 'sticker', name: '开心.gif', size: 7, path: '/secret', url: 'https://private' }),
        approvedAsset({ assetId: 'other-asset', kind: 'sticker', name: '开心外群.gif', groupId: '999999' })], hasMore: false };
    }, resolve, describe: async args => {
      assert.equal(args.assetId, 'asset-001'); assert.equal(args.actualQQ, actualQQ); assert.equal(args.groupId, groupId);
      return approvedAsset({ kind: 'sticker', description: '开心的小猫', tags: ['猫', '开心'], emotion: '喜悦',
        usage: ['庆祝好消息'], avoidWhen: ['讨论坏消息'], path: '/private/file.gif', url: 'https://private' });
    },
  } });
  const listed = await f.invoke('list_assets', { kind: 'sticker', query: '开心', limit: 1 });
  assert.equal(listed.assets.length, 1); assert.equal(listed.assets[0].assetId, 'asset-001');
  const described = await f.invoke('describe_asset', { assetId: 'asset-001' });
  assert.equal(described.description, '开心的小猫'); assert.deepEqual(described.usage, ['庆祝好消息']);
  for (const output of [listed, described]) {
    assert.equal(JSON.stringify(output).includes('/private'), false); assert.equal(JSON.stringify(output).includes('https://'), false);
    assert.equal(JSON.stringify(output).includes('host-approved content'), false); assert.equal(output.bytes, undefined);
  }
  assert.equal(f.calls.length, 0);
});

test('asset search preserves host matches on saved tags and emotions even when the opaque filename has no query text', async () => {
  const f = fixture({ assets: { list: async args => {
    assert.equal(args.query, '开心'); assert.equal(args.kind, 'sticker');
    return { assets: [approvedAsset({ kind: 'sticker', name: 'b928.gif', tags: ['开心'], emotion: '喜悦' }),
      approvedAsset({ assetId: 'outside-asset', groupId: '999999', kind: 'sticker', name: 'outside.gif', tags: ['开心'] })], hasMore: false };
  } } });
  const result = await f.invoke('list_assets', { kind: 'sticker', query: '开心' });
  assert.deepEqual(result.assets.map(item => item.name), ['b928.gif']); assert.equal(result.assets[0].assetId, 'asset-001');
});

test('image, file and sticker sends verify approved bytes/hash/scope then delegate only opaque asset IDs', async () => {
  for (const [tool, kind, callback] of [['send_image', 'image', 'sendImage'], ['send_file', 'file', 'sendFile'], ['send_sticker', 'sticker', 'sendSticker']]) {
    const f = fixture({ assets: { resolve: async args => {
      assert.equal(args.kind, kind); assert.equal(args.assetId, 'asset-001'); assert.equal(typeof args.authorize, 'function');
      assert.equal(args.actualQQ, actualQQ); assert.equal(args.groupId, groupId); return approvedAsset({ kind });
    } }, [callback]: async () => ({ messageId: '-8877' }) });
    const input = { assetId: 'asset-001', ...(kind === 'image' ? { caption: '普通文字 [CQ:at,qq=all]' } : {}) };
    const result = await f.invoke(tool, input);
    assert.deepEqual(f.media, [{ name: callback, args: input }]); assert.equal(result.status, 'sent'); assert.equal(result.messageId, '-8877');
    assert.equal(result.bytes, undefined); assert.equal(f.calls.length, 0);
  }
});

test('asset scope, kind, digest, size and opaque ID failures cannot reach a send callback', async () => {
  for (const asset of [null, approvedAsset({ actualQQ: '999999' }), approvedAsset({ groupId: '999999' }), approvedAsset({ kind: 'file' }),
    approvedAsset({ assetId: 'other-asset' }), approvedAsset({ sha256: '0'.repeat(64) }), approvedAsset({ bytes: 'not-bytes' }),
    approvedAsset({ bytes: new Uint8Array(0) }), approvedAsset({ bytes: new Uint8Array(10 * 1024 * 1024 + 1) })]) {
    const f = fixture({ assets: { resolve: async () => asset }, sendImage: async () => assert.fail('unapproved asset must not send') });
    await assert.rejects(f.invoke('send_image', { assetId: 'asset-001' }), isDenied);
    assert.equal(f.media.length, 0);
  }
  for (const id of ['../secret', '/tmp/image.png', 'https://example.com/a', 'file://a']) {
    const f = fixture({ assets: { resolve: async () => assert.fail('must reject path before lookup') }, sendImage: async () => ({ messageId: '1' }) });
    await assert.rejects(f.invoke('send_image', { assetId: id }), isInvalid); assert.equal(f.media.length, 0);
  }
});

test('forwarding proves every source ID in visible current-group cache and preserves the requested order once', async () => {
  const own = row({ messageId: '7766', role: 'assistant', userId: actualQQ, delivery: 'sent' });
  const f = fixture({ rows: [row(), own], sendForward: async () => ({ messageId: '-6677' }) });
  const result = await f.invoke('forward_messages', { messageIds: ['7766', '-12345', '7766'] });
  assert.deepEqual(f.media, [{ name: 'sendForward', args: { messageIds: ['7766', '-12345'] } }]);
  assert.equal(result.forwardedCount, 2); assert.equal(result.messageId, '-6677'); assert.equal(f.calls.length, 0);
  for (const hidden of [[], [row({ groupId: '999999' })], [row({ actualQQ: '999999' })], [row({ delivery: 'failed', role: 'assistant', userId: actualQQ })]]) {
    const missing = fixture({ rows: hidden, sendForward: async () => assert.fail('hidden message must not forward') });
    await assert.rejects(missing.invoke('forward_messages', { messageIds: ['-12345'] }), isDenied); assert.equal(missing.media.length, 0);
  }
});

test('recall requires a current visible ACKed message sent by this account, never another member or guessed ID', async () => {
  const f = fixture({ rows: [row({ role: 'assistant', userId: actualQQ, delivery: 'sent' })], recallMessage: async () => ({ executed: true }) });
  const result = await f.invoke('recall_own_message', { messageId: '-12345' });
  assert.equal(result.status, 'applied'); assert.deepEqual(f.media, [{ name: 'recallMessage', args: { messageId: '-12345' } }]);
  for (const source of [row(), row({ role: 'assistant', userId: actualQQ, delivery: 'failed' }),
    row({ role: 'assistant', userId: '444444', delivery: 'sent' }), row({ role: 'assistant', userId: actualQQ, delivery: 'sent', groupId: '999999' })]) {
    const other = fixture({ rows: [source], recallMessage: async () => assert.fail('must not recall') });
    await assert.rejects(other.invoke('recall_own_message', { messageId: '-12345' }), isDenied); assert.equal(other.media.length, 0);
  }
});

test('notice and file endpoints use fixed current-group parameters and expose bounded metadata without downloads', async () => {
  const f = fixture({ action: async (name, params) => {
    if (name === '_get_group_notice') return Array.from({ length: 10 }, (_, index) => ({ notice_id: `notice-${index}`, sender_id: Number(userId), publish_time: 12345,
      message: { text: '中'.repeat(3000), images: [{ id: 'opaque-picture', url: 'https://private' }] }, settings: { private: 'secret' } }));
    if (name === 'get_group_root_files' || name === 'get_group_files_by_folder') return {
      files: [{ group_id: groupId, file_id: 'opaque+file==', file_name: 'report.pdf', file_size: 123, upload_time: 321,
        url: 'https://private', path: '/private/report.pdf' }, { group_id: '999999', file_id: 'outside', file_name: 'outside' }],
      folders: [{ group_id: groupId, folder_id: '/opaque-folder', folder_name: '报告', total_file_count: 3 }],
    };
    assert.fail(name);
  } });
  const notices = await f.invoke('group_notices', { limit: 10 });
  assert.ok(notices.notices.length < 10); assert.equal(notices.hasMore, true); assert.equal(notices.notices[0].imageCount, 1);
  assert.ok(Buffer.byteLength(JSON.stringify(notices)) <= 24 * 1024);
  const root = await f.invoke('group_files', { limit: 2 });
  assert.equal(root.complete, false); assert.equal(root.files.length, 1); assert.equal(root.folders.length, 1);
  assert.equal(root.files[0].fileId, 'opaque+file=='); assert.equal(root.folders[0].folderId, '/opaque-folder');
  await f.invoke('group_files', { folderId: '/opaque-folder', limit: 1 });
  assert.deepEqual(f.calls.map(call => call.params), [{ group_id: groupId }, { group_id: groupId, file_count: 2 },
    { group_id: groupId, folder_id: '/opaque-folder', file_count: 1 }]);
  for (const result of [notices, root]) { assert.equal(JSON.stringify(result).includes('https://'), false); assert.equal(JSON.stringify(result).includes('/private'), false); }
});

test('new media and message tools reject unsupported callbacks and injected parameters before any write', async () => {
  const f = fixture();
  for (const [tool, args] of [['send_image', { assetId: 'asset-001' }], ['send_file', { assetId: 'asset-001' }],
    ['send_sticker', { assetId: 'asset-001' }], ['forward_messages', { messageIds: ['-12345'] }],
    ['recall_own_message', { messageId: '-12345' }], ['describe_asset', { assetId: 'asset-001' }], ['connection_status', {}]]) {
    await assert.rejects(f.invoke(tool, args), isDenied);
  }
  for (const [tool, args] of [['send_image', { assetId: 'asset-001', url: 'https://private' }], ['send_file', { assetId: 'asset-001', path: '/private' }],
    ['forward_messages', { messageIds: [] }], ['forward_messages', { messageIds: Array.from({ length: 11 }, () => '1') }],
    ['recall_own_message', { messageId: '-12345', userId }], ['group_files', { limit: 31 }],
    ['group_notices', { limit: 11 }], ['connection_status', { account: '999999' }]]) await assert.rejects(f.invoke(tool, args), isInvalid);
  assert.equal(f.calls.length, 0); assert.equal(f.media.length, 0);
});

test('revocation during asset approval prevents sends and a lost write response remains uncertain without retries', async () => {
  const entered = deferred(), pending = deferred(); let permitted = true;
  const revoked = Object.assign(new Error('asset permission revoked'), { code: 'AUTH_REVOKED', statusCode: 409 });
  const f = fixture({ authorize: () => { if (!permitted) throw revoked; }, assets: { resolve: async () => { entered.resolve(); return pending.promise; } },
    sendImage: async () => assert.fail('revoked asset must not send') });
  const running = f.invoke('send_image', { assetId: 'asset-001' }); await entered.promise; permitted = false; pending.resolve(approvedAsset());
  await assert.rejects(running, error => error === revoked); assert.equal(f.media.length, 0);
  const timeout = Object.assign(new Error('file ACK timed out'), { code: 'ONEBOT_TIMEOUT' });
  const unknown = fixture({ assets: { resolve: async () => approvedAsset({ kind: 'file' }) }, sendFile: async () => { throw timeout; } });
  await assert.rejects(unknown.invoke('send_file', { assetId: 'asset-001' }), error => error === timeout && error.deliveryUncertain === true);
  assert.equal(unknown.media.length, 1);
  const unsupported = Object.assign(new Error('unsupported before dispatch'), { code: 'QQ_ACTION_DENIED', statusCode: 403, deliveryUncertain: false });
  const noTransport = fixture({ assets: { resolve: async () => approvedAsset() }, sendImage: async () => { throw unsupported; } });
  await assert.rejects(noTransport.invoke('send_image', { assetId: 'asset-001' }), error => error === unsupported && isDenied(error) && error.deliveryUncertain === false);
});

test('missing host ACKs for new writes are uncertain, never invented successes or retryable denials', async () => {
  for (const response of [undefined, null, {}, { executed: false }, { messageId: 'guessed-id' }]) {
    const f = fixture({ assets: { resolve: async () => approvedAsset() }, sendImage: async () => response });
    await assert.rejects(f.invoke('send_image', { assetId: 'asset-001' }), error => error.statusCode === 502 && error.deliveryUncertain === true);
    assert.equal(f.media.length, 1);
  }
  const recall = fixture({ rows: [row({ role: 'assistant', userId: actualQQ, delivery: 'sent' })], recallMessage: async () => null });
  await assert.rejects(recall.invoke('recall_own_message', { messageId: '-12345' }), error => error.deliveryUncertain === true);
  const acknowledged = fixture({ assets: { resolve: async () => approvedAsset({ kind: 'file' }) }, sendFile: async () => ({ executed: true }) });
  assert.equal((await acknowledged.invoke('send_file', { assetId: 'asset-001' })).executed, true);
});

test('the real file sender receipt preserves its opaque file ID through the QQ tool without inventing a message ID', async () => {
  const asset = approvedAsset({ kind: 'file', name: 'approved.pdf' }), fileId = 'opaque+real-file/uuid==';
  const f = fixture({ assets: { resolve: async () => asset }, sendFile: async ({ assetId }) => {
    assert.equal(assetId, asset.assetId);
    return sendQqFile({ asset, groupId, authorize: async () => true, onDispatch: async () => {},
      action: async (name, params) => { assert.equal(name, 'upload_group_file'); assert.equal(params.group_id, groupId); return { file_id: fileId }; } });
  } });
  const result = await f.invoke('send_file', { assetId: asset.assetId });
  assert.equal(result.fileId, fileId); assert.equal(result.executed, true); assert.equal(result.messageId, undefined); assert.equal(result.messageIds, undefined);
  for (const value of ['', null, 'x'.repeat(1025), 'bad\nfile-id', { nested: 'not-an-id' }]) {
    const invalid = fixture({ assets: { resolve: async () => asset }, sendFile: async () => ({ executed: true, fileId: value }) });
    await assert.rejects(invalid.invoke('send_file', { assetId: asset.assetId }), error => error.statusCode === 502 && error.deliveryUncertain === true);
    assert.equal(invalid.media.length, 1, 'an invalid post-dispatch receipt must not be retried');
  }
});

test('members search exposes only bounded QQ/name/card/role data from the current group', async () => {
  const f = fixture({ action: async name => {
    assert.equal(name, 'get_group_member_list');
    return [person('333333', { nickname: '星空摄影', card: '摄影群友', role: 'admin', age: 99, secret: 'unrelated' }),
      person('444444', { nickname: '旅行爱好者' }), person('555555', { group_id: '999999', nickname: '星空摄影外群' })];
  } });
  const result = await f.invoke('current_group_members', { query: '星空 摄影' });
  assert.deepEqual(f.calls[0], { name: 'get_group_member_list', params: { group_id: groupId } });
  assert.deepEqual(result.members, [{ userId, nickname: '星空摄影', card: '摄影群友', role: 'admin' }]);
  assert.equal(JSON.stringify(result).includes('unrelated'), false); assert.equal(result.hasMore, false);
  const large = fixture({ action: async () => Array.from({ length: 100 }, (_, i) => person(String(400000 + i), { nickname: '中'.repeat(300), card: '文'.repeat(300) })) });
  const bounded = await large.invoke('current_group_members', { limit: 50 });
  assert.ok(bounded.members.length <= 50); assert.ok(Buffer.byteLength(JSON.stringify(bounded)) <= 24 * 1024);
  assert.equal(bounded.hasMore, true);
});

test('single-member lookup proves both the current group and the requested QQ before returning metadata', async () => {
  const f = fixture();
  const result = await f.invoke('current_group_member', { userId });
  assert.deepEqual(result, { groupId, member: { userId, nickname: '群友昵称', card: '群名片', role: 'member' } });
  for (const mismatch of [person('444444'), person(userId, { group_id: '999999' }), { user_id: userId }, null]) {
    const refused = fixture({ action: async () => mismatch });
    await assert.rejects(refused.invoke('current_group_member', { userId }), isDenied);
    assert.equal(refused.calls.length, 1);
  }
});

test('poke verifies a real current-group member before one fixed group_poke action', async () => {
  const f = fixture();
  const result = await f.invoke('poke_member', { userId });
  assert.deepEqual(f.calls, [
    { name: 'get_group_member_info', params: { group_id: groupId, user_id: userId, no_cache: true } },
    { name: 'group_poke', params: { group_id: groupId, user_id: userId } },
  ]);
  assert.deepEqual(result, { executed: true, status: 'applied', action: 'poke', groupId, userId });
  const unknown = fixture({ action: async () => person(userId, { group_id: '999999' }) });
  await assert.rejects(unknown.invoke('poke_member', { userId }), isDenied);
  assert.equal(unknown.calls.some(call => call.name === 'group_poke'), false);
});

test('send verifies mentions and cached replies, then delegates only typed business fields to the host sender', async () => {
  const f = fixture();
  const text = '这只是普通文字 [CQ:at,qq=all]，不执行CQ。';
  const result = await f.invoke('send_message', { text, mentionUserIds: [userId, userId, '444444'], replyToMessageId: '-12345' });
  assert.deepEqual(f.calls.map(call => call.params.user_id), [userId, '444444']);
  assert.deepEqual(f.sent, [{ text, mentionUserIds: [userId, '444444'], replyToMessageId: '-12345' }]);
  assert.equal(result.executed, true); assert.equal(result.status, 'sent'); assert.equal(result.messageId, '-9988');
  const simple = fixture(); await simple.invoke('send_message', { text: '普通消息' });
  assert.deepEqual(simple.sent[0], { text: '普通消息', mentionUserIds: [] }); assert.equal(simple.calls.length, 0);
});

test('reply and reaction targets must be signed IDs in the current verified and still-visible cache', async () => {
  const f = fixture();
  const result = await f.invoke('react_message', { messageId: '-12345', emojiId: '66', set: false });
  assert.deepEqual(f.calls, [{ name: 'set_msg_emoji_like', params: { message_id: '-12345', emoji_id: '66', set: false } }]);
  assert.equal(result.executed, true); assert.equal(result.status, 'applied');
  for (const hiddenRows of [[], [row({ actualQQ: '999999' })], [row({ groupId: '888888' })], [row({ role: 'assistant', userId: actualQQ, delivery: 'failed' })],
    [row({ isNotice: true })], [row({ time: Math.floor(Date.now() / 1000) - 31 * 86400 })]]) {
    const hidden = fixture({ rows: hiddenRows });
    await assert.rejects(hidden.invoke('react_message', { messageId: '-12345', emojiId: '66', set: true }), isDenied);
    assert.equal(hidden.calls.length, 0);
    await assert.rejects(hidden.invoke('send_message', { text: '不能引用隐藏消息', replyToMessageId: '-12345' }), isDenied);
    assert.equal(hidden.sent.length, 0);
  }
});

test('real SQLite conversation clear revokes cached message actions without get_msg or cross-group fallback', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-fixed-actions-')), store = createStore(directory);
  t.after(() => { store.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  store.conversation.record(row()); store.conversation.record(row({ groupId: '888888', messageId: '-99999' }));
  const f = fixture({ store });
  await f.invoke('react_message', { messageId: '-12345', emojiId: '66', set: true });
  await assert.rejects(f.invoke('react_message', { messageId: '-99999', emojiId: '66', set: true }), isDenied);
  const current = store.conversationState.get({ actualQQ, groupId });
  store.conversationState.clear({ actualQQ, groupId, version: current.version });
  await assert.rejects(f.invoke('react_message', { messageId: '-12345', emojiId: '66', set: false }), isDenied);
  assert.deepEqual(f.calls.map(call => call.name), ['set_msg_emoji_like']);
});

test('unknown parameters, @all, arbitrary segments, invalid signed IDs and out-of-range inputs never dispatch', async () => {
  const f = fixture();
  for (const [name, args] of [
    ['poke_member', { userId, groupId: '888888' }], ['poke_member', { userId: 'all' }], ['poke_member', { userId: '0000' }],
    ['send_message', { text: 'x', message: [{ type: 'at', data: { qq: 'all' } }] }],
    ['send_message', { text: 'x', mentionUserIds: ['all'] }], ['send_message', { text: 'x', mentionUserIds: [userId, '444444', '555555', '666666'] }],
    ['send_message', { text: ' ' }], ['send_message', { text: 'x'.repeat(1801) }], ['send_message', { text: 'x', replyToMessageId: 'out:fake' }],
    ['react_message', { messageId: '0', emojiId: '66', set: true }], ['react_message', { messageId: '-12345', emojiId: '-1', set: true }],
    ['react_message', { messageId: '-12345', emojiId: '66', set: true, action: 'delete_msg' }],
    ['current_group_members', { limit: 51 }], ['current_group_member', { userId: 'all' }],
  ]) await assert.rejects(f.invoke(name, args), isInvalid, `${name} ${JSON.stringify(args)}`);
  assert.equal(f.calls.length, 0); assert.equal(f.sent.length, 0);
});

test('definite missing-member errors are business refusals while transport errors retain their original identity', async () => {
  const absent = Object.assign(new Error('member not found'), { code: 'GROUP_MEMBER_NOT_FOUND' });
  const missing = fixture({ action: async () => { throw absent; } });
  await assert.rejects(missing.invoke('poke_member', { userId }), isDenied);
  assert.equal(missing.calls.length, 1);
  const transport = Object.assign(new Error('member lookup socket closed'), { code: 'ECONNRESET' });
  const offline = fixture({ action: async () => { throw transport; } });
  await assert.rejects(offline.invoke('poke_member', { userId }), error => error === transport);
  assert.equal(transport.deliveryUncertain, undefined); assert.equal(offline.calls.length, 1);
  const writeTimeout = Object.assign(new Error('poke response timed out'), { code: 'ONEBOT_TIMEOUT' });
  const uncertain = fixture({ action: async name => { if (name === 'get_group_member_info') return person(); throw writeTimeout; } });
  await assert.rejects(uncertain.invoke('poke_member', { userId }), error => error === writeTimeout && error.deliveryUncertain === true);
  assert.equal(uncertain.calls.filter(call => call.name === 'group_poke').length, 1, 'uncertain writes must never retry');
});

test('revocation or clear while a member/cache read is pending passes through authorization and prevents every write', async () => {
  const entered = deferred(), pending = deferred(); let permitted = true;
  const revoked = Object.assign(new Error('scope changed'), { code: 'AUTH_REVOKED', statusCode: 409 });
  const f = fixture({ authorize: () => { if (!permitted) throw revoked; }, action: async () => { entered.resolve(); return pending.promise; } });
  const running = f.invoke('poke_member', { userId }); await entered.promise; permitted = false; pending.resolve(person());
  await assert.rejects(running, error => error === revoked);
  assert.equal(f.calls.length, 1); assert.equal(f.sent.length, 0);
  const cacheEntered = deferred(), cachePending = deferred(); let cacheAllowed = true;
  const cleared = fixture({ authorize: () => { if (!cacheAllowed) throw revoked; }, filter: async () => { cacheEntered.resolve(); return cachePending.promise; } });
  const reaction = cleared.invoke('react_message', { messageId: '-12345', emojiId: '66', set: true });
  await cacheEntered.promise; cacheAllowed = false; cachePending.resolve([row()]);
  await assert.rejects(reaction, error => error === revoked); assert.equal(cleared.calls.length, 0);
});

test('a lost response after write submission stays uncertain and never becomes a safe-denial object', async () => {
  const entered = deferred(), pending = deferred(); let permitted = true;
  const revoked = Object.assign(new Error('cleared after action submission'), { statusCode: 409, code: 'AUTH_REVOKED' });
  const f = fixture({ authorize: () => { if (!permitted) throw revoked; }, action: async name => {
    if (name === 'get_group_member_info') return person(); entered.resolve(); return pending.promise;
  } });
  const action = f.invoke('poke_member', { userId }); await entered.promise; permitted = false; pending.resolve(null);
  await assert.rejects(action, error => error === revoked && error.deliveryUncertain === true);
  assert.equal(f.calls.filter(call => call.name === 'group_poke').length, 1);
  const controller = new AbortController(); controller.abort(); const stopped = fixture({ signal: controller.signal });
  await assert.rejects(stopped.invoke('poke_member', { userId }), error => error.code !== 'QQ_ACTION_DENIED');
  assert.equal(stopped.calls.length, 0);
});
