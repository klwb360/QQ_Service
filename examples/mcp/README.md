# 内置 MCP 示例

这些服务均需用户在当前账号主动添加、审批和授权，不会默认运行。

| 服务入口 | 用途 | 工具 |
| --- | --- | --- |
| `local-notes.mjs` | 不联网的临时笔记与计算演示 | `calculate`、`list_notes`、`add_note` |
| `bilibili.mjs` | Bilibili 内容读取与聊天后台总结 | 9项站点只读内容工具＋3项宿主任务工具 |

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

## Bilibili 内容与后台总结

命令填 `node`，参数填 `["{appDir}/examples/mcp/bilibili.mjs"]`。公开视频查询默认尝试公开接口；本人收藏夹、稍后再看和专栏收藏需要该服务独立声明的 `BILIBILI_SESSDATA`。凭据只填现有 MCP 加密凭据栏，不能发到聊天，也不读取浏览器 Cookie 或其他插件的凭据。

服务提供12项工具：

- 公开视频查询：`popular_videos`、`search_videos`、`video_details`。
- 本人内容来源：`list_favorite_folders`、`list_favorite_items`、`list_watch_later`、`list_favorite_articles`。
- 可核对内容：`read_video_content`、`read_article_content`，明确区分字幕、文章文字及仅有元数据。
- 绑定当前请求者与会话的宿主任务：`queue_library_digest`、`library_digest_status`、`cancel_library_digest`。

完成一次现有 MCP 审批与账号／群／调用者授权后，在聊天里提出要求，例如“每天北京时间22:00到23:00，总结我稍后再看里最近7天发布的5条新内容”。AI 核对来源后创建后台任务，完成结果只回原授权会话；无需新建前端设置。内容发布时间／加入时间与每天运行时段是独立参数；最近N天会按每次运行时刻滚动计算，不能与固定起止时间同时填写。

本人 `ownerQQ` 私聊也可提出请求，但需原私聊发送许可、账号已释放及 Bilibili 工具调用者白名单明确包含本人；其他 MCP／插件不自动获得私聊权限。

排队／取消要按任务写工具授权，可能使用当前账号的模型额度；不会修改 B站、播放或下载媒体。独立运行这个 MCP 服务时，宿主任务工具返回 `requiresHost`，不读取模型密钥或假称已排队。它们仅由 QQ_Service 对精确内置服务进行受控处理。

服务复用 `../plugins/bilibili-assistant` 的三项查询，不暴露评论功能；新增读取器也只使用固定 GET 接口。字幕缺失、文章内图片、分P或截断都会注明，不能声称看完视频或理解完整视觉内容。限流／登录／验证失败时停止，不绕过限制。详细步骤、聊天示例与范围见 [MCP 指南](../../docs/MCP.md#内置-bilibili-内容与后台总结)。分发源码和许可证以项目根目录 MIT LICENSE 为准。
