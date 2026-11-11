# 内置 MCP 示例

这些服务均需用户在当前账号主动添加、审批和授权，不会默认运行。

| 服务入口 | 用途 | 工具 |
| --- | --- | --- |
| `local-notes.mjs` | 不联网的临时笔记与计算演示 | `calculate`、`list_notes`、`add_note` |
| `bilibili.mjs` | Bilibili 只读视频搜索与元数据 | `popular_videos`、`search_videos`、`video_details` |

`http-notes.mjs` 是笔记示例的可选 HTTP 入口，用于传输验证；三种 MCP 传输方式不表示三项预装业务服务。

## 本地笔记演示

这个标准 MCP 服务用于验证工具发现、人工审批和群授权。它不联网，不读取真实笔记，也不接受文件路径。

- `calculate`：四则运算，只读。
- `list_notes`：查看本次进程的演示笔记，只读。
- `add_note`：写入演示笔记，必须按写工具授权。

每次进程使用独立的临时目录，退出后清理，重启会重置笔记。服务不安装依赖；使用 QQ_Service 已打包的官方 SDK。

在模块页新建 stdio 服务：命令选择 `node`，参数填写 JSON 数组 `["{appDir}/examples/mcp/local-notes.mjs"]`。QQ_Service 会使用自己的 Node 运行时；不需要填写 `npx`，也不需要另外下载 Node。

导入配置、工具审批、群和成员授权流程见 [MCP 使用说明](../../docs/MCP.md)。服务给出的 `readOnlyHint` 只用于参考，不能代替宿主授权。

`http-notes.mjs` 是可选的 Streamable HTTP 演示，用于本机或隔离容器验证。默认监听 `127.0.0.1:8789/mcp`。设置 `MCP_DEMO_TOKEN` 可要求 Bearer Token；容器内显式设 `MCP_DEMO_HOST=0.0.0.0` 时必须提供至少16字符的 Token，并用 `MCP_DEMO_ALLOWED_HOSTS` 指定客户端访问它的服务名。不要直接向公网发布此演示。

## Bilibili 只读示例

命令填 `node`，参数填 `["{appDir}/examples/mcp/bilibili.mjs"]`，其余审批与授权流程相同。默认尝试公开接口；可选的 `BILIBILI_SESSDATA` 仅通过该服务独立凭据显式提供。站点要求验证时停止，不绕过限制。

示例只复用 `../plugins/bilibili-assistant` 的三个只读工具，不暴露其中的评论功能；不点赞、评论、站内 @、下载媒体，也不表示看完了视频。分发源码和许可证以项目根目录的 MIT LICENSE 为准。
