# QQ_Service

[下载 Windows EXE](https://github.com/klwb360/QQ_Service/releases/latest) · [架构与扩展](docs/ARCHITECTURE.md) · [验证记录](docs/VALIDATION.md)

Windows 本地 QQ 助手。通过仪表盘安装 QQ 接入模块、登录模型、设置社交群与只读工作群，并把通知汇总发送到本人私聊。使用 Electron 独立窗口，自带 Node.js 和 npm，通过 EXE 启动、托盘继续运行。

界面、安装管理与消息后台均已实现。自动测试和 Linux 桌面交互检查通过；Windows 实机与真实 QQ、DeepSeek、ChatGPT 账号联调尚未完成。

## Windows 开始使用

1. 从 [Releases](https://github.com/klwb360/QQ_Service/releases/latest) 下载 `QQ_Service-0.2.1-Windows-x64.exe`，放在普通文件夹，例如 `D:\Apps\QQ_Service`，双击打开。适用于 Windows 10/11 x64。无需另装 Node.js、运行脚本或打开浏览器；便携 EXE 会自动展开附带运行环境。首次打开可能较慢。
2. 在应用中配置功能。要接入 QQ，还需安装并启动 [Docker Desktop](https://docs.docker.com/desktop/setup/install/windows-install/)，使用 Linux 容器后端。首次启用 WSL 2 可能需要管理员操作和重启；面板可以检查状态，不能替你完成 BIOS 设置。
3. 窗口右上角关闭按钮会把应用收进托盘，继续收集消息和执行定时汇总；右键托盘图标或「应用」菜单选择 **完全退出** 才会停止后台。若系统无法创建托盘，关闭窗口会完全退出。重复双击 EXE 会打开已有窗口。
4. 在「总览」点击 **一键安装所选模块**。NapCat 用于 QQ；Codex CLI 用于你的 GPT 订阅，可按需要取消勾选。安装进度与失败原因在「模块管理」显示。
5. 在「账号与模型」点击 **打开 QQ 登录页面**，按提示登录 NapCat WebUI，再用手机扫码登录机器人小号。填写本人 QQ 号和机器人 QQ 号，两者应不同。
6. 填入 DeepSeek API Key，启用所需模型。使用 GPT 订阅时，点击 **启动官方设备码授权**，在 OpenAI 官方页面登录自己的 ChatGPT 账号。地址与设备码见授权任务输出；不需要复制账号 token。
7. 在「场景与权限」添加群号，选择社交群或工作群，设置汇总时间、模型与保留期限。点击 **保存并应用**。

应用需要保持运行，可以隐藏到托盘。完全退出会停止仪表盘、消息处理和定时任务；已启动的 NapCat Docker 容器会继续运行，可以先在面板中停止它。电脑休眠、关机或应用完全退出时不采集新消息，也不补跑错过的定时任务。

EXE 已附带应用运行环境。首次安装 QQ/GPT 模块需要访问 npm、Docker Hub 与相关服务。网络或平台权限失败会显示真实错误，不会切换到来路不明的镜像源。安装模块与完成账号登录是两个独立状态。当前 EXE 未使用代码签名证书；Windows 可能显示发布者未知或 SmartScreen 提示。

## 这一版可以做什么

| 功能 | 实际实现 |
| --- | --- |
| 桌面运行 | 独立窗口、单实例、托盘后台运行、原生配置保存对话框；应用管理自带后台的启动与退出 |
| 一键安装 | 官方 NapCat Docker 镜像与官方 Codex npm 包；检查环境、下载、记录版本、启动 NapCat |
| 统一配置 | 本地表单、结构校验、保存草稿、应用、上一份配置回滚、无凭据导出 |
| 社交群聊天 | DeepSeek API；按 @、命令前缀或概率插话触发，带上下文数量和冷却时间 |
| 工作群只读 | 仅采集选定工作群；统一发送入口拒绝向工作群及未选群发消息 |
| 通知汇总 | 手动或每日定时；解释通知、行动项与原文期限，保留消息 ID、时间和原文依据 |
| GPT 个人订阅 | 官方 Codex CLI 登录及推理；只接受本人私聊或本人请求/明确授权的汇总 |
| QQ 收藏 | 读取当前登录账号的收藏列表与接口摘要；本人可点击整理、解释，并核对收藏 ID 与原摘要 |
| 运行记录 | QQ 登录身份验证、队列/连接状态、安装授权输出、汇总送达状态与错误 |

本人私聊机器人小号可以发送：

```text
/gpt 帮我解释这段通知：……
/ds 帮我整理这段文字：……
/summary 选定工作群号
/favorites
```

本人私聊普通文字使用 DeepSeek。社交群始终使用 DeepSeek，即使群消息包含 `/gpt` 也不会触发订阅。工作群中的消息仅作为汇总资料，不会逐条触发 GPT。定时汇总必须勾选本人授权，按**运行电脑的本地时间**执行，每群每天去重。

收藏整理使用「通知汇总」中的模型选择与私聊发送设置，可独立于工作群汇总开关使用。请先点击读取收藏，再整理当前账号已缓存的列表摘要；模型无法据此看到收藏全文或附件。

## 安装与数据

- NapCat 首版指定 `mlikiowa/napcat-docker:v4.18.37`；首次拉取成功后记录仓库 SHA-256 摘要，以后按该摘要启动。标签是否可下载仍取决于上游仓库；失败时不会标记安装成功。
- Codex CLI 固定为 `@openai/codex@0.149.1`，安装在本项目的数据目录，不修改全局 npm 安装。
- Windows 数据默认在 `%LOCALAPPDATA%\QQBridgeDashboard`，包含配置、SQLite 历史、NapCat 持久目录和独立 `codex-home`。
- 数据不写入 EXE 所在文件夹，也不放进便携程序的临时展开目录；移动或替换 EXE 后保留原数据。旧版脚本启动的数据目录相同，可沿用已有配置。菜单可打开资料目录；需要完整备份时先完全退出，再复制该目录。
- DeepSeek/OneBot 凭据通过 AES-GCM 保存，密钥在同一个本地用户数据目录。这用于避免明文写入配置和导出，**不构成对能够访问该目录的本机用户的隔离**。
- Codex 的登录凭据由官方 CLI 管理；仪表盘不读取其 `auth.json`。
- 只监听 `127.0.0.1`，请求校验 Host、Origin 与页面会话 token。第一版用于单个本机用户，请不要直接暴露到公网。
- 原始群消息和汇总依据保存在本地，按配置的保留天数清理。配置导出不包含密钥、收藏或聊天历史。

## 已知范围

小号只能接收自身加入的群消息，也只能读取小号自己的「我的收藏」。主号收藏不会自动共享。第一版不承诺收藏全文、图片、文件下载或完整分页，也不回填全部历史群消息。非文字消息会标记为未解析。

ChatGPT 订阅通道使用 Codex 当前可用模型和额度，不会继承 ChatGPT 网页历史、记忆或自定义 GPTs；额度不足时任务失败，不会自动转向付费 API。个人订阅不能用于满足其他用户的请求，见 [Sign in with ChatGPT 条款](https://openai.com/policies/sign-in-with-chatgpt-terms/)。

Codex 使用专用工作目录、只读沙箱、不加载用户规则，并关闭多项工具功能；这不是一个能证明所有本机读取能力都已消除的独立隔离环境。第一版用于文字处理，检测到工具执行事件时拒绝任务结果。官方原生认证说明见 [Codex Auth](https://developers.openai.com/codex/auth/)。

QQ 发送请求超时或部分分片已发送时，记录显示「送达状态未确定」或「部分已发送」，不会自动无限重发。配置回滚无法撤回已经发出的 QQ 消息；回滚普通配置不会回退已经更改的凭据。

NapCat 使用个人账号接入，可能受 QQ 更新、掉线和账号风控影响，见 [官方说明](https://napneko.github.io/other/security)。其 [许可证](https://github.com/NapNeko/NapCatQQ/blob/main/LICENSE) 对商业用途与分发有限制。本项目引用官方镜像，未捆绑或修改 NapCat；计划商业发布前需要解决相应授权。

## 开发与验证

开发需要 Node.js 24。源码仍可单独启动本地浏览器界面：

```bash
npm ci --ignore-scripts
npm start
npm test
npm run check
```

生成 Windows EXE：

```bash
npm ci
npm run build:exe
```

产物在 `dist/QQ_Service-0.2.1-Windows-x64.exe`。构建脚本从 Node.js 官方网站下载固定版本 24.19.0，校验固定 SHA-256，并只打包后台的生产依赖。Electron 固定为 44.7.0，electron-builder 固定为 26.15.3。`npm run build:installer` 是可选的 NSIS 安装包构建目标；本次交付的是便携 EXE。

Windows 开发桌面窗口可先运行 `npm run prepare:windows`，再 `npm run desktop`。Linux 桌面开发需通过 `QQBRIDGE_NODE_RUNTIME` 指定本机 Node.js 24 的绝对路径，通过 `QQ_DASHBOARD_NPM_CLI` 指定其 npm CLI 的绝对路径；这两个覆盖仅影响未打包运行。使用 `npm ci --ignore-scripts` 时需要另运行 `node node_modules/electron/install.js` 下载 Electron 开发运行环境。

可设置 `QQ_DASHBOARD_DATA_DIR` 更改数据目录。桌面应用使用随机空闲本机端口；浏览器开发模式可通过 `QQ_DASHBOARD_PORT` 更改端口。旧 `start.cmd` / PowerShell 入口保留供源码运行，固定打开 3210。首版只管理本机 Docker daemon，不跟随远程 Docker context。

自动测试覆盖配置、凭据应用、HTTP 会话保护、失败回滚、模拟 OneBot 收发、上下文隔离、模型错误与账号收藏来源，并新增桌面 URL 边界、后台 IPC 就绪/退出与数据重启检查。真实后台配合 Chromium 的浏览器检查通过，包括一键应用、轮询保留输入、配置下载和移动端布局。桌面版 20 项自动测试与 7 项真实 Electron 交互检查通过，详见 [验证记录](docs/VALIDATION.md)；这些检查不替代 Windows 实机及真实账号联调。

官方 Codex `0.149.1` 在临时 Linux 目录中的真实安装、原生版本与执行参数检查通过。NapCat `v4.18.37` 的 DockerHub 标签及 Linux amd64/arm64 架构已核实；尚未拉取或运行镜像。没有登录真实账号、发送 QQ 消息或消耗订阅/API 额度。这些检查不替代 Windows 及真实账号联调。

源码分工和后续扩展见 [架构说明](docs/ARCHITECTURE.md)。

项目自身代码采用 MIT 许可证。随 EXE 分发的 Electron、Chromium、Node.js、npm 和 ws 保留各自许可证，见 [第三方声明](THIRD_PARTY_NOTICES.md)。
