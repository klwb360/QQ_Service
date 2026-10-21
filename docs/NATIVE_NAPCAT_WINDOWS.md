# Windows 原生 NapCat：无需 Docker

[返回首页](../README.md) · [使用指南](USAGE.md) · [官方 Shell 安装说明](https://napneko.github.io/guide/boot/Shell)

QQ_Service 可以连接本机原生 NapCat 的 OneBot v11 接口，无需 Docker Desktop 或 WSL。NapCat 是 QQ 连接组件，负责实际 QQ 登录和消息接口；DeepSeek/Codex 不代替它登录 QQ。

v0.5.0 在「设置 → NapCat 接入方式」全局选择 **本地安装**。此设置适用于所有账号，设置页无需选择账号。按官方说明安装后，点击「选择文件」选中启动文件；再到账号的「连接 QQ」点击 **打开 NapCat → 打开登录页 → 连接并继续**。已有 NapCat 且已经登录时，直接核对第 2 节的接口即可。

## 1. 用官方安装器准备 NapCat

1. 下载 [官方 Windows OneKey ZIP · v4.18.38](https://github.com/NapNeko/NapCatQQ/releases/download/v4.18.38/NapCat.Shell.Windows.OneKey.zip)，解压到固定文件夹，例如 `D:\Apps\NapCat-AccountA`。其他版本见 [NapCat Releases](https://github.com/NapNeko/NapCatQQ/releases)。
2. 运行 `NapCatInstaller.exe`，按提示完成安装；过程中仍需下载 QQ/NapCat 组件。
3. 进入生成的 `NapCat.XXXX.Shell` 目录，在 QQ_Service 设置中选择其中的 `napcat.bat`。也可选择官方桌面管理工具的 `.exe`；支持 `.exe/.bat/.cmd` 启动文件。
4. 按控制台提示实际登录准备接入的 QQ 账号并打开 WebUI，地址和登录 Token 以输出为准，常用地址为 `http://127.0.0.1:6099`。

无需提前安装系统 QQ，适用范围为上游说明中的 Windows amd64。若已有兼容 QQ，可按官方文档用 `NapCat.Shell.zip` 手动安装；本页采用 OneKey 路径。**在面板输入 QQ 号仅设置预期身份，不能跳过此处登录。**

## 2. 配置 OneBot 正向接口

在 NapCat WebUI 网络配置中添加或启用 **WebSocket 服务器（正向）**，不是反向 WebSocket：

| 参数 | 设置 |
| --- | --- |
| 启用 | 开启 |
| Host / 监听地址 | `127.0.0.1` |
| Port / 端口 | 例如 `3001`，使用本机未占用端口 |
| Token | 为该实例生成随机 Token，面板填写相同值 |
| 消息格式 | Array / 数组 |

保存并按 WebUI 提示使配置生效。**OneBot Token 与 WebUI 登录 Token 不同**；QQ_Service 高级连接中的 NapCat Token 填写 OneBot Token。

## 3. 创建并连接对应账号

在 QQ_Service「账号控制」创建或选择账号：

| 配置 | 填写内容 |
| --- | --- |
| 账号名称 | 方便自己辨认，例如「工作通知账号」 |
| 接入 QQ 号 | 当前实例实际登录的 QQ 号 |
| QQ 连接开关 | 启用 |
| 高级连接：OneBot WebSocket 地址 | 例如 `ws://127.0.0.1:3001`，端口与上一步一致 |
| 高级连接：NapCat WebUI 地址 | 该实例控制台提供的本机 HTTP 地址 |
| 高级连接：NapCat Token | 此实例的 OneBot Token |

保存并建立连接，核对状态和**实际登录 QQ**。此时只建立连接，账号仍只读；不需要先填写另一个“本人 QQ”。已有 DeepSeek Key 时继续到账号功能步骤，选择聊天或通知使用的模型，再到「选定群与消息权限」选群和范围，最后点击 **启动此账号**。只读通知可以保持群发送和私聊发送关闭。

连接成功后可读取已加入群作为验证，但这不等于已授权这些群。请让所选群产生一条新消息，再检查当前账号记录；完整验证步骤见 [使用指南](USAGE.md#6-验证一次完整流程)。不要仅依据“NapCat 已安装”判断 QQ 已接通。

本地方式的模块卡片显示「打开 NapCat」，不显示 Docker 安装/停止按钮。Codex CLI 在自己的模块卡片安装，不依赖 Docker。选择文件或切换方式不会自动启动程序。

## 4. 多账号同时在线

NapCat 支持多账号并行；官方 [NapCatQQ-Desktop](https://github.com/NapNeko/NapCatQQ-Desktop) 可管理多个账号实例。每个 QQ 需要自己的实际登录、连接端口和 OneBot 配置。QQ_Service 共用的是安装方式与启动入口，账号连接、数据与消息权限仍独立；点击同一个启动文件并不会自动创建多个隔离账号。

下面仅是端口规划示例，实际以各实例生效配置为准：

| 实例 | OneBot 地址 | WebUI 地址 |
| --- | --- | --- |
| 账号 A | `ws://127.0.0.1:3001` | `http://127.0.0.1:6099` |
| 账号 B | `ws://127.0.0.1:3003` | `http://127.0.0.1:6101` |

在上游实例中同时调整监听端口和 WebUI 端口，不能只改 QQ_Service 表单。独立目录是否足以隔离 QQ 登录资料，取决于上游启动方式；请按官方多实例方式配置，不要复制正在使用的会话目录冒充第二次登录。当前未完成真实 Windows 原生多账号验收。

## 运行与排查

- 各 NapCat 实例和 QQ_Service 都需保持运行。应用可打开全局选定启动程序；原生 QQ/NapCat 的各账号停止及实例切换由上游窗口管理。
- 本地方式不检查 Docker/WSL；「已选启动文件」只表示文件可用，实际 QQ 在线以连接与身份校验结果为准。
- 连接被拒绝时，先确认 `napcat.bat` 启动的窗口仍在运行、正向 WS 服务器已启用，且 WS 地址对应消息接口端口，不是 WebUI 端口；不能靠重新填入 QQ 号解决。
- 鉴权失败时核对 OneBot Token，不能填写 WebUI Token。身份不一致时核对实际登录 QQ 和实例端口；多个账号不能复用同一正在使用的接口。
- “连接成功但不回复”通常还需检查该账号功能开关、群读取/发送、私聊目标及最后的权限释放；普通应用和回滚会回只读。
- 只有启用私聊回复或私聊汇总时，接收 QQ 才必须与受控 QQ 不同；纯群/本地用途关闭这些私聊选项即可，不需要第二个账号。
- 原生 QQ/NapCat 的登录资料不包含在 QQ_Service 脱敏导出或默认数据目录备份中，需按上游说明另行备份。
- 上游下载的实际 QQ/NapCat 版本以安装结果为准。收藏仍只能读取该实例登录账号自身的列表摘要。

## 已核对的范围

2026-10-14 已核对官方 Shell 文档，并下载 v4.18.38 OneKey ZIP，确认包含 `NapCatInstaller.exe` 和原生启动组件，SHA256 与 GitHub Release 声明一致：

```text
46c3ec155aa61f12e89bbf97013a21243d00b0019b5565992a88852d7627f39c
```

此前已用后台与本地模拟 OneBot 检查直连、Token 鉴权和身份校验，不需要 Docker。以上是文件与协议检查，不能代替运行 Windows 安装器、真实 QQ 扫码或原生多账号联调。本版实际验证见 [验证记录](VALIDATION.md)。
