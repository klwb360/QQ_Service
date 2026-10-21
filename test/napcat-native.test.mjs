import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { validateNativeExecutablePath, nativeNapcatInvocation, nativeNapcatStatus, openNativeNapcat } from '../src/napcat-native.mjs';
import { createInstaller } from '../src/installer.mjs';

const file = 'C:\\工具 & 应用!\\NapCat\\napcat.cmd';
const windows = { platform: 'win32', env: { SystemRoot: 'C:\\Windows' }, stat: () => ({ isFile: () => true }) };

test('本地启动只接受明确的 Windows 文件路径，不接受命令、共享路径或批处理变量扩展', () => {
  assert.equal(validateNativeExecutablePath(file), file);
  assert.equal(validateNativeExecutablePath(''), '');
  for (const value of ['napcat.cmd', '\\\\server\\share\\napcat.cmd', 'C:\\x.exe & whoami', 'C:\\x.exe:stream', 'C:\\%TEMP%\\napcat.cmd', 'C:\\x.ps1', 'C:\\x\n.cmd', 'C:\\x".exe', 'C:\\folder.\\x.exe', null]) assert.throws(() => validateNativeExecutablePath(value));
});

test('批处理保持固定 argv、关闭命令扩展入口；启动器不继承模型密钥与 Node 注入选项', () => {
  const invocation = nativeNapcatInvocation(file, { ...windows, env: { ...windows.env, PATH: 'safe', HTTPS_PROXY: 'http://proxy:8080', NODE_EXTRA_CA_CERTS: 'ca.pem', OPENAI_API_KEY: 'private-key', DEEPSEEK_API_KEY: 'private-ds', NODE_OPTIONS: '--require bad.cjs', CODEX_HOME: 'private-auth' } });
  assert.equal(invocation.command, 'C:\\Windows\\System32\\cmd.exe');
  assert.deepEqual(invocation.args, ['/d', '/v:off', '/s', '/c', `""${file}""`]);
  assert.equal(invocation.options.shell, false);
  assert.equal(invocation.options.windowsVerbatimArguments, true);
  assert.equal(invocation.options.env.HTTPS_PROXY, 'http://proxy:8080');
  assert.equal(invocation.options.env.NODE_EXTRA_CA_CERTS, 'ca.pem');
  for (const key of ['OPENAI_API_KEY', 'DEEPSEEK_API_KEY', 'NODE_OPTIONS', 'CODEX_HOME']) assert.equal(invocation.options.env[key], undefined);
  const exe = nativeNapcatInvocation('C:\\Apps\\NapCat.exe', windows);
  assert.equal(exe.command, 'C:\\Apps\\NapCat.exe'); assert.deepEqual(exe.args, []);
  assert.equal(exe.options.windowsVerbatimArguments, undefined);
});

test('文件不存在、非文件、非 Windows 均不会启动；状态不伪造运行或登录成功', () => {
  assert.throws(() => nativeNapcatInvocation(file, { ...windows, stat: () => { throw Object.assign(new Error(), { code: 'ENOENT' }); } }), /找不到/);
  assert.throws(() => nativeNapcatInvocation(file, { ...windows, stat: () => ({ isFile: () => false }) }), /不是文件/);
  assert.throws(() => nativeNapcatInvocation(file, { platform: 'linux' }), /Windows/);
  const status = nativeNapcatStatus({ executablePath: file }, windows);
  assert.equal(status.state, 'configured'); assert.equal(status.managed, false); assert.equal(status.running, undefined);
});

test('启动报告即时失败；创建进程仅表示已打开，登录仍待连接验证', async () => {
  let spawned = 0;
  const spawnProcess = () => {
    spawned++;
    const child = new EventEmitter(); child.unref = () => {};
    queueMicrotask(() => child.emit('spawn'));
    return child;
  };
  const result = await openNativeNapcat(file, { ...windows, spawnProcess, settleMilliseconds: 1 });
  assert.equal(result.opened, true); assert.equal(result.running, undefined); assert.equal(result.connected, undefined);
  assert.equal(spawned, 1);
  await assert.rejects(openNativeNapcat(file, { ...windows, spawnProcess: () => { const child = new EventEmitter(); child.unref = () => {}; queueMicrotask(() => child.emit('error', { code: 'ENOENT' })); return child; } }), /找不到/);
  await assert.rejects(openNativeNapcat(file, { ...windows, spawnProcess: () => { const child = new EventEmitter(); child.unref = () => {}; queueMicrotask(() => { child.emit('spawn'); child.emit('exit', 1); }); return child; } }), /已退出/);
});

test('Windows 实际打开含中文、空格和符号的 .cmd/.bat，不执行路径中的命令字符', { skip: process.platform !== 'win32' }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-native & 中文! '));
  try {
    for (const extension of ['cmd', 'bat']) {
      const marker = path.join(directory, `${extension}-opened.txt`);
      const launch = path.join(directory, `NapCat & 测试!.${extension}`);
      // ASCII script content avoids depending on the Windows console codepage;
      // the launch path itself still exercises Unicode and shell characters.
      fs.writeFileSync(launch, `@echo off\r\n> "%~dp0${extension}-opened.txt" echo opened\r\nexit /b 0\r\n`);
      const result = await openNativeNapcat(launch);
      assert.equal(result.opened, true);
      const stop = Date.now() + 3000;
      while (!fs.existsSync(marker) && Date.now() < stop) await new Promise(resolve => setTimeout(resolve, 20));
      assert.equal(fs.readFileSync(marker, 'utf8').trim(), 'opened');
    }
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('本地方式忽略已有 Docker 记录与旧 WebUI Token，安装、启动、停止均不调用 Docker', { skip: process.platform === 'win32' }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-native-installer-'));
  const originalPath = process.env.PATH;
  const bin = path.join(directory, 'bin'), marker = path.join(directory, 'docker-called');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'docker'), `#!/bin/sh\nprintf called > '${marker}'\nexit 1\n`, { mode: 0o700 });
  fs.writeFileSync(path.join(directory, 'module-state.json'), JSON.stringify({ schemaVersion: 1, modules: { napcat: { installed: true, imageDigest: 'legacy-digest' } } }));
  fs.mkdirSync(path.join(directory, 'modules/napcat/config'), { recursive: true });
  fs.writeFileSync(path.join(directory, 'modules/napcat/config/webui.json'), JSON.stringify({ token: 'old-docker-secret' }));
  process.env.PATH = `${bin}${path.delimiter}${originalPath}`;
  const installer = createInstaller({ dataDir: directory, getConfig: () => ({ qq: { webUiUrl: 'http://127.0.0.1:6101' } }), getNapcatSettings: () => ({ mode: 'native', executablePath: '' }), getSecret: () => '', setSecret: () => {} });
  try {
    const modules = await installer.status();
    assert.equal(modules.find(module => module.id === 'napcat').kind, 'native');
    assert.equal(modules.find(module => module.id === 'napcat').state, 'not_configured');
    const guide = await installer.napcatGuide();
    assert.equal(guide.initialWebUiToken, ''); assert.equal(guide.url, 'http://127.0.0.1:6101');
    const environment = await installer.environment();
    assert.equal(environment.docker, undefined); assert.equal(environment.wsl, undefined); assert.equal(environment.dockerInstallUrl, undefined);
    await assert.rejects(installer.install('napcat'), /本地安装/);
    await assert.rejects(installer.startNapcat(), /Windows/);
    await assert.rejects(installer.stopNapcat(), /本地 NapCat/);
    assert.equal(fs.existsSync(marker), false);
    assert.equal(JSON.parse(fs.readFileSync(path.join(directory, 'module-state.json'))).modules.napcat.imageDigest, 'legacy-digest');
  } finally { await installer.dispose(); process.env.PATH = originalPath; fs.rmSync(directory, { recursive: true, force: true }); }
});
