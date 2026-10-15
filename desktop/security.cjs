'use strict';

const path = require('node:path');

function validPort(value) {
  return Number.isSafeInteger(value) && value >= 1 && value <= 65535;
}

function backendUrlForPort(port) {
  if (!validPort(port)) return null;
  return `http://127.0.0.1:${port}`;
}

function parseBackendReady(line) {
  const match = /^QQ Bridge dashboard: http:\/\/127\.0\.0\.1:([1-9]\d{0,4})$/.exec(line);
  return match ? backendUrlForPort(Number(match[1])) : null;
}

function isDashboardResource(value, origin) {
  if (!origin) return false;
  try {
    const url = new URL(value);
    return url.origin === origin && url.protocol === 'http:' && !url.username && !url.password;
  } catch { return false; }
}

function isDashboardNavigation(value, origin) {
  if (!isDashboardResource(value, origin)) return false;
  const url = new URL(value);
  return (url.pathname === '/' || url.pathname === '/index.html') && !url.search;
}

function isDashboardIpcSender(event, contents, origin) {
  // IPC is available only to the live dashboard's top frame. An embedded
  // same-origin frame or a previous page cannot control the native window.
  try {
    return Boolean(contents && !contents.isDestroyed()
      && event?.sender === contents
      && event.senderFrame === contents.mainFrame
      && isDashboardNavigation(event.senderFrame.url, origin));
  } catch { return false; }
}

function isAccountProfileId(value) {
  return typeof value === 'string' && (value === 'legacy'
    || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value));
}

function configExportPath(profileId) {
  if (profileId === undefined) return '/api/config/export';
  if (!isAccountProfileId(profileId)) throw new Error('账号标识无效，请重新选择账号。');
  return `/api/accounts/${profileId}/config/export`;
}

function isAllowedExternalUrl(value, origin) {
  try {
    const url = new URL(value);
    if (url.username || url.password || url.href.length > 2048) return false;
    if (url.origin === origin) return false;
    if (url.protocol === 'http:') {
      // Only the local NapCat login page. Never pass a local API or arbitrary
      // executable/file protocol to the operating system's URL handler.
      return ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
        && (url.port === '' || validPort(Number(url.port)))
        && ['/', '/webui', '/webui/'].includes(url.pathname)
        && !url.search;
    }
    if (url.protocol !== 'https:' || (url.port && url.port !== '443')) return false;
    return new Set([
      'auth.openai.com', 'chatgpt.com', 'openai.com', 'help.openai.com',
      'developers.openai.com', 'learn.chatgpt.com', 'docs.docker.com',
      'www.docker.com', 'desktop.docker.com', 'napneko.github.io',
      'platform.deepseek.com', 'api-docs.deepseek.com',
      'help.aliyun.com', 'docs.bigmodel.cn', 'platform.moonshot.cn',
      'docs.siliconflow.cn',
    ]).has(url.hostname);
  } catch { return false; }
}

function defaultDataDir(platform, env, homeDir) {
  if (env.QQ_DASHBOARD_DATA_DIR) return path.resolve(env.QQ_DASHBOARD_DATA_DIR);
  return platform === 'win32'
    ? path.join(env.LOCALAPPDATA || path.join(homeDir, 'AppData', 'Local'), 'QQBridgeDashboard')
    : path.join(homeDir, '.local', 'share', 'qq-bridge-dashboard');
}

module.exports = {
  validPort, backendUrlForPort, parseBackendReady,
  isDashboardResource, isDashboardNavigation, isAllowedExternalUrl, defaultDataDir,
  isAccountProfileId, configExportPath, isDashboardIpcSender,
};
