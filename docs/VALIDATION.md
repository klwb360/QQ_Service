# 验证记录

## 0.2.1 · QQ_Service 发布校验

项目名称、窗口标题、界面、导出文件名和 Windows 构建产品名已改为 `QQ_Service`。旧数据目录和桌面单实例身份保留，继续兼容 0.2.0。

重命名后重新执行 `npm test`：20 项通过，0 项失败；可选 GUI 脚本在普通测试发现中显式跳过。`npm run check` 通过。下方 7 项真实桌面交互记录来自 0.2.0，0.2.1 未声称新增 Windows 实机测试。

GitHub Actions 在 Windows runner 上执行语法检查、自动测试与 EXE 构建，标签须匹配 package 版本，构建检查缺失资源会失败；正式标签构建成功后上传 EXE 及 SHA256 到 Release。第三方 Actions 固定到上游已核实的提交 SHA。

## 0.2.0 · 桌面功能验证

验证日期：2026-10-11。构建与自动验证在 Linux 云环境进行，未登录真实 QQ、DeepSeek 或 ChatGPT 账号，未调用付费模型或发送 QQ 消息。

## 已完成

- `npm test`：20 项通过，0 项失败；可选 GUI 脚本在普通测试发现中显式跳过，并单独运行验证。
- `npm run check` 与构建、GUI 脚本语法检查通过。
- 7 项真实 Electron 44.7.0 交互检查：独立窗口及本机随机端口、保存并应用配置、原生导出 IPC、关闭窗口后后台继续运行、第二实例唤起已有窗口、完全退出释放后台和端口、重启保留配置及凭据状态。仅将保存对话框选址替换为临时路径；后台和页面均实际运行。
- 后台 IPC 就绪、主动退出、父连接断开、正在执行的真实子进程树退出均有自动验证。模拟 QQ 与模型测试覆盖工作群只读、GPT 本人权限、私密上下文隔离、收藏账号来源及失败回滚。
- 从实际 Windows 包的 `resources/backend` 目录使用主机 Node 启动后台：SQLite、本机 HTTP、页面资源、独立 `ws@8.22.0` 解析、包内 `npm@11.17.0` 环境检查及 IPC 退出通过。未使用源码目录的依赖替代包内依赖。

图形验证使用 Xorg dummy 显示服务及云环境专用 `--no-sandbox --disable-gpu` 参数。窗口的 Node integration 关闭，context isolation 和 sandbox 配置启用；此检查验证应用逻辑，不证明操作系统沙箱有效。

## Windows 交付边界

本次交付 Windows x64 便携 EXE，自带官方 Node.js 24.19.0 与 npm，不要求用户另装 Node。构建检查 Windows PE、桌面 ASAR、实际附带的后台与 npm/ws 依赖；这些检查不等于在 Windows 上执行。

打包工具默认省略资源源目录根部的 `node_modules`，已用显式资源映射修复，并加入 `afterPack` 校验钩子：缺少 npm 或后台生产依赖时构建失败。本次产物也单独执行该校验通过。

Windows EXE 启动、托盘系统交互、`taskkill` 进程树退出、Docker Desktop 挂载、QQ 扫码、Codex 设备码授权及真实模型权限需要 Windows 实机验收。EXE 尚无代码签名证书。

## 重复验证

```bash
npm ci
npm test
npm run check
npm run build:exe
```

单独图形检查需可用显示服务及可选 Playwright：

```bash
PLAYWRIGHT_MODULE_PATH=/absolute/path/to/playwright DISPLAY=:97 node test/desktop-qa.cjs
```

图形脚本只使用临时资料目录、假测试凭据，保持 QQ 和模型关闭；结束后清理本次后台和资料。
