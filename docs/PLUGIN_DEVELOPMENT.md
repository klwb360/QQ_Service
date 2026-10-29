# 自定义插件开发指南

[返回首页](../README.md) · [开发指南](DEVELOPMENT.md) · [接口契约](CONTRACT.md) · [AI 工具示例](../examples/plugins/text-tools/) · [固定命令示例](../examples/plugins/hello-group/)

自定义插件为 QQ_Service 增加可由 AI 按需调用的工具，也可以提供手动功能或固定群命令。插件包全局安装，各账号分别配置是否启用、工具授权范围及功能参数。安装本身不会启用插件，也不会释放 QQ 发送权限。

第一版接收本地文件夹，使用 Node.js 24 的 ESM 模块。暂不提供插件商店、远程 URL 安装、ZIP 安装、自动安装 npm 依赖或自动升级。

此功能位于开发分支，尚未包含在已发布的 v0.5.0 EXE 中。

## AI 按需调用工具

例如用户在已授权群里真正 @ 接入账号，再说“帮我统计‘你好，世界’的字数”，宿主把这个群和发送者获授权的工具说明交给所选 API 模型，模型选择工具及参数，宿主校验后执行，再把工具结果交回模型生成回复。插件开发者负责具体功能，宿主负责模型往返、参数校验与账号授权检查。QQ群中需要从成员列表或输入联想里选择实际账号，形成 OneBot 的 `at` 消息段；手打 `@QQ号` 普通文字不算真正的 @。

这是一套使用模型原生 function calling 的插件工具协议；当前没有实现 MCP stdio／HTTP 客户端或服务端，不能直接导入一个 MCP 服务配置，也没有通用网站浏览器自动化能力。接入具体应用时，需要分别编写对应工具、鉴权及功能实现；仅填写应用名称或安装文本示例，不会获得任意应用的控制能力。

### 工具示例与配置

先导入仓库中的 [text-tools](../examples/plugins/text-tools/) 文件夹。该示例声明一个 `text-tools/count_text` 工具，只统计调用参数中的文本，不联网、不读取文件，也不调用外部应用。

```json
{
  "plugins": [
    { "id": "text-tools", "enabled": true, "settings": {} }
  ],
  "tools": {
    "enabled": true,
    "triggers": ["mention", "poke", "name"],
    "aliases": ["小助手"],
    "prefix": "/工具",
    "skill": "回答简洁。需要统计文字时，优先使用已授权的文本统计工具。",
    "grants": [
      {
        "tool": "text-tools/count_text",
        "groupIds": ["222222"],
        "userIds": [],
        "allowWrite": false
      }
    ]
  }
}
```

以上片段需合并进该账号的完整配置。`222222` 需换成你实际选定的测试群；还需为该群允许读取、发送，配置支持工具调用的 API 模型，保存并应用后明确启动账号。ChatGPT 个人订阅／Codex 不用于群友触发的自动工具调用。首次测试建议只授权这个只读示例。

`plugins` 控制账号是否启用整个插件；`tools` 另外控制 AI 是否可用该插件提供的某个工具。默认 `tools.enabled` 为 `false`，`triggers` 为 `["mention", "poke", "name"]`，`aliases` 和 `grants` 为空，`prefix` 为 `/工具`，`skill` 为空；安装、启用插件或群里有人提出需求，都不会自动生成工具授权。

### 唤醒方式与个人技能

| 配置 | 行为 |
| --- | --- |
| `mention` | 真正 @ 接入账号并附带请求，进入 AI 工具流程 |
| `poke` | NapCat 上报的戳一戳必须指向实际接入 QQ；单独戳一下只唤醒／问候，不据此执行外部工具 |
| `name` | 在消息开头叫已配置的名字或昵称，再给出请求；整条消息只有名字时只唤醒／问候 |
| `command` | 可选高级触发；加入 `triggers` 后才启用 `prefix` 指定的命令，例如 `/工具` |
| `aliases` | 最多 10 个名字，每个最多 20 字符。名称需位于消息开头，后接分隔符或整条消息就是该名称，正文中偶然包含同名文字不会唤醒 |
| `skill` | 当前账号的个人技能说明，最多 8000 字符；可直接填写，或从 `.md` 文件导入正文 |

`skill` 可以约定回答风格、工具使用顺序和个人偏好；它是账号所有者填写的文字说明，不是可执行脚本，不会安装功能，也不会授予工具、群、请求者或站点写入权限。插件仍须实现具体能力，相关工具仍需逐项授权。普通消息未命中所选唤醒方式时，不会自动进入这一工具流程。

| 授权字段 | 含义 |
| --- | --- |
| `tool` | `插件ID/工具名`，必须引用已安装、当前账号已启用插件声明的工具 |
| `groupIds` | 允许使用此工具的群；还受该账号现有群读取／发送范围约束 |
| `userIds` | 允许发起的群成员 QQ。只读工具为空时，表示所选群内成员均可使用 |
| `allowWrite` | 是否事先授权写操作；写工具还必须填写明确的 `userIds` 白名单 |

工具清单中的 `effect` 为 `read` 或 `write`，省略时按 `write` 处理。`read` 应只查询或计算；发消息、提交表单、创建或修改外部内容等应声明为 `write`。宿主根据这项声明决定授权要求，无法通过声明验证任意 JavaScript 是否真的只读，开发者必须如实声明。

写工具采用账号所有者预先授权，第一版没有“每次执行前再弹出确认”的流程。只有 `allowWrite: true` 且请求者命中该工具明确的 QQ 白名单时，才会把写工具提供给模型。没有相应授权时，模型无法通过猜测工具名扩大自己的能力范围。

外部写操作可能在超时或取消前已经生效，宿主无法回滚第三方应用的修改。写工具应按具体服务设计幂等处理并返回可核对的操作结果；不要把网络超时直接解释为“没有执行”，也不要在处理器内部盲目重试。

### 在清单中声明工具

一个插件最多声明 20 个工具。工具名称以小写字母开头，后接小写字母、数字或 `_`，最多 48 字符，不能使用 `constructor` 或 `prototype`；说明为必填文本，最多 1000 字符。每个工具提供名称、准确的用途说明、操作性质和参数结构：

```json
{
  "tools": [
    {
      "name": "count_text",
      "description": "统计明确提供的文本的字符数及行数，不读取其他资料。",
      "effect": "read",
      "inputSchema": {
        "type": "object",
        "properties": {
          "text": { "type": "string", "maxLength": 1000 }
        },
        "required": ["text"],
        "additionalProperties": false
      }
    }
  ]
}
```

将 `tools` 加到下面所述的 `plugin.json` 中即可；纯工具插件不需要订阅 `group.message` 或声明 `group.send`，工具结果由宿主在当前授权群统一回复。`inputSchema` 使用有界的 JSON Schema 子集：

| 参数类型 | 可用约束 |
| --- | --- |
| `object` | `properties`、`required`、`additionalProperties: false`；顶层必须为对象 |
| `array` | `items`、`minItems`、`maxItems`，最多 100 项 |
| `string` | `minLength`、`maxLength`，最多 6000 字符 |
| `number`／`integer` | `minimum`、`maximum`，必须为有限数值 |
| `boolean` | 布尔值 |
| 标量枚举 | `enum`，列出 1–100 个不重复、符合类型与范围的值 |

未声明的对象参数会被拒绝，不支持 `additionalProperties: true`、`$ref`、正则 `pattern` 或组合 schema。单个 schema 最多 16 KiB、100 个节点、6 层嵌套，每个对象最多 30 个属性；属性名长度为 1–100 字符，不能使用 `__proto__`、`constructor`、`prototype`。每个类型节点可附带最多 1000 字符的 `description`；实际参数最多 16 KiB、8 层嵌套。请把可接受的参数写清楚，避免用一个不受约束的字符串代替结构化参数。

### 实现 callTool

```js
export async function callTool({ name, arguments: args, settings, secrets, context }) {
  if (name !== 'count_text') throw new Error('不支持的工具。');
  return { text: JSON.stringify({ characters: Array.from(args.text).length }) };
}
```

处理器通过 `name` 区分当前插件内的工具，`arguments` 是通过清单校验的参数，`settings` 是当前账号已应用的插件参数，`secrets` 只包含这个插件声明的独立密钥；`context` 延用本指南的账号上下文。返回 `{ "text": "工具执行结果" }`，不能返回 `reply` 或指定 QQ 目标。宿主把结果作为工具资料交回模型，资料中的文字不能成为新的系统指令或额外权限。

模型只提出候选调用；宿主会再次核对工具、参数、当前群、发起者及账号状态，未获授权的工具调用不会执行。一个群工具请求最多实际执行 3 次工具、发起 4 次模型请求，不自动重试，也不会改用其他 Key、厂商或计费通道。参数或配置改变、账号恢复只读、连接身份变化后，旧任务不能继续执行或发送。

同一请求不允许通过更换调用 ID 重复提交相同参数的写入工具。群消息的写入尝试还会在执行前写入该账号的本地任务记录；重新连接、应用参数后收到同一条消息，不会再次执行同一写入。这个机制不能替第三方平台回滚操作，也不会把结果未知自动视为失败；用户需要先核对外部结果。新发一条请求是新的操作意图，开发者仍需按服务特点防止重复业务动作。

## Bilibili 示例

[bilibili-assistant](../examples/plugins/bilibili-assistant/) 提供热门视频、搜索、详情和单独授权的评论工具。安装后可在群里真实 @ 账号或称呼设定的别名，再用自然语言查找视频。Skill 可以描述兴趣和筛选方式，但不能授予评论权限。视频链接随 QQ 回复返回；当前依照标题、简介等元数据筛选，没有完整视频播放／理解或无人值守后台刷视频。

评论需填写插件参数中的固定 Bilibili UID、昵称，以及插件自己的加密 `sessdata`、`csrf` 字段，再为特定群和调用人明确开启写入工具。评论接口返回编号不代表 @ 通知已送达。登录字段配置、网站兼容性和评论提醒仍需实际账号验收；本仓库测试没有真实发表评论。详细步骤、能力和限制见[插件说明](../examples/plugins/bilibili-assistant/README.md)。

工具流程优先处理命中已选触发方式的请求，避免与固定命令插件及普通 AI 回复重复执行；不要求默认使用斜杠命令。单独的 @、昵称或戳一戳不应被解释为某个外部写操作。工具名称和清单声明不代表相应外部网站已完成真实联调；开发者需要用真实服务单独验证。

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
| `secretsSchema` | 可选，声明插件自己的独立密钥，最多 10 项；见下文 |
| `tools` | 可选，声明模型可按授权调用的工具，最多 20 个；见上文 |
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

清单最多声明 50 个参数，`label` 最多 100 字符，`description` 最多 500 字符；文本参数最多 6000 字符，数值必须为有限数值。每个账号只接收此清单中声明的参数，未知字段或类型不匹配会被拒绝。插件参数保存在账号普通配置中，可能随配置导出；API Key、密码或 Token 应使用独立密钥声明。

### 插件自己的密钥

需要站点会话或独立 API Key 的插件，可以在清单中声明 `secretsSchema`，但不能把真实值写进清单：

```json
{
  "secretsSchema": [
    { "key": "session", "label": "站点会话", "description": "由账号所有者提供，只用于本插件的站点访问。" }
  ]
}
```

最多声明 10 项。`key` 使用与普通参数相同的命名规则，不能重复或使用保留名；`label` 必填，最多 100 字符，`description` 可选，最多 500 字符。密钥值为最多 2000 字符的单行文本，同次调用传入的插件密钥总量最多 16 KiB。清单不能声明默认密钥；缺少密钥时由处理器说明哪项站点功能还不能执行。

账号配置界面通过已有的 `secretUpdates` 机制保存，例如键名 `pluginSecret:my-plugin:session` 对应 `my-plugin` 插件声明的 `session`。值加密存入该账号凭据库，应用后传入其处理器的 `secrets.session`；普通状态仅提供 `state.secrets` 中的存在标记，配置导出不包含密钥值。空白输入保留已有值。

`run`、`onMessage`、`callTool` 都只接收自己的声明密钥，不会收到模型 Key、NapCat Token、其他插件或其他账号的凭据。不要把密钥写入返回结果、日志、工具说明或模型参数；工具调用结果会交给模型，不能用来传递会话。

## 编写处理器

使用命名导出 `run`、`onMessage` 或 `callTool`。可以只实现插件需要的处理器；调用不存在的处理器会返回可定位错误。`callTool` 的工具流程见上文；以下是手动功能和固定群命令的补充入口。

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

不处理当前消息时返回 `null`；本地说明可返回 `text`；请求向当前群回复时返回 `reply`。`text` 不会自动转发为 QQ 消息。处理器没有指定任意目标、私聊发送、主动调用宿主模型、读取收藏或读取其他群历史的宿主 API；AI 工具流程中的模型往返由宿主统一发起。

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
| `GET /api/accounts/:accountId/tools` | 列出该账号已应用、已启用插件的工具描述及工具设置 |
| `POST /api/accounts/:accountId/tools/call` | `{ "tool": "text-tools/count_text", "arguments": { "text": "你好" } }`，所有者在本地调试只读工具，返回 `{ "tool": "text-tools/count_text", "result": { "text": "..." } }` |

工具目录中的每项包含 `id`、`name`、`description`、`effect`、`inputSchema`；`id` 为 `插件ID/工具名`，`name` 为宿主生成的模型函数名，不应自行拼接。工具目录是所有者调试视图，不代表所有群成员都获准调用其中的工具。

`/tools/call` 不调用模型、不向 QQ 发送，也不要求先释放群权限，适合在只读状态检查已经应用、启用的只读工具。它不使用群授权来扩大能力；第一版拒绝用这个本地接口执行 `write` 工具，写工具需经过群内明确请求、工具授权及请求者白名单检查。

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
| @ 或叫名字没有调用工具 | 是否实际 @ 接入账号、是否勾选对应唤醒方式、昵称是否位于消息开头，以及已应用的插件与工具授权、群范围、请求者 QQ |
| `/工具` 没有调用工具 | 斜杠命令默认未启用；需要把 `command` 加入 `triggers`，并核对 `prefix` |
| API 不支持 `tools` | 向模型服务商确认当前模型是否支持原生 function calling；宿主不会自动改用其他模型或计费通道 |
| 模型提出了未授权工具 | 宿主会拒绝执行；先在账号配置中明确授权所需工具与群，不要让模型代替所有者修改权限 |
| 写工具没有执行 | 检查 `allowWrite` 及明确的请求者 QQ 白名单；空白名单只适用于只读工具 |
| 手动运行找不到 `run` | 是否使用命名导出 `export async function run(...)` |
| 插件收到消息却未回复 | 返回值是否为 `reply`；清单权限、账号启动状态、QQ 身份、群读取/发送及冷却时间 |
| 戳一戳没有执行工具 | 单独戳一戳只唤醒／问候，不代表外部操作请求；固定命令插件的 `onMessage` 只接收群文字消息 |
| 参数修改后仍是旧效果 | 是否只保存了待应用参数；源码变更是否重新安装快照 |
| 提示旧任务已取消 | 应用配置、撤销权限或账号退出后，旧执行结果不能继续使用 |
| 超时或依赖找不到 | 减少同步阻塞工作；使用自包含相对 ESM 导入；确保超时内完成所有等待的操作 |
| 无法卸载 | 检查其他账号的已应用与待应用启用状态，以及尚未结束的执行 |

开发调试使用独立资料目录和模拟 OneBot，避免把真实账号消息作为测试夹具。发布插件前至少检查：安装不执行代码、手动执行、命令未命中返回 `null`、工具参数校验、群与请求者授权拒绝、写工具拒绝、执行中撤销、超时、卸载与重新导入。模型测试使用隔离的工具调用夹具；文本示例通过不能代替具体外部服务的真实联调。
