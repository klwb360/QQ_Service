import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG, DEFAULT_GROUP_SOCIAL, validateConfig } from '../src/config.mjs';

function withGroups() {
  return { ...structuredClone(DEFAULT_CONFIG), groups: [
    { id: '222222', mode: 'social', read: true, send: false },
    { id: '333333', mode: 'work', read: true, send: false, social: { delivery: { maxMessages: 1 } } },
  ] };
}

test('旧群补齐回复节奏但不启用自由聊天、发送或主动参与，且群之间不共享配置', () => {
  const input = withGroups(), before = structuredClone(input);
  const checked = validateConfig(input);
  assert.deepEqual(input, before);
  assert.deepEqual(checked.groups[0].social.delivery, { enabled: true, maxMessages: 3, pauseMs: 800 });
  assert.deepEqual(checked.groups[1].social.delivery, { enabled: true, maxMessages: 1, pauseMs: 800 });
  for (const group of checked.groups) {
    assert.equal(group.social.enabled, false);
    assert.equal(group.social.proactive, false);
    assert.equal(group.send, false);
  }
  assert.equal(checked.permissions.released, false);
  checked.groups[0].social.delivery.pauseMs = 0;
  assert.equal(checked.groups[1].social.delivery.pauseMs, 800);
  assert.equal(DEFAULT_GROUP_SOCIAL.delivery.pauseMs, 800);
});

test('每群回复节奏可关闭、单条发送及零停顿，并完整保留到再次读取校验', () => {
  const config = withGroups();
  config.groups[0].social = { delivery: { enabled: false, maxMessages: 1, pauseMs: 0 } };
  config.groups[1].social = { delivery: { enabled: true, maxMessages: 3, pauseMs: 1500 } };
  const checked = validateConfig(config);
  assert.deepEqual(checked.groups[0].social.delivery, config.groups[0].social.delivery);
  assert.deepEqual(checked.groups[1].social.delivery, config.groups[1].social.delivery);
  assert.deepEqual(validateConfig(JSON.parse(JSON.stringify(checked))), checked);
});

test('回复节奏参数严格有界且未知字段不能影响权限或发送时序', () => {
  const cases = [
    [null, 'delivery'], [[], 'delivery'], [false, 'delivery'],
    [{ enabled: 'true' }, 'enabled'], [{ enabled: 1 }, 'enabled'],
    [{ maxMessages: 0 }, 'maxMessages'], [{ maxMessages: 4 }, 'maxMessages'],
    [{ maxMessages: 1.5 }, 'maxMessages'], [{ maxMessages: '2' }, 'maxMessages'],
    [{ pauseMs: -1 }, 'pauseMs'], [{ pauseMs: 1501 }, 'pauseMs'],
    [{ pauseMs: Infinity }, 'pauseMs'], [{ pauseMs: NaN }, 'pauseMs'],
    [{ pauseMs: 1.5 }, 'pauseMs'], [{ pauseMs: '800' }, 'pauseMs'],
    [{ released: true }, 'released'], [{ allowWrite: true }, 'allowWrite'],
    [{ delays: [0, 30000] }, 'delays'],
  ];
  for (const [delivery, field] of cases) {
    const config = withGroups(); config.groups[0].social = { delivery };
    assert.throws(() => validateConfig(config), error => error.issues.some(issue =>
      issue.path === (field === 'delivery' ? 'groups.0.social.delivery' : `groups.0.social.delivery.${field}`)),
    `reject invalid ${field}`);
  }
});
