# QQ_Service

**在自己的 Windows 电脑上，按步骤连接 QQ，配置多个 AI 和个人 GPT 订阅。**

[![Windows build](https://github.com/klwb360/QQ_Service/actions/workflows/windows.yml/badge.svg?branch=main)](https://github.com/klwb360/QQ_Service/actions/workflows/windows.yml)
[![Release](https://img.shields.io/github/v/release/klwb360/QQ_Service)](https://github.com/klwb360/QQ_Service/releases/latest)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

[下载 Windows EXE](https://github.com/klwb360/QQ_Service/releases/latest) · [使用指南](docs/USAGE.md) · [无需 Docker 接入 QQ](docs/NATIVE_NAPCAT_WINDOWS.md) · [功能实现与架构](docs/ARCHITECTURE.md) · [开发指南](docs/DEVELOPMENT.md) · [验证记录](docs/VALIDATION.md)

QQ_Service 是支持多个 QQ 账号同时在线的本地助手。「账号控制」集中管理创建与配置：每个账号是一条可展开的菜单，从账号信息开始逐段向下完成模型、QQ 登录、功能与权限配置，已填写的内容保留在上方。总览只显示关键统计、运行状态和最近任务，统计卡片可点击进入对应页面。支持 DeepSeek、多组 OpenAI 兼容 API，以及通过官方 Codex CLI 使用本人 ChatGPT 订阅。**新账号默认只读；填入 QQ 号、API Key 或登录 Codex 都不会自动运行场景或获得发送权限。**

![QQ_Service 展开账号后的连续配置面板](docs/assets/account-control.png)

<details>
<summary>查看简化后的总览</summary>

![QQ_Service 关键统计、运行状态与最近任务](docs/assets/overview-simplified.png)

</details>

<details>
<summary>首次使用：只有创建账号入口</summary>

![QQ_Service 首次创建账号](docs/assets/account-empty.png)

</details>

<details>
<summary>查看 QQ 连接步骤</summary>

![QQ_Service QQ 连接引导](docs/assets/account-connection-guide.png)

</details>

<details>
<summary>查看「选定群与消息权限」界面</summary>

![QQ_Service 群与消息权限](docs/assets/account-permissions.png)

</details>

*界面截图不包含真实账号、凭据或群消息。Windows EXE 提供独立窗口与托盘。*

## 下载与快速开始

稳定下载：**v0.4.1**，适用于 **Windows 10/11 x64**。以下界面说明对应当前源码分支；下载文件以对应 Release 的实际发布资产为准。

| 下载 | 说明 |
| --- | --- |
| [QQ_Service-0.4.1-Windows-x64.exe](https://github.com/klwb360/QQ_Service/releases/download/v0.4.1/QQ_Service-0.4.1-Windows-x64.exe) | 便携应用，自带 Node.js 和 npm，双击启动 |
| [SHA256 校验文件](https://github.com/klwb360/QQ_Service/releases/download/v0.4.1/QQ_Service-0.4.1-Windows-x64.exe.sha256) | 用于核对下载文件 |
| [最新发布与更新说明](https://github.com/klwb360/QQ_Service/releases/latest) | 查看已发布版本和更新记录 |

1. **创建账号配置**：创建入口只在「账号控制」显示。输入希望接入的 QQ 号，可同时选择 API Key 和 ChatGPT 订阅。每个账号的栏头与展开内容连为同一菜单，可点击栏头展开或收起，参数与数据分别保存，多个账号可以同时运行。完成一部分并继续后，下一部分带动画向下展开，之前的表单保持可见，无需切换顶部步骤标签。
2. **准备模型**：填写 DeepSeek Key，按需添加多组兼容 API 的名称、地址、模型和 Key；或安装 Codex CLI 并完成官方 ChatGPT 授权。为聊天、通知和收藏分别选择模型，多模型可在同一账号使用。
3. **实际登录 QQ**：NapCat 是 QQ 登录与消息接口组件。按 [Windows 原生指南](docs/NATIVE_NAPCAT_WINDOWS.md) 部署并扫码登录，无需 Docker；已有 Docker 的用户也可使用应用内安装。填入 QQ 号不是登录，连接检查必须显示实际登录身份一致。
4. **选择账号功能**：按需启用聊天回复、工作通知汇总或收藏整理，设置触发方式、模型和计划。暂不使用的功能可以关闭。
5. **选择群并启动**：到「选定群与消息权限」读取实际已加入群，明确读取、发送范围，确认后点击 **启动此账号**，显式授予已配置权限。只在面板看通知无需另一个 QQ 号，也不需要私聊发送权限。
6. **验证一次完整流程**：先确认 QQ 连接和身份，再检查模型；让选定群产生一条新消息，确认记录，最后按授权范围测试汇总或回复。面板将缺少的参数、连接或授权列为待办，见 [首次连接验证](docs/USAGE.md#6-验证一次完整流程)。

EXE 当前未签名。详细操作、私聊命令与备份见 [使用指南](docs/USAGE.md)。

## 功能与实现

| 功能 | 目前如何实现 |
| --- | --- |
| 多账号控制 | 本地账号目录保存稳定 ID；每账号独立配置、凭据、SQLite、QQ 连接、任务队列和 Codex 登录目录 |
| 权限配置 | 账号功能参数与群/私聊权限分开；默认只读，独立释放/撤销入口，自动场景和发送由后台分别核对 |
| Windows 应用 | Electron 自绘标题栏和窗口按钮，管理单实例与托盘；附带 Node.js 运行本地后台 |
| 一键安装 | 每账号执行固定安装动作：Docker 安装 NapCat，npm 安装官方 Codex CLI；原生 NapCat 可手动接入 |
| 群聊回复 | 获准读取及发送的群可组合勾选 @、前缀、低频插话及群事件触发，调用所选 API 模型；带冷却时间 |
| 多 AI 配置 | 提供 DeepSeek、OpenAI、百炼、智谱、Kimi、硅基流动及自定义兼容 API 选项；聊天、通知、收藏分别选择模型 |
| GPT 个人订阅 | 使用本人已登录的官方 Codex CLI，处理本人私聊及明确发起或授权的个人整理任务 |
| 通知汇总 | 当前账号的可读工作群消息存入 SQLite，手动或定时交给所选模型解释；默认保存在本地，可授权私聊发送 |
| 收藏整理 | 读取当前登录账号的收藏列表摘要，使用独立选择的整理模型，保存收藏 ID 和原摘要 |

**工作群默认不发送；用户也可以明确授予其 API 模型回复权限。**「工作群/社交群」描述用途，实际权限由读取、发送和账号释放状态共同决定。个人 Codex 订阅不用于群友触发的自动群聊，未选群和未授权目标不能发送。

```mermaid
flowchart LR
  UI[Electron 仪表盘] -->|选择明确账号| Accounts[本地多账号管理]
  Accounts --> Config[账号配置与模型]
  Config --> Tasks[账号任务参数]
  Tasks --> Permissions[群与私聊权限 / 显式释放]
  QQ[各 QQ 账号] <-->|实际登录 / 消息接口| NapCat[各自 NapCat / OneBot]
  NapCat --> Runtime[每账号运行时与任务队列]
  Accounts --> Runtime
  Runtime --> DS[DeepSeek / 兼容 API]
  Runtime -->|本人任务| Codex[独立登录的 Codex CLI]
  Runtime <--> DB[(各账号 SQLite)]
  Runtime --> Gate[场景 + 目标 + 释放状态校验]
  Permissions --> Gate
  Gate -->|仅已授权发送| NapCat
```

## 当前范围与验证状态

- **QQ 来源**：只缓存连接后实际收到、且已授予读取权限的选定群消息，不回填完整历史。收藏只属于实际登录账号，暂为列表摘要，不含完整正文、图片或附件。
- **GPT 接入**：使用 Codex 当前模型与订阅额度；ChatGPT 网页历史、记忆和自定义 GPTs 不会自动带入。额度不足不自动切换付费 API。
- **本地运行**：多个 QQ 账号可同时在线；应用后台保持运行才会采集和定时汇总。新账号数据相互分开，旧版升级保留原目录、登录状态和既有权限，不扩大授权。
- **后续平台**：微信、Telegram 目前仅列入平台扩展规划，没有可用接入实现。
- **验证**：自动测试、界面与桌面检查见 [验证记录](docs/VALIDATION.md)。正式 EXE 由 Windows CI 测试和构建；真实 QQ、DeepSeek、ChatGPT 及 Windows 原生扫码联调仍待完成。

## 文档与源码导航

| 文档 | 内容 |
| --- | --- |
| [使用指南](docs/USAGE.md) | 创建账号、任务参数、读取与发送权限、私聊命令、收藏和备份 |
| [Windows 原生 NapCat](docs/NATIVE_NAPCAT_WINDOWS.md) | 无需 Docker 的官方安装器、每账号高级连接与端口配置 |
| [功能实现与架构](docs/ARCHITECTURE.md) | 多账号隔离、模型路由、权限门和旧版迁移 |
| [开发指南](docs/DEVELOPMENT.md) | 源码启动、测试、Windows 打包与发布 |
| [接口契约](docs/CONTRACT.md) | schema 2 配置和带账号 ID 的本地 API |
| [验证记录](docs/VALIDATION.md) | 已完成检查及真实账号验收范围 |
| [第三方声明](THIRD_PARTY_NOTICES.md) | 附带运行环境与外部模块许可证 |

```text
desktop/                  Electron 窗口、托盘与后台生命周期
public/                   多账号仪表盘 HTML / CSS / JavaScript
src/server.mjs            本地 HTTP、请求隔离与多账号协调
src/accounts.mjs          稳定账号目录与可用/规划平台清单
src/account-service.mjs   各账号配置、安装任务与权限释放事务
src/config.mjs            schema 2 默认参数、校验与旧版迁移
src/installer.mjs         每账号 NapCat / Codex 安装与状态检查
src/runtime.mjs           QQ 连接、群列表、聊天、汇总与发送权限
src/providers.mjs         DeepSeek / 兼容 API / Codex CLI 模型调用
src/store.mjs             每账号配置、凭据与 SQLite 数据
scripts/                  运行环境准备与打包校验
.github/workflows/        Windows 自动测试、构建与发布
```

开发需要 Node.js 24：

```bash
git clone https://github.com/klwb360/QQ_Service.git
cd QQ_Service
npm ci --ignore-scripts
npm start
```

打开 `http://127.0.0.1:3210`。项目自身代码采用 [MIT](LICENSE) 许可证；外部模块遵循各自许可证，NapCat 商业用途与分发限制见 [第三方声明](THIRD_PARTY_NOTICES.md)。
