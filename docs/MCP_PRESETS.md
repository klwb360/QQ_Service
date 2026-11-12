# MCP 精选预设

预设只生成未启用的普通 MCP 服务配置。准备配置不会下载软件、启动程序、连接第三方账号或授予工具权限。

| 预设 | 身份与前置条件 | 当前边界 |
| --- | --- | --- |
| 网页搜索与正文读取 | 随附服务；搜索需 Brave Key 或公开 HTTPS SearXNG | `web_fetch` 无需搜索密钥；不登录网站、不运行脚本 |
| Bilibili | 随附服务；个人收藏/稍后再看需本人 SESSDATA | 不自动取得 Cookie；后台任务排队不等于完成 |
| 计算与临时笔记 | 随附示例，无需账号 | 不是长期群友记忆 |
| Telegram 本人号 | 自行安装；API ID/Hash 和登录会话保存在该工具的系统钥匙串 | MTProto 用户会话，非 Bot Token；需单独执行登录；不代表实时入站监听已接通 |
| Windows 微信 | 自行安装；Windows 10/11、微信 4.1.6+、Python 与 UIA 依赖 | 仅可交互 Windows 桌面，容器/macOS/Linux 不可准备 |
| Discord Bot | 自行安装与构建；创建 Bot、配置 token、服务器范围和 intents | 非本人用户账号；上游管理工具与目标限制须独立配置 |
| Slack 官方 | OAuth 授权和工作区批准 | 当前客户端尚不支持该 OAuth 流程，禁用准备入口 |
| Playwright | 自行安装官方 MCP 与浏览器；提供本机程序和入口 | 浏览器自动化，不是桌面 QQ/微信控制 |

第三方预设只接受用户选择的本机绝对程序路径及已安装入口。不会生成 `npx -y ...@latest`、`uvx` 或其它下载执行命令。准备过程不探测本机文件是否真的安装完整；后续发现工具与连接检查仍可能失败，不能显示为“安装成功”或“账号已连接”。

`listMcpPresets({platform, container})` 返回公开元数据，包括用途、凭据存放位置、安装前提、平台限制、固定参考提交和核查日期。`prepareMcpPreset(id, {command, args, url})` 返回标准未启用服务描述；内置预设无需参数，第三方需要本机入口。精选模板统一使用 stdio，远程服务继续通过普通 MCP 导入；Slack 官方不生成可连接草案。

凭据仅声明环境变量名称，预设不提供任何密钥值。Telegram 的 API ID/Hash 和用户 session 由上游钥匙串管理，不能误填为本项目不支持的环境变量。Discord 的 `DISCORD_ALLOWED_GUILDS`、工具集和只读选项也需要在其服务端明确设置；QQ_Service 的调用人授权不能自动限制第三方工具参数中的目标。

2026-11-12 核对的来源：

- [Telegram 说明与入口](https://github.com/DmitryKhali/telegram-mcp/tree/890827e903d50cb06b49a8fcab029caa3bebdb39)
- [Windows 微信说明](https://github.com/RungePei/wechat-mcp/tree/dfd5fac7a5f9d9e0ac4ffaa9cc52355828dfafa4)
- [Discord Bot 说明与入口](https://github.com/PaSympa/discord-mcp/tree/755073f49493258b593ea5e98f0046753dbe0a75)
- [官方 Playwright MCP](https://github.com/microsoft/playwright-mcp/tree/78eca85361efb545a4c0f59b6140aef0721c5412)
- [Slack 官方 OAuth 说明](https://docs.slack.dev/ai/slack-mcp-server/)

以上是说明、入口和凭据约定的核查，未完成第三方全部源码审计、安装或实号验收。

## 来源许可

2026-11-12另外核对了以下固定提交的LICENSE文本。本项目独立实现配置模板，不随应用复制这些第三方服务的源码、二进制或会话；自行安装时仍需遵守对应服务及依赖的许可。

| 来源 | 固定提交的许可 |
| --- | --- |
| Telegram | [MIT，©2026 Dmitry Khalitov](https://github.com/DmitryKhali/telegram-mcp/blob/890827e903d50cb06b49a8fcab029caa3bebdb39/LICENSE) |
| Windows微信 | [MIT，©2026 wechat-mcp contributors](https://github.com/RungePei/wechat-mcp/blob/dfd5fac7a5f9d9e0ac4ffaa9cc52355828dfafa4/LICENSE)；同文件明确依赖pywechat／pyweixin采用LGPL，未注明版本，不能将依赖一并标为MIT |
| Discord Bot | [MIT，©2026 Léandre Moreau](https://github.com/PaSympa/discord-mcp/blob/755073f49493258b593ea5e98f0046753dbe0a75/LICENSE) |
| 官方Playwright MCP | [Apache-2.0，©Microsoft Corporation](https://github.com/microsoft/playwright-mcp/blob/78eca85361efb545a4c0f59b6140aef0721c5412/LICENSE) |

许可文本核对不等于传递依赖审计或软件安全认证。Slack是官方在线服务，按其OAuth文档、工作区批准及服务条款使用；当前入口保持不可准备。QQ_Service自有代码与随附SDK的许可见 [第三方声明](../THIRD_PARTY_NOTICES.md)。
