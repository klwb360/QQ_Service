# SnowLuma 公开部分构建与证据

[接入与审查记录](SNOWLUMA_SECURITY_REVIEW.md) · [验证记录](VALIDATION.md) · [固定证据 JSON](audits/snowluma-2.4.2-review.json)

本页记录个人、非商业研究环境中的实际构建。公开部分已成功编译；SnowLuma 服务、QQ hook和登录没有运行。QQ_Service 使用自己实现的 OneBot 客户端，连接用户自行运行的外部实例；第三方产物不加入本仓库、EXE、Docker或GitHub构建下载。

## 固定输入和构建边界

| 输入 | 本次使用 |
| --- | --- |
| 源码 | `TomyJan/SnowLuma@f2ea3354f8bbe8672cbb4ae6a2b4e1fbeff44faf` |
| Git tree | `4a6e4331f2e69538ab29c9430cc512809792e4d9` |
| 锁文件 SHA256 | `8eda72cd63748e155dd8a3d3e3c8d46f25c53dd137a15ebdee8e935636832bc4` |
| 依赖安装 | Node24.22.1、pnpm11.25.0，官方 npm，冻结锁，禁用安装脚本 |
| 编译 | Linux容器内Node24.22.2，目标 `win32-x64` |
| 隔离 | 非root、禁网、只读根目录、丢弃capabilities、2CPU／2GiB限制，只有临时源码及审计脚本挂载 |
| 成果 | Proton、core、WebUI类型检查、WebUI构建四阶段，连续三次全部成功 |

上游要求 Node `^24.22.1 || >=26.12.1`；QQ_Service 当前随包的 Node24.19.0 不可用于启动这版 SnowLuma。个人构建输出不含 `node.exe`，运行时需另外准备满足要求的 Node。版本满足也不代表闭源组件已完成动态安全验证。

源码中的 `packages/runtime/native` 含预编译 SnowLuma、WebSocket、FFmpeg；SQLite输入来自锁定的 `@appthreat/sqlite3@9.1.0`。构建仅复制这些输入，没有它们的完整公开源码重建步骤。上游的源码可见非商业许可、原生专有条款与EULA仍适用；不能把此构建视为可按MIT分发的第三方安装包。

## 准备独立工作区

先取得固定源码并核对提交、树及锁摘要，保留一份不修改的参考副本；另从固定Git树建立一次性构建副本。不使用滚动main或latest依赖，不提供QQ登录、主项目数据目录、密钥库、模型Key或其他私人资料。

在副本中用固定pnpm执行冻结、禁脚本安装。本次明确覆盖了上游 `.npmrc` 的registry镜像，使用官方源：

```sh
pnpm install --frozen-lockfile --ignore-scripts --registry=https://registry.npmjs.org --store-dir=/tmp/snowluma-pnpm-store --fetch-retries=0
```

此处store路径是本次一次性Linux环境示例，其他环境用自己的临时目录。589条锁定条目通过pnpm供应链策略检查，实际安装488包；这不等于所有传递依赖已完成人工审计。默认pnpm workspace允许esbuild／Parcel watcher安装脚本，故必须保留禁脚本步骤，再显式调用已审构建工具。

## 离线执行公开层编译

本次将准备好的副本挂入已存在的本地Node容器；编译子进程使用明确的干净环境，只设置构建所需PATH、语言、缓存及下列目标参数，不继承模型Key、应用vault或开发模式设置：

```text
SNOWLUMA_TARGET=win32-x64
BUILD_WEBUI=true
```

四个实际任务对应上游package scripts，但直接执行已安装的编译器入口，`shell:false`。这样避免pnpm11因容器映射改变绝对路径而隐式重新安装依赖。编译阶段没有registry访问。

| 顺序 | 工作目录（相对第三方源码根） | 以 `node` 调用的入口及参数 |
| --- | --- | --- |
| 1 | `packages/proton` | `node_modules/tsup/dist/cli-default.js src/index.ts --format esm --out-dir dist --target node24 --external typescript --external vite` |
| 2 | `packages/core` | `node_modules/vite/bin/vite.js build` |
| 3 | `packages/webui` | `node_modules/typescript/bin/tsc -b` |
| 4 | `packages/webui` | `node_modules/vite/bin/vite.js build` |

Proton必须先产生编译插件；core输出根 `dist`，WebUI随后输出 `dist/client`。直接运行core构建并不等于包含管理页面。上游 `build:all` 还构建SDK／MCP／UI包，QQ_Service外部协议适配不需要引入这些包。

审计预加载器在编译器及其Node子进程中拦截正常 `process.dlopen` 路径，拒绝加载SnowLuma、其运行时WebSocket、FFmpeg和SQLite；允许编译工具自己的Rollup、Rolldown、LightningCSS和Tailwind Oxide。三次只观察到15次构建工具加载，没有被保护运行时组件的加载尝试。该记录不是对任意原生加载途径的完整证明。

## 实际验证结果

每次四阶段约19–20秒，均退出0。Vite的插件计时与较大chunk提示为非失败警告。原静态布局检查和 `node --check dist/index.mjs` 通过，它们不启动应用。

- 输出目标：Windows x64。
- 输出：71个文件，25,150,426字节。
- 固定1367个Git源输入逐文件SHA一致；锁和源码均未改动。
- 五个Windows native摘要与既有审查基线一致，仍是预编译输入。
- 没有把QQ_Service主项目、用户资料或密钥放入构建容器，也没有触碰原5个数据卷。

当前第三次构建的 `index.mjs` SHA256为 `cfb69ef2f7dba8fad798ada448ed01f5e5297ccd787ad3233e26f4b2613997cb`。完整输出摘要在[证据附件](audits/snowluma-2.4.2-review.json)，不是官方下载包的替代摘要。

## 非字节级可复现的部分

三次输出中70文件逐字一致，`index.mjs`的字节摘要不同。纯静态解析第二、第三份bundle得到：

| 比较项 | 结果 |
| --- | --- |
| 大小 | 均12,446,342字节 |
| 顶层函数 | 5904个，无重名 |
| 排序后的函数名称／正文SHA集合 | 相同 |
| 其他顶层语句 | 2946条，内容及顺序SHA相同 |
| 函数声明位置 | 554处变化 |

这解释了本次第二／第三份产物中观察到的函数声明排序差异，**不宣称字节级可复现、完整语义等价或原生源码重建**。未通过删除校验或替换样本来掩盖差异。

## 构建后的接入仍需单独验证

本次是Linux交叉目标编译，没有实际启动Windows程序。外部管理实例需由用户按许可自行准备，核对其Node、版本、Token、监听和QQ身份后，参照[外部手动接入](SNOWLUMA_SECURITY_REVIEW.md#外部手动接入)。Windows隔离运行、真实QQ效果和闭源native行为仍为待验。

上游产物包含EULA、PRIVACY和SQLite许可，但core复制清单没有根LICENSE；这份个人研究输出不是第三方分发包，不能直接塞入QQ_Service发布。今后任何获得许可的分发仍应核对完整许可文本和授权条件。
