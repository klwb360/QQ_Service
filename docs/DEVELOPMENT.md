# 开发与发布

[返回首页](../README.md) · [功能实现与架构](ARCHITECTURE.md) · [接口契约](CONTRACT.md) · [验证记录](VALIDATION.md)

## 源码运行

需要 Node.js 24。前端为原生 HTML/CSS/JavaScript，后台使用 Node HTTP、`node:sqlite` 和 `ws`，无需额外前端构建服务。

```bash
git clone https://github.com/klwb360/QQ_Service.git
cd QQ_Service
npm ci --ignore-scripts
npm start
```

打开 `http://127.0.0.1:3210`。Windows 源码入口 `start.cmd` / PowerShell 仍固定使用 3210。

调试 v0.4.0 时使用独立数据目录，避免把真实旧版资料作为测试夹具。新建账号可同时运行；所有请求明确带 profile ID，界面当前选择不是后端执行目标。

## 检查与测试

```bash
npm run check
npm test
```

常规测试使用模拟 OneBot/模型，无需真实登录或额度。应覆盖新账号零发送、显式释放/撤销、普通应用和回滚回只读、群读取/发送交集、工作群默认只读及明确授权、个人 Codex 范围、账号和上下文隔离、独立收藏模型、多 API 路由/密钥隔离、可定位校验错误、真实步骤诊断、受控 QQ 测试消息、配置迁移、凭据导出与后台生命周期。

自动结果和可选 Electron 交互检查见 [验证记录](VALIDATION.md)。模拟两个账号不能代替真实 QQ 多开、Windows 托盘或 Docker Desktop 挂载验收。

## 账号与 API 开发

每账号使用 schema 2 配置，完整接口见 [CONTRACT.md](CONTRACT.md)。`src/accounts.mjs` 管理目录和平台清单，`src/account-service.mjs` 管理账号事务，`src/server.mjs` 协调 HTTP 与隔离。新增操作应放在 `/api/accounts/:id/`，捕获稳定 profile ID，并在发送时再次校验当前 epoch、场景与目标权限。新平台不能借用当前 QQ 的身份或发送通道。

普通配置保存不能伪造 `permissions.released:true`；应用与回滚恢复只读，显式 `/permissions/release` 校验保存 revision 后才授权。自动聊天和定时推理都需释放，不能因保存模型或定时参数自动开始；仪表盘明确发起的手动本地整理仍可执行。撤销立即阻止后续发送和自动任务。新增任务的错误分支也必须走统一发送门。引导最终“启动此账号”复用释放事务，不得另开授权通道。QQ 验证消息使用固定文本、实际目标和同一发送门，不能为了测试临时放宽权限。

新账号使用独立目录和登录状态。旧版兼容 profile 保持原数据路径，启动时幂等迁移配置并保留备份；不要在升级脚本里重置凭据、搬移正在绑定的 Docker 目录或拷贝 CLI 会话到新账号。

API 扩展写入 `models.apis`，保留稳定 ID，密钥使用独立 `apiKey:<id>`；聊天、通知和收藏用 provider ID 绑定。新增服务预设只提供参数，不代表已通过真实服务商联调。不得在失败后自动换用其他 Key、服务商或计费通道。

引导状态由 `/setup/status` 和账号 `/state.setup` 提供，区别配置就绪、连接身份、模型测试与实际送达。校验错误保留兼容文本并提供字段路径、原因和修正动作。纯群/本地用途不能被可选私聊接收 QQ 阻塞。

微信与 Telegram 目前只存在于规划的平台注册信息中，创建接口应拒绝尚未实现的平台，不应展示为已接入。

## 桌面开发与 Windows 打包

在 Windows 上：

```bash
npm ci
npm run prepare:windows
npm run desktop
```

生成便携应用：

```bash
npm run build:exe
```

本版目标为 `dist/QQ_Service-0.4.0-Windows-x64.exe`。`npm run build:installer` 提供可选 NSIS 目标，默认 Release 交付便携 EXE。

窗口为无原生边框 Electron 窗口，最小化、最大化/还原、关闭通过受限预加载接口操作。关闭偏好是桌面全局设置，默认进入托盘，可选完全退出；系统关闭和自绘关闭行为应一致。实际窗口控制和设置持久化需用 Electron 检查，不能只测 DOM 按钮存在。

构建脚本下载固定官方 Node.js Windows ZIP 并校验固定 SHA-256。桌面壳在 ASAR，生产后台和 Node/npm 位于独立 resources；不包含 `accounts.json`、配置、凭据或历史。打包后检查 x64 PE、ASAR、Node/npm、后台/UI、ws 依赖及版本，资源不完整时失败。

| 依赖 | 固定版本 |
| --- | --- |
| Node.js Windows 运行时 | 24.19.0 |
| Electron | 44.7.0 |
| electron-builder | 26.15.3 |
| ws | 8.22.0 |
| NapCat Docker 外部模块 | v4.18.37，首次安装记录 RepoDigest |
| Codex CLI 外部模块 | 0.149.1 |

若先执行了 `npm ci --ignore-scripts`，桌面运行前还需 `node node_modules/electron/install.js` 下载开发运行环境。

## 环境变量

| 变量 | 用途 |
| --- | --- |
| `QQ_DASHBOARD_DATA_DIR` | 覆盖用户数据根目录；测试建议独立临时目录 |
| `QQ_DASHBOARD_PORT` | 浏览器源码模式端口，默认 3210 |
| `QQBRIDGE_NODE_RUNTIME` | 未打包桌面模式使用的 Node 24 绝对路径 |
| `QQ_DASHBOARD_NPM_CLI` | 未打包开发模式使用的 npm CLI 绝对路径 |

EXE 使用附带运行时和随机空闲后台端口。Linux 桌面调试需通过后两个变量提供运行时并准备显示服务，不能替代 Windows 实机验收。

## GitHub Actions 与 Release

[Windows application](https://github.com/klwb360/QQ_Service/actions/workflows/windows.yml) 在推送 `main`、PR 或手动触发时执行依赖安装、语法检查、测试、Windows x64 EXE 构建与 SHA256 生成。

`v*` 标签必须与 `package.json` 版本一致。Windows 构建成功后，独立发布任务创建 Release 并上传 EXE/校验文件。Actions 固定提交 SHA，本地构建使用 `--publish never`。普通文档提交不会替换已发布 EXE。

发布 v0.4.0 时同步 package/lock 版本、界面、README 下载链接和实际验证记录，再创建匹配标签。公开资产需检查下载与 SHA256；不要把旧版本构建成功或模拟协议测试写成本版真实账号联调成功。

外部原生 NapCat 按上游流程单独部署；项目安装按钮仍使用 Docker，不应在文档或界面宣称已经实现原生一键安装。
