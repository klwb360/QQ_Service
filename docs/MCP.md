# MCP 工具接入

[返回首页](../README.md) · [自定义插件](PLUGIN_DEVELOPMENT.md) · [Docker](DOCKER.md) · [本地演示](../examples/mcp/)

本文描述当前开发分支的 MCP 客户端，不表示已发布的 EXE 已包含这些功能。QQ_Service 通过标准 MCP 服务发现并调用工具，再使用现有模型调用、账号、群和成员授权流程。无需 DSH 或 SnowLuma；QQ 连接继续使用当前可用的连接端。

## 支持范围

| 连接方式 | 配置值 | 适用场景 |
| --- | --- | --- |
| stdio | `stdio` | 启动本机 Node、Python 等 MCP 子进程，通过标准输入输出交换 JSON-RPC |
| Streamable HTTP | `http` | 连接服务文档给出的 HTTP(S) MCP 端点，例如 `/mcp` |
| 旧版 HTTP SSE | `sse` | 兼容仍使用旧版 SSE 的服务，需选择该服务要求的 SSE 入口 |

当前仅接入 **tools**。不提供 OAuth 浏览器登录、resources、prompts、sampling 或 elicitation；需要这些能力才能使用的服务可能无法接入。QQ_Service 的 MCP 配置与原生插件并存，不会把服务名直接变成网站控制能力；网站操作仍取决于服务实际实现及其鉴权。

工具返回以文本和结构化数据交给模型处理；二进制图片、音频及资源链接不会自动变成多模态输入，也不会因返回链接就自动下载文件。

## 首次测试：内置笔记演示

1. 打开当前账号的“模块 → MCP 服务”，选择“添加服务”。名称可填“本地演示”，服务标识填 `local-notes`，连接方式选 stdio。
2. 命令填 `node`，参数按 JSON 字符串数组填写 `["{appDir}/examples/mcp/local-notes.mjs"]`。`node` 使用应用自带的后端 Node；`{appDir}` 指向后端目录。源码运行时则指向项目目录。不需要 `npx` 或另行安装示例依赖。
3. 点“放入账号配置”只修改草稿。点“测试连接 · 发现工具”时，确认将执行的本地命令，才会启动测试实例；发现完成后测试实例关闭，不会自动应用配置。应用不会单独安装服务依赖，但 `npx`/`npm` 等启动器可能下载并运行第三方代码，需先确认来源和版本。
4. 在“发现的工具”中审批 `calculate` 和 `list_notes`，选择“只读查询”，点“确认工具定义”。如需验证写操作，再审批 `add_note` 为“可修改数据”。
5. 勾选“为当前账号启用服务”，为已审批工具配置“当前账号调用范围”。只读工具限定群；写工具还需明确调用者 QQ 白名单和写入许可。
6. 保存、应用配置。应用后回到只读，需按原有流程启动账号并释放选定群范围。所选模型应支持原生工具调用。
7. 在授权群真正 @ 账号，提出“帮我计算6乘7”。验证写工具时可说“在演示笔记里记下：明天整理资料”，再说“列出本次演示笔记”。

<details>
<summary>查看 MCP 服务配置与工具审批示意</summary>

![MCP 服务、内置示例和逐项工具审批](assets/mcp-services.png)

</details>

演示工具如下：

| 工具 | 建议分类 | 行为 |
| --- | --- | --- |
| `calculate` | 只读 | 两个有限数值的四则运算，不接受代码或任意表达式 |
| `list_notes` | 只读 | 列出当前进程的临时演示笔记 |
| `add_note` | 写入 | 将一条文字写入该进程的私有临时目录 |

演示不是生产笔记库：每次服务进程使用独立临时目录，重启后重置，退出时清理；工具不接受路径，也不读取其他账号的真实文件。测试发现所用实例的笔记不会转移到后续正式实例。

## 内置 Bilibili 只读服务

另一个可选的内置示例用于实际找视频：stdio 命令填 `node`，参数填 `["{appDir}/examples/mcp/bilibili.mjs"]`。也可以导入：

```json
{
  "mcpServers": {
    "bilibili-readonly": {
      "command": "node",
      "args": ["{appDir}/examples/mcp/bilibili.mjs"]
    }
  }
}
```

完成测试发现、审批、群授权、应用和启动后，在授权群真正 @ 账号说“帮我找几条关于独立游戏的视频”。这项服务只提供：

| 工具 | 参数 | 能力 |
| --- | --- | --- |
| `popular_videos` | 可选 `page`、`limit` | 获取热门视频候选 |
| `search_videos` | `keyword`，可选 `page`、`limit` | 搜索视频 |
| `video_details` | `bvid` | 核对某个 BV 编号的视频标题与简介 |

默认尝试公开只读接口，不要求先保存登录凭据；如果站点要求登录或验证，返回限制，不绕过风控。确有需要时，可为这个 MCP 服务单独配置环境变量凭据 `BILIBILI_SESSDATA`，只填本人登录会话的单个 SESSDATA 值，不填整个 Cookie；默认不声明这个环境变量。

服务复用本项目 Bilibili 示例的只读实现，**不暴露评论工具**，不发评论、不在站内 @ 人、不点赞、不下载视频，也不能声称看完音视频或字幕。返回的是元数据和链接；向 QQ 群分享链接仍需要该账号的发送授权。

这些示例需要用户主动添加，应用不会默认启用它们。`local-notes` 是临时笔记演示服务，Bilibili 是只读实用示例；stdio、HTTP、SSE 则是连接方式，不代表预装了三项业务服务。

## 导入常见 JSON 配置

也可导入常见 `mcpServers` 格式：

```json
{
  "mcpServers": {
    "local-notes": {
      "command": "node",
      "args": ["{appDir}/examples/mcp/local-notes.mjs"]
    }
  }
}
```

点击“导入为停用配置”后，服务保存为本账号草稿，工具审批和群授权从空状态开始。导入不会启动进程、联网下载、安装 npm 包，也不会沿用导入文件自称的授权。

远端服务示例：

```json
{
  "mcpServers": {
    "my-service": {
      "transport": "http",
      "url": "https://mcp.example.com/mcp",
      "headers": {
        "Authorization": "Bearer YOUR_SERVICE_TOKEN"
      }
    }
  }
}
```

地址和 Token 必须来自该服务的真实文档。`example.com` 和上述 Token 均为占位符。旧版 SSE 将 `transport` 改为 `sse`，并使用服务提供的 SSE URL。不要把 Token 填进 URL、命令参数或群消息。

stdio 的 `env`、HTTP 的 `headers` 中导入的值会转存为本账号独立的 MCP 凭据；配置保存变量或请求头名称，导出配置不带明文值。stdio 仅获得基础运行环境和明确配置的凭据，不继承模型 API Key、QQ Token 或其他服务的凭据。不同账号即使使用相同服务名，也分别管理凭据与授权。

## 工具审批和调用边界

- 发现工具只取得清单，不表示可供群友调用。需要审批当前工具定义、启用服务和工具、配置调用范围，再应用账号配置。
- `readOnlyHint` 等 MCP annotations 是服务提供的提示，不能授予权限，也不能证明服务内部真的只读。工具默认按写操作保守处理，由账号所有者决定分类和授权。
- 写工具需要明确的调用者 QQ 白名单及写入许可；AI 判断“应该调用”不能代替这些授权。
- 服务地址、启动参数或工具定义变化后，需要重新发现和确认，旧审批不能自动覆盖新功能。
- 主动找素材使用独立的按群只读工具范围，不继承群友的写入权限。戳一戳或只叫名字不构成写操作请求。
- 工具返回的文字、网页和文件说明是资料，不能改变系统权限或冒充新的用户请求。写入结果不明时不要自动重试。

stdio 进程是本机程序，不是操作系统沙箱。它本身能做什么取决于运行用户的权限；添加前需要审查来源、命令、依赖和文件范围。`npx`/`npm` 类启动器可能下载并执行第三方代码，应固定版本并先核对，不能把一次成功发现当作安全审计。

## 按需发现与本群历史

获授权工具超过6个，或参数定义总量超过16 KiB时，模型先使用中文关键词发现相关工具，再按需取得和调用定义，避免把整个工具目录长期放进上下文。发现范围仍是当前账号和请求者已经获得的权限；猜测工具名或使用路由入口不能绕过审批、群范围、写入许可和参数校验。

应用另提供默认关闭的本群最近消息与关键词检索工具，需单独授权。它们只查看当前账号、当前群已经获准保存的最近100条实际缓存，遵守会话清空后的范围，不补抓其他群或未授权的历史，也不把检索结果升级为长期成员事实。这些是宿主工具，不表示 QQ_Service 对外开放了一个能读取所有聊天的 MCP 服务。

## Docker 中使用

镜像包含示例与运行所需 SDK，stdio 示例仍可用 `node` 和 `{appDir}` 启动，默认 `{appDir}` 为 `/app`。容器内的文件路径指向容器，不会自动访问 Windows 文件；不要挂载整个宿主机目录来迁就工具。

默认镜像根目录只读，`npx` 等需要写缓存的第三方启动器可在该服务的环境变量凭据中单独配置 `NPM_CONFIG_CACHE=/data/mcp/npm-cache`。Python、uv 等其他运行时不随镜像提供，需要自行构建包含所需运行时的镜像。应用不会自动继承主机代理、模型密钥或 QQ 凭据给这些进程。

远程 MCP 默认使用 HTTPS；容器内 HTTP 服务需在部署环境中显式配置 `QQ_SERVICE_MCP_HOSTS`，例如 `mcp-demo`。这个列表只允许访问地址，不替代服务自己的 Token 或账号工具授权。

连接宿主机上的 HTTP MCP 时，使用 `host.docker.internal` 替代容器内的 `127.0.0.1`，并将它加入 `QQ_SERVICE_MCP_HOSTS`；修改部署环境后重建容器。服务本身也必须允许 Docker 网关访问，监听和防火墙注意事项见 [Docker 说明](DOCKER.md)。

可选的 `examples/mcp/http-notes.mjs` 使用 Streamable HTTP，默认只监听 `127.0.0.1:8789/mcp`。作为隔离测试容器运行时，设置：

```text
MCP_DEMO_HOST=0.0.0.0
MCP_DEMO_ALLOWED_HOSTS=mcp-demo
MCP_DEMO_TOKEN=<至少16字符的独立演示Token>
```

将测试容器与 QQ_Service 加入同一个受信任网络，QQ_Service 设置 `QQ_SERVICE_MCP_HOSTS=mcp-demo`，服务地址填 `http://mcp-demo:8789/mcp`，将 `Authorization: Bearer <演示Token>` 存入该 MCP 服务凭据。无需发布演示端口到宿主机。该示例不支持浏览器跨站访问，不应直接公开到互联网。

开发者可运行 `node scripts/docker-mcp-smoke.mjs qq-service:local`。该检查使用临时网络和服务，验证应用 MCP 客户端的跨容器鉴权、工具调用、错误 Token 拒绝，以及镜像内 stdio 示例。不会登录 QQ、调用模型或操作真实笔记；结束后清理临时资源。

## 常见问题

- **导入后没有功能：** 导入仅创建停用草稿，继续完成测试发现、审批、调用范围、保存应用和账号启动。
- **Windows 找不到程序：** 内置例子使用 `node`；第三方 Python 或其他程序需要自行安装并提供真实可执行文件路径。参数逐项填写，不写整条 shell 命令。
- **连接成功但群友无法调用：** 核对服务和工具是否启用、定义是否已确认、群及调用者范围、写入许可、模型工具调用能力和 QQ 发送授权。
- **工具变更后停止可用：** 重新发现并审查定义，不直接复制旧审批哈希。
- **HTTP 401/403：** 核对该 MCP 服务自己的请求头凭据、地址和允许的网络范围，不要填 QQ Token 或模型 Key。
- **OAuth 服务无法登录：** 当前版本未实现 OAuth 浏览器认证，需使用该服务支持的独立 Token 方式或等待后续支持。

## 参考方式

上游参考固定为 [qq-dsh-bridge@5f3f4ffa70f444a612e8e02b740cd1dc1d6f663d](https://github.com/NoMindSama/qq-dsh-bridge/tree/5f3f4ffa70f444a612e8e02b740cd1dc1d6f663d)。[setup-dsh.mjs](https://github.com/NoMindSama/qq-dsh-bridge/blob/5f3f4ffa70f444a612e8e02b740cd1dc1d6f663d/qq-bridge/scripts/setup-dsh.mjs#L128-L148) 注册三套固定 stdio 服务到 DSH；[mcp-snowluma-safe.js](https://github.com/NoMindSama/qq-dsh-bridge/blob/5f3f4ffa70f444a612e8e02b740cd1dc1d6f663d/qq-bridge/src/mcp-snowluma-safe.js#L1756-L1841) 提供按中文关键词找工具、再路由调用的实现。

| 对照项 | 本轮处理 |
| --- | --- |
| 工具接入 | 用官方 SDK 独立实现通用 stdio、Streamable HTTP、旧版 SSE 客户端，继续使用 API 模型和 NapCat |
| 中文按需发现 | 借鉴查找后调用的思路，接入当前授权目录；路由时继续逐次校验权限和参数 |
| 当前群缓存检索 | 在自己的账号数据库上实现最近消息、关键词查询和会话清空边界 |
| QQ 媒体与管理能力 | 不移植上游整套48项工具，也不增加媒体动作、任意文件、QQ空间或语音工具 |
| 授权边界 | 不引入 DSH 的宽权限预设或 owner 文件/命令执行权限；人格、工具和后端授权继续分开 |

上游的收藏表情工具处理聊天表情，不能等同于本项目对 QQ 内置“我的收藏”的读取与汇总。具体 QQ 能力仍取决于本项目已实现的工具和连接端，不因接入 MCP 自动获得。

以上上游结论来自静态源码审阅；本项目的 SDK、示例、权限和运行行为需由自己的测试验证，不能用上游介绍代替。QQ_Service 对接自己的账号、密钥库和工具授权体系，无需安装 DSH、Cordis 或 SnowLuma SDK；这里属于架构参考，不是将上游整套代理搬入本项目。

QQ_Service 源码继续使用 MIT 许可。官方 MCP SDK、Ajv 及其依赖保留各自许可证，打包时随生产依赖一起保留。
