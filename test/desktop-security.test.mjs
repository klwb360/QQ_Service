import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  backendUrlForPort, parseBackendReady, isDashboardResource,
  isDashboardNavigation, isAllowedExternalUrl, defaultDataDir,
} = require('../desktop/security.cjs');

test('桌面只信任后台公布的本机端口，拒绝无效启动记录', () => {
  assert.equal(backendUrlForPort(3210), 'http://127.0.0.1:3210');
  assert.equal(parseBackendReady('QQ Bridge dashboard: http://127.0.0.1:43127'), 'http://127.0.0.1:43127');
  for (const port of [0, -1, 65536, 3.5, '3210', NaN]) assert.equal(backendUrlForPort(port), null);
  for (const line of [
    'QQ Bridge dashboard: http://evil.test:3210',
    'QQ Bridge dashboard: http://127.0.0.1:65536',
    'QQ Bridge dashboard: http://127.0.0.1:3210/api/state',
    'QQ Bridge dashboard: http://127.0.0.1:3210\nLocal data: private',
  ]) assert.equal(parseBackendReady(line), null);
});

test('独立窗口保留同源资源，阻止远程资源及 API 页面导航', () => {
  const origin = 'http://127.0.0.1:43127';
  for (const value of [`${origin}/`, `${origin}/index.html`, `${origin}/#modules`]) {
    assert.equal(isDashboardNavigation(value, origin), true);
  }
  for (const value of [`${origin}/app.js`, `${origin}/api/state`]) {
    assert.equal(isDashboardResource(value, origin), true);
    assert.equal(isDashboardNavigation(value, origin), false);
  }
  for (const value of [
    'https://example.com/app.js', 'http://localhost:43127/',
    'http://127.0.0.1:43128/', 'file:///C:/Windows/System32/cmd.exe',
    'data:text/html,hello', 'javascript:alert(1)',
    'http://user:pass@127.0.0.1:43127/',
  ]) {
    assert.equal(isDashboardResource(value, origin), false);
    assert.equal(isDashboardNavigation(value, origin), false);
  }
  assert.equal(isDashboardResource(`${origin}/`, null), false);
  assert.equal(isDashboardNavigation(`${origin}/?redirect=https://example.com`, origin), false);
});

test('外部浏览器允许官方授权与本机 QQ 登录，拒绝危险协议、伪造域名及内部 API', () => {
  const origin = 'http://127.0.0.1:43127';
  for (const value of [
    'https://auth.openai.com/codex/device', 'https://chatgpt.com/',
    'https://docs.docker.com/desktop/setup/install/windows-install/',
    'https://platform.deepseek.com/', 'http://127.0.0.1:6099/webui/',
    'http://localhost:6099/',
  ]) assert.equal(isAllowedExternalUrl(value, origin), true, value);
  for (const value of [
    `${origin}/api/config/export`, 'http://127.0.0.1:6099/api/login',
    'https://auth.openai.com.evil.test/codex/device', 'https://auth.openai.com@evil.test/',
    'https://user:pass@auth.openai.com/', 'https://auth.openai.com:444/',
    'http://auth.openai.com/', 'file:///C:/test.exe', 'javascript:alert(1)',
    'ms-appinstaller:https://evil.test/app', 'https://example.com/',
  ]) assert.equal(isAllowedExternalUrl(value, origin), false, value);
});

test('桌面资料放在用户目录，显式目录覆盖保留重启后的配置位置', () => {
  assert.equal(defaultDataDir('win32', { LOCALAPPDATA: '/users/me/local' }, '/users/me'), path.join('/users/me/local', 'QQBridgeDashboard'));
  assert.equal(defaultDataDir('win32', {}, '/users/me'), path.join('/users/me', 'AppData', 'Local', 'QQBridgeDashboard'));
  assert.equal(defaultDataDir('linux', {}, '/users/me'), path.join('/users/me', '.local', 'share', 'qq-bridge-dashboard'));
  assert.equal(defaultDataDir('win32', { QQ_DASHBOARD_DATA_DIR: './test-profile' }, '/users/me'), path.resolve('./test-profile'));
});
