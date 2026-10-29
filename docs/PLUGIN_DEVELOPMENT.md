# 自定义插件开发指南

[返回首页](../README.md) · [开发指南](DEVELOPMENT.md) · [接口契约](CONTRACT.md) · [示例插件](../examples/plugins/hello-group/)

自定义插件为 QQ_Service 增加可手动执行的功能，也可处理当前账号获授权的群消息。插件包全局安装，各账号分别配置是否启用及功能参数。安装本身不会启用插件，也不会释放 QQ 发送权限。

第一版接收本地文件夹，使用 Node.js 24 的 ESM 模块。暂不提供插件商店、远程 URL 安装、ZIP 安装、自动安装 npm 依赖或自动升级。

此功能位于开发分支，尚未包含在已发布的 v0.5.0 EXE 中。

## 与 NapCat 插件、扩展页面的关系

本指南定义的是 **QQ_Service 插件 API v1**，不兼容 NapCat 插件包；两者需要各自的开发入口和生命周期。NapCat 上游的 [插件管理路由](https://github.com/NapNeko/NapCatQQ/blob/main/packages/napcat-webui-backend/src/router/Plugin.ts) 和 [前端接口](https://github.com/NapNeko/NapCatQQ/blob/main/packages/napcat-webui-frontend/src/controllers/plugin_manager.ts) 提供列表、启停、配置、卸载、商店安装及扩展页面，因此可以另做管理适配器。具体支持情况取决于用户安装的 NapCat 版本。

当前实现尚未代理这些 NapCat 接口。后续联动需要单独处理 NapCat WebUI 登录和会话，不能把 OneBot Token 当作 WebUI 凭据，也不能把第三方扩展 HTML 当作可信页面嵌入本应用。NapCat 自身插件的运行与发送权限由 NapCat 管理，不经过下面介绍的 QQ_Service 插件发送门。

## 先跑通示例

仓库中提供了不依赖模型、不访问网络的 [hello-group](../examples/plugins/hello-group/)：

```text
hello-group/
├── plugin.json
└── index.mjs
```

1. 启动 QQ_Service，在「模块」导入这个文件夹。
2. 为需要使用它的账号启用「群聊问候示例」，填写命令和回复内容。
3. 保存并应用该账号参数。点击插件的手动执行入口，可在本地看到就绪结果，不会向 QQ 发送消息。
4. 若要测试群回复，先连接对应 QQ，在「选定群与消息权限」为测试群允许读取、发送，再点击「启动此账号」确认范围。
5. 用另一个 QQ 在该群发送 `/ping`。满足权限、冷却时间等条件时，示例回复 `Pong!`。发送其他内容则不处理。

插件群回复与 AI 聊天分别执行；一个消息同时命中两者时可能收到两条回复。示例插件不需要启用 AI 聊天，也不需要模型 Key。戳一戳等群通知暂不派发给插件的 `group.message` 处理器。

## 插件清单 plugin.json

```json
{
  "apiVersion": 1,
  "id": "hello-group",
  "name": "群聊问候示例",
  "version": "1.0.0",
  "description": "收到 /ping 时回复 Pong!。",
  "entry": "index.mjs",
  "events": ["group.message"],
  "permissions": ["group.read", "group.send"],
  "settingsSchema": [
    { "key": "prefix", "label": "命令", "type": "string", "default": "/ping", "required": true },
    { "key": "response", "label": "回复内容", "type": "string", "default": "Pong!", "required": true }
  ],
  "timeoutSeconds": 5
}
```

| 字段 | 用途 |
| --- | --- |
| `apiVersion` | 插件协议版本，当前固定为 `1` |
| `id` | 稳定标识：小写字母开头，后接小写字母、数字或 `-`，最多 64 字符 |
| `name` | 在模块页显示的名称 |
| `version` | 插件版本，例如 `1.0.0`；不会据此自动升级 |
| `description` | 可选的功能说明 |
| `entry` | 相对插件根目录的 `.mjs` 入口，子目录用 `/` 分隔；不能使用绝对路径、`.` 或 `..` 路径段 |
| `events` | 可选，当前仅支持 `group.message` |
| `permissions` | 可选，当前支持 `group.read`、`group.send` |
| `settingsSchema` | 可选，声明账号配置中可填写的参数 |
| `timeoutSeconds` | 单次处理超时，默认 5 秒，可设为 1–30 秒 |

订阅 `group.message` 需要声明 `group.read`。声明 `group.send` 还需要同时订阅 `group.message` 并声明 `group.read`；声明权限只是提出能力需求，实际发送仍由账号和群权限决定。只提供本地手动功能时，可以省略 `events` 和 `permissions`。

不要把未支持的功能写成自定义清单字段；宿主会校验格式并拒绝无效插件。`plugin.json` 安装时只读取和校验，不会执行入口代码。

### 参数声明

`settingsSchema` 是简单的字段列表，并非完整 JSON Schema。支持下列字段：

| 字段 | 说明 |
| --- | --- |
| `key` | 字母开头，后接字母、数字或 `_`，最多 64 字符；同一插件中不能重复，也不能使用 `constructor`、`prototype` |
| `label` | 界面中的字段名称 |
| `type` | `string`、`number` 或 `boolean` |
| `default` | 可选，缺少此项配置时采用的默认值，类型必须一致 |
| `required` | 可选，是否必须填写 |
| `min`、`max` | 可选，数值参数的取值范围或文本参数的字符数范围 |
| `description` | 可选，字段说明 |

清单最多声明 50 个参数，`label` 最多 100 字符，`description` 最多 500 字符；文本参数最多 6000 字符，数值必须为有限数值。每个账号只接收此清单中声明的参数，未知字段或类型不匹配会被拒绝。插件参数保存在账号普通配置中，可能随配置导出；这里不适合填写 API Key、密码或 Token。第一版没有给插件开放宿主凭据库接口。

## 编写处理器

使用命名导出 `run` 和 `onMessage`。可以只实现插件需要的处理器；调用不存在的处理器会返回可定位错误。

```js
export async function run({ input, settings, context }) {
  return { text: `本地检查完成，当前命令是 ${settings.prefix}` };
}

export async function onMessage({ event, settings, context }) {
  if (event.text.trim() !== settings.prefix) return null;
  return { reply: settings.response };
}
```

### 手动执行 run

`input` 是仪表盘明确提交的 JSON 输入；`settings` 是这个账号已经应用的插件参数。`context` 提供账号身份信息，见下表。

手动执行用于本地计算、检查或查询，返回 `{ "text": "结果" }` 或 `null`。手动接口不向 QQ 发送消息；返回 `reply` 会被拒绝。插件需已安装，并在当前账号的已应用配置中启用；仅保存尚未应用的启用状态不能执行。

### 群消息 onMessage

宿主只派发已连接账号允许读取的当前群文字消息，过滤自己发送的消息，并按消息 ID 去重。不包含其他群历史、私聊内容、原始 OneBot 数据包或模型凭据。

```js
{
  event: {
    groupId: '123456789',
    userId: '987654321',
    messageId: '4567',
    text: '/ping',
    time: 1793220000,
    mentioned: false
  },
  settings: { prefix: '/ping', response: 'Pong!' },
  context: {
    profileId: '由服务器生成的账号配置 ID',
    platform: 'qq',
    expectedQQ: '账号配置填写的 QQ',
    actualQQ: '连接已核对的实际 QQ'
  }
}
```

| 上下文 | 含义 |
| --- | --- |
| `profileId` | 稳定的账号配置 ID，界面当前选择不会改变已发起任务的目标 |
| `platform` | 当前为 `qq` |
| `expectedQQ` | 当前已应用配置里的 QQ 号 |
| `actualQQ` | 实际连接身份；本地手动执行时可能尚未连接 |

不处理当前消息时返回 `null`；本地说明可返回 `text`；请求向当前群回复时返回 `reply`。`text` 不会自动转发为 QQ 消息。第一版没有指定任意目标、私聊发送、调用宿主模型、读取收藏或读取其他群历史的插件 API。

自动事件处理需要该账号已经启动并释放权限。插件返回 `reply` 后，发送前还会重新核对：

- 插件仍在当前账号启用，且清单声明了 `group.send`。
- 当前 QQ 仍连接，实际登录身份与该账号的配置一致。
- 本次任务对应的配置仍有效，账号未被恢复只读或撤销权限。
- 当前群仍允许读取、发送，并满足群冷却设置。

冷却按“账号／插件／群”独立计算，只在插件请求回复时计入；未命中命令而返回 `null` 不会占用下一条命令的冷却。它与 AI 聊天的冷却分别计算。

`reply` 只能发回产生这条事件的群，不能借返回值扩大目标范围。群里的一句指令、插件安装成功或清单权限声明，都不会自动授予发送权限。

### 返回值与运行边界

处理器只返回 `null` 或带 `text`、`reply` 的普通 JSON 对象；文本每项最多 6000 字符，总返回体最多 32 KiB。不要返回 HTML、函数、循环引用、二进制对象或自定义协议字段。界面把文本作为文字展示，不作为脚本或网页执行。

每次调用启动新的 Worker，宿主最多同时运行 8 个插件 Worker；超时、抛错或异常退出会结束本次执行并记录错误，不会中断正常 AI 功能。模块全局变量不会跨调用保存；不要依赖 `setInterval`、后台常驻线程或未等待完成的异步任务。宿主应用新配置、撤销权限和退出时会取消旧任务。

**插件运行的是可信本地 JavaScript。** Worker 用于故障隔离和超时控制，并非安全沙箱；Node 文件和网络能力仍可能访问当前系统用户可访问的资源。只安装你信任的代码。宿主不会把模型 Key、NapCat Token 或其他账号的配置作为处理器参数传入。

## 安装、配置和更新

安装接受绝对路径文件夹，例如 `D:\Dev\QQ_Service\examples\plugins\hello-group`。宿主把内容复制为独立快照，路径位于应用资料根目录的 `plugins/packages/<id>/`。

默认 Windows 资料根目录为 `%LOCALAPPDATA%\QQBridgeDashboard`；源码调试设置 `QQ_DASHBOARD_DATA_DIR` 后以该目录为准。插件不会写入 EXE 所在目录，也不需要复制进 ASAR 或重新构建 EXE。

包中使用相对导入和 `.mjs` 文件，所需代码和资源一并放入插件文件夹。第三方依赖应提前打包为自包含 ESM 文件；安装过程不会执行 `npm install` 或安装脚本。包目录不能包含符号链接、目录联接、`node_modules`、`.git`，入口必须位于包内。安装器的路径校验不限制可信插件代码自身的 Node 文件与网络能力。包上限为 20 MiB、200 个普通文件、400 个文件或目录项、12 层子目录，`plugin.json` 上限为 64 KiB；最多安装 128 个包，每个账号最多配置 50 个插件，账号插件配置合计不超过 64 KiB。

安装同 ID 插件不会覆盖已有版本。更新流程是：在各账号停用此插件并保存、应用，待执行任务结束后卸载旧包，再导入新包并重新配置启用。停用某个账号不会替其他账号停用插件；卸载检查的是全部账号。修改原始开发文件夹也不会自动更新已安装快照。

### 参数修改何时生效

| 操作 | 结果 |
| --- | --- |
| 导入插件 | 全局登记安装包；所有账号保持原状 |
| 编辑或保存账号插件参数 | 保存待应用配置；当前运行参数不变 |
| 应用账号参数 | 新插件参数生效，旧任务取消，账号重新加载并恢复只读 |
| 启动此账号并确认范围 | 按已应用参数恢复获授权的自动任务 |
| 停用并应用 | 该账号停止派发此插件的新任务 |
| 卸载 | 移除安装包；需要先停用全部账号的引用并等待任务结束 |

目前支持无需重启 EXE 的手动应用；应用过程会重新加载账号，并非无中断更新。只改自己账号的插件配置，不会修改其他账号的参数。

## 后端接口

沿用本机管理接口：只监听 `127.0.0.1`，写请求必须提供 `Content-Type: application/json` 和 `X-Dashboard-Token`。先 `GET /api/accounts` 获取当前页面会话的 `csrfToken` 和稳定账号 ID；不要把 Token 固定写入插件或代码仓库。

| 方法与路径 | 请求体与用途 |
| --- | --- |
| `GET /api/plugins` | 列出全局已安装插件，返回 `{ "plugins": [...] }` |
| `POST /api/plugins/install` | `{ "sourcePath": "D:\\Dev\\hello-group" }`，安装本地目录 |
| `POST /api/plugins/:id/uninstall` | `{}`，卸载插件；仍被启用或正在执行时拒绝 |
| `GET /api/accounts/:accountId/state` | 读取该账号的待应用与已应用配置 |
| `POST /api/accounts/:accountId/config/save` | `{ "config": 完整账号配置 }`，保存插件和其他参数 |
| `POST /api/accounts/:accountId/config/apply` | `{ "revision": 最新保存版本 }`，应用并恢复只读 |
| `POST /api/accounts/:accountId/plugins/:id/run` | `{ "input": JSON输入 }`，手动运行已启用插件，只返回本地结果 |

账号配置增加 `plugins` 数组，默认空数组。相同插件 ID 在一个账号中不能重复：

```json
{
  "plugins": [
    {
      "id": "hello-group",
      "enabled": true,
      "settings": { "prefix": "/ping", "response": "Pong!" }
    }
  ]
}
```

此片段需合并进从账号状态读取的完整 `draft`，不能单独替代整个配置。保存或应用启用插件时，会检查是否已安装及参数是否符合清单；未安装插件的停用引用可保留，以便卸载后继续编辑原配置。

### PowerShell 本地检查示例

以下用于源码模式默认端口。EXE 使用动态端口，须使用当前应用后台的实际地址；不要把 3210 当成固定桌面端口。

```powershell
$dashboardBase = 'http://127.0.0.1:3210'
$directory = Invoke-RestMethod "$dashboardBase/api/accounts"
if ($directory.accounts.Count -eq 0) { throw '请先在界面创建一个账号配置。' }
$accountId = $directory.accounts[0].id # 多账号时改为明确选定的配置 ID
$dashboardHeaders = @{ 'X-Dashboard-Token' = $directory.csrfToken }

function Invoke-DashboardPost($route, $payload) {
    Invoke-RestMethod -Method Post -Uri "$dashboardBase$route" `
        -Headers $dashboardHeaders -ContentType 'application/json; charset=utf-8' `
        -Body ($payload | ConvertTo-Json -Depth 40)
}

# 改成你自己的示例目录。重复安装同 ID 会被拒绝。
Invoke-DashboardPost '/api/plugins/install' @{
    sourcePath = 'D:\Dev\QQ_Service\examples\plugins\hello-group'
}

$accountState = Invoke-RestMethod "$dashboardBase/api/accounts/$accountId/state"
$accountConfig = $accountState.draft
$otherPlugins = @($accountConfig.plugins | Where-Object { $_.id -ne 'hello-group' })
$accountConfig.plugins = $otherPlugins + @(@{
    id = 'hello-group'; enabled = $true
    settings = @{ prefix = '/ping'; response = 'Pong!' }
})
$saved = Invoke-DashboardPost "/api/accounts/$accountId/config/save" @{ config = $accountConfig }
Invoke-DashboardPost "/api/accounts/$accountId/config/apply" @{ revision = $saved.revision }
Invoke-DashboardPost "/api/accounts/$accountId/plugins/hello-group/run" @{
    input = @{ message = '只做本地就绪检查' }
}
```

这段检查不会启动账号或发送 QQ 消息。要验证自动群回复，回到界面检查群范围并明确启动账号。

## 常见问题

| 现象 | 检查方向 |
| --- | --- |
| 导入失败 | 路径是否为绝对目录、清单名称与格式、入口是否存在、是否有链接或超限文件 |
| 导入后没有功能 | 是否为当前账号启用并应用；安装包和账号启用是两个步骤 |
| 手动运行找不到 `run` | 是否使用命名导出 `export async function run(...)` |
| 插件收到消息却未回复 | 返回值是否为 `reply`；清单权限、账号启动状态、QQ 身份、群读取/发送及冷却时间 |
| 戳一戳无反应 | 第一版插件只接收群文字消息，不派发群通知 |
| 参数修改后仍是旧效果 | 是否只保存了待应用参数；源码变更是否重新安装快照 |
| 提示旧任务已取消 | 应用配置、撤销权限或账号退出后，旧执行结果不能继续使用 |
| 超时或依赖找不到 | 减少同步阻塞工作；使用自包含相对 ESM 导入；确保超时内完成所有等待的操作 |
| 无法卸载 | 检查其他账号的已应用与待应用启用状态，以及尚未结束的执行 |

开发调试使用独立资料目录和模拟 OneBot，避免把真实账号消息作为测试夹具。发布插件前至少检查：安装不执行代码、手动执行、命令未命中返回 `null`、参数校验、群权限拒绝、执行中撤销、超时、卸载与重新导入。
