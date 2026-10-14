# Windows 原生 NapCat：无需 Docker

[返回首页](../README.md) · [使用指南](USAGE.md) · [官方 Shell 安装说明](https://napneko.github.io/guide/boot/Shell)

QQ_Service v0.2.1 可以直接连接本机原生 NapCat 的 OneBot v11 接口。此方案不需要 Docker Desktop 或 WSL；官方 Windows 一键安装器会准备所需的 QQ 运行环境。

当前 QQ_Service 的「安装 / 启动 / 停止 NapCat」按钮管理 Docker 容器。原生 NapCat 由官方安装器部署、由本人启动，再在 QQ_Service 中填写接口配置。

## 1. 用官方安装器准备 NapCat

1. 下载 [官方 Windows OneKey ZIP · v4.18.38](https://github.com/NapNeko/NapCatQQ/releases/download/v4.18.38/NapCat.Shell.Windows.OneKey.zip)，解压到普通固定文件夹，例如 `D:\Apps\NapCat`。后续版本见 [NapCat Releases](https://github.com/NapNeko/NapCatQQ/releases)。
2. 运行解压后的 `NapCatInstaller.exe`，按提示完成安装；安装过程仍需要下载 QQ 和 NapCat 等组件。
3. 进入安装器生成的 `NapCat.XXXX.Shell` 目录，双击 `napcat.bat` 启动。
4. 按控制台提示登录机器人 QQ 小号并打开 WebUI。WebUI 的地址和登录 Token 以控制台输出为准，常用地址是 `http://127.0.0.1:6099`。

无需提前安装系统 QQ，适用范围为官方说明中的 Windows amd64。如果已有兼容 QQ，也可以按官方文档用 `NapCat.Shell.zip` 手动安装；本页采用官方 OneKey 路径。

## 2. 配置 NapCat 的 OneBot 接口

在 NapCat WebUI 的网络配置中添加或启用 **WebSocket 服务器（正向）**，不是反向 WebSocket：

| 参数 | 设置 |
| --- | --- |
| 启用 | 开启 |
| Host / 监听地址 | `127.0.0.1` |
| Port / 端口 | `3001`，已被占用时选其他空闲端口 |
| Token | 自己设置一个随机 Token，下一步填写相同值 |
| 消息格式 | Array / 数组 |

保存配置，按 WebUI 提示使设置生效。**OneBot Token 与 WebUI 登录 Token 是不同的凭据**，QQ_Service 的「NapCat Token」填写这里的 OneBot Token。

## 3. 连接 QQ_Service

在 QQ_Service「账号与模型」填写：

| 配置 | 填写内容 |
| --- | --- |
| 本人 QQ 号 | 接收汇总、使用个人订阅的主号 |
| 机器人 QQ 号 | 已登录 NapCat 的小号，与本人账号不同 |
| OneBot WebSocket 地址 | `ws://127.0.0.1:3001`，使用上一步的实际端口 |
| NapCat WebUI 地址 | 控制台显示的本机 HTTP 地址，例如 `http://127.0.0.1:6099` |
| NapCat Token | 上一步配置的 **OneBot Token** |
| QQ 接入 | 开启 |

点击 **保存并应用**，查看「QQ 消息连接」是否变为已连接，并核对登录账号。配置 DeepSeek、选定社交群或工作群后，按原使用指南启用对应功能。

此时不要点击 Docker 方式的 NapCat 安装或启动按钮。若还需要安装 Codex CLI，在「一键安装所选模块」中取消 NapCat 勾选，只保留 Codex；Codex 安装不依赖 Docker。

## 运行与排查

- 原生 NapCat 和 QQ_Service 都需要保持运行。当前 QQ_Service 托盘管理自己的后台，不负责启动或停止原生 QQ/NapCat 进程。
- 环境检查可能仍显示 Docker 未安装，模块列表也可能显示 Docker 版 NapCat 未安装；这不阻止直接连接 OneBot。原生方案以 **QQ 消息连接状态和实际账号身份** 为准。
- 连接失败时检查正向 WebSocket 是否启用、端口是否一致、OneBot Token 是否一致、机器人 QQ 是否正确，以及 NapCat 是否仍在运行。
- 原生 NapCat 配置与 QQ 客户端登录资料由上游组件管理，不包含在 QQ_Service 配置导出或数据目录备份中；备份时需按上游说明另行保留。
- 官方安装器后续下载的 QQ/NapCat 版本以其实际结果为准。原生方式仍受 QQ 客户端兼容性和账号状态影响，收藏仍只能读取当前登录账号。

## 已核对的范围

2026-10-14 已核对官方 Shell 文档，并实际下载 v4.18.38 的 OneKey ZIP，确认含 `NapCatInstaller.exe` 和原生启动组件，SHA256 与 GitHub Release 声明一致：

```text
46c3ec155aa61f12e89bbf97013a21243d00b0019b5565992a88852d7627f39c
```

已用现有 QQ_Service 后台、配置应用接口和本地模拟 OneBot 验证直接连接、Token 鉴权与 QQ 身份校验，无需安装或启动 Docker 版 NapCat。这是协议接入检查，尚未执行 Windows 原生安装器或真实 QQ 扫码联调。
