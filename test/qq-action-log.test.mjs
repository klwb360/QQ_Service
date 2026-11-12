import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createQqActionLog } from '../src/qq-action-log.mjs';

const input = { id: 'turn:1', actualQQ: '111111', groupId: '222222', requesterQQ: '333333', tool: 'qq:send_sticker', status: 'checking', executed: false };
function fixture(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-action-log-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  return { dataDir, file: path.join(dataDir, 'qq-actions.json') };
}
test('persistent QQ action facts update one identity, isolate scopes and discard payloads even on reload', t => {
  const f = fixture(t); let now = new Date('2026-11-12T01:00:00.000Z');
  const log = createQqActionLog({ dataDir: f.dataDir, now: () => now });
  log.record({ ...input, bytes: Buffer.from('private'), token: 'do-not-log', arguments: { text: 'private' } });
  now = new Date('2026-11-12T01:01:00.000Z');
  log.record({ ...input, status: 'unknown', executed: null, messageIds: ['-123', '-123'], code: 'ONEBOT_TIMEOUT' });
  log.record({ ...input, id: 'turn:2', actualQQ: '444444' });
  const rows = log.list({ actualQQ: input.actualQQ });
  assert.equal(rows.length, 1); assert.equal(rows[0].status, 'unknown'); assert.equal(rows[0].executed, null);
  assert.deepEqual(rows[0].messageIds, ['-123']); assert.equal(rows[0].createdAt, '2026-11-12T01:00:00.000Z');
  assert.equal(rows[0].updatedAt, now.toISOString());
  rows[0].status = 'succeeded'; assert.equal(log.list({ actualQQ: input.actualQQ })[0].status, 'unknown');
  assert.throws(() => log.record({ ...input, actualQQ: '444444' }), /原账号/);
  const disk = JSON.parse(fs.readFileSync(f.file, 'utf8')); disk[0].bytes = 'unexpected-private';
  fs.writeFileSync(f.file, JSON.stringify(disk));
  const reloaded = createQqActionLog({ dataDir: f.dataDir });
  assert.equal(reloaded.list().length, 2);
  assert.doesNotMatch(JSON.stringify(reloaded.list()), /private|bytes|token|arguments/);
});
test('QQ receipts remain bounded to the latest 1000 facts and API reads to 100', t => {
  const f = fixture(t), log = createQqActionLog(f);
  for (let i = 0; i < 1002; i++) log.record({ ...input, id: `turn:${i}` });
  const disk = JSON.parse(fs.readFileSync(f.file, 'utf8'));
  assert.equal(disk.length, 1000); assert.equal(disk[0].id, 'turn:1001'); assert.equal(disk.at(-1).id, 'turn:2');
  assert.equal(log.list({ limit: 99999 }).length, 100);
  assert.equal(log.list({ groupId: '444444' }).length, 0);
});
test('corrupt or nonregular receipt files fail without overwriting preserved facts', t => {
  const f = fixture(t); fs.writeFileSync(f.file, '[{"status":"invented"}]');
  assert.throws(() => createQqActionLog(f), /格式损坏/);
  assert.equal(fs.readFileSync(f.file, 'utf8'), '[{"status":"invented"}]');
  fs.rmSync(f.file); fs.mkdirSync(f.file); assert.throws(() => createQqActionLog(f), /文件无效/);
});
