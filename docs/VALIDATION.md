# 验证记录

[返回首页](../README.md) · [使用指南](USAGE.md) · [开发指南](DEVELOPMENT.md)

## 0.3.0 · 多账号控制与显式授权

验证日期：2026-10-15。界面、协议模拟及桌面检查使用临时数据和合成 QQ 号，没有登录真实 QQ、DeepSeek 或 ChatGPT 账号，没有调用付费模型。

- Linux `npm test`：55 项通过，0 项失败；1 项可选 GUI 检查在普通测试发现中跳过，另行执行。
- `npm run check` 通过，包含新增账号目录、独立账号服务和桌面代码的语法检查。
- 两路实际 WebSocket 模拟 OneBot 同时连接，验证同群同消息 ID、收藏、历史、模型密钥和 Codex 目录不混用。撤销一个账号的权限不影响另一个账号。
- 新建账号、填写模型凭据及模型登录不授予权限；普通应用及回滚恢复只读。最终授权核验实际 QQ 身份、保存版本和选定范围；配置变化或推理中撤权不能继续发信。
- 实际定时器检查：未释放时零自动模型调用；释放只读群后可定时整理并只保存本地，零 QQ 发送且每日去重。
- 并发事务回归：回滚前保留新旧 QQ/端口资源，其他不冲突账号仍可并行配置；退出期间不会重启后台，延迟到达的请求正文不能创建新账号。
- Chromium 配合实际后台完成账号创建、两个场景子菜单、读取已加入群、授权/撤销、跨账号输入和凭据隔离、轮询保留输入，以及延迟保存响应后切账号和继续编辑的检查，无未捕获 JavaScript 错误。
- 9 项真实 Electron 44.7.0 桌面检查通过：双账号独立配置与默认只读、各自原生导出、空账号菜单不自动建档、原生菜单按当前账号导出、单实例、托盘、完全退出释放后台和端口、重启保留双账号配置及凭据。
- 页面外层滚动条已隐藏，Chromium 实际滚轮和 PageDown 可继续滚动；窄窗口中的表格横滚与日志独立纵滚均正常，仓库截图已同步。
- Linux 交叉构建生成 Windows x64 EXE，包内 Node.js 24.19.0、npm、ws、后台与桌面 ASAR 校验通过。最终发布由 [Windows application](https://github.com/klwb360/QQ_Service/actions/workflows/windows.yml) 的版本标签流程执行自动测试、构建、SHA256 和 Release 上传；以 [v0.3.0 Release](https://github.com/klwb360/QQ_Service/releases/tag/v0.3.0) 的实际资产为准。

真实 Windows 桌面操作、多个实际 QQ 账号、Docker Desktop/原生 NapCat 登录、Codex 官方设备授权及真实模型调用仍待实机验收。微信与 Telegram 仅保留平台扩展入口，尚未实现。

## Windows 原生 NapCat 接入检查

2026-10-14 核对 [官方 Shell 安装文档](https://napneko.github.io/guide/boot/Shell)，下载 `v4.18.38 / NapCat.Shell.Windows.OneKey.zip` 并验证其 GitHub 声明的 SHA256；确认包内的 `NapCatInstaller.exe` 和启动组件。原生安装与连接步骤见 [指南](NATIVE_NAPCAT_WINDOWS.md)。

现有后台使用临时数据目录和本地模拟 OneBot 完成配置应用、Bearer Token 鉴权及登录账号校验，不安装或启动 Docker 版 NapCat，也未调用真实模型。没有修改运行代码或更换 v0.2.1 EXE；Windows 原生安装器执行和真实 QQ 登录仍待实机验证。

## 0.2.1 · QQ_Service 发布校验

项目名称、窗口标题、界面、导出文件名和 Windows 构建产品名已改为 `QQ_Service`。旧数据目录和桌面单实例身份保留，继续兼容 0.2.0。

重命名后重新执行 `npm test`：20 项通过，0 项失败；可选 GUI 脚本在普通测试发现中显式跳过。`npm run check` 通过。下方 7 项真实桌面交互记录来自 0.2.0，0.2.1 未声称新增 Windows 实机测试。

GitHub Actions 在 Windows runner 上执行语法检查、自动测试与 EXE 构建，标签须匹配 package 版本，构建检查缺失资源会失败；正式标签构建成功后上传 EXE 及 SHA256 到 Release。第三方 Actions 固定到上游已核实的提交 SHA。

2026-10-11，正式标签 [`v0.2.1` 的 Windows 构建与发布](https://github.com/klwb360/QQ_Service/actions/runs/38160669306) 全部成功，[Release](https://github.com/klwb360/QQ_Service/releases/tag/v0.2.1) 已包含 EXE 和 SHA256 校验文件。重新下载公开 EXE 后核验通过：

```text
文件：QQ_Service-0.2.1-Windows-x64.exe
大小：123346581 字节
SHA256：cf64162833c1e0f348568b04c3ae19e247179d813eed657c8fba9cb633c1c86d
```

Windows 打包时 ASAR 路径分隔符的差异已修复，打包校验统一路径后检查桌面入口。该 Release 的 Windows 自动构建与后台测试已完成；Windows 桌面实机操作和真实账号联调仍未完成。

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

v0.2.0 在 Linux 环境构建 Windows x64 便携 EXE，自带官方 Node.js 24.19.0 与 npm。v0.2.1 的正式 EXE 改由 GitHub Actions Windows runner 构建，并执行自动测试和包内资源检查。构建检查 Windows PE、桌面 ASAR、实际附带的后台与 npm/ws 依赖；这些检查不等于用户在 Windows 桌面上完成应用操作与账号验收。

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
