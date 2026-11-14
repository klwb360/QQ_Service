# SnowLuma 外部实验连接端审查记录

更新日期：2026-11-13。当前开发分支已提供**用户自行运行的 SnowLuma 2.4.2／OneBot v11 协议适配**；Windows 动态安全检查及真实 QQ 验收仍未完成。

`available:true` 表示 QQ_Service 可以连接符合协议要求的外部实例，**不表示 SnowLuma 原生组件已被判定安全**。当前声明为 `verified:false`、`externalRuntime:true`、`runtimeManaged:false`，`windowsDynamic` 和 `liveQQ` 均为 `pending`。QQ_Service 不下载、安装、启动或更新 SnowLuma，不随自己的 EXE 或 Docker 镜像分发其本体、SDK及原生组件。

2026-11-11 的记录只完成静态检查，当时入口关闭；本次在固定来源复核、公开层构建和协议夹具验证后，增加外部手动连接方式。以下区分已经验证的内容与尚待验证的运行行为，不能用模拟协议或可读源码代替外部程序的安全验收。

## 固定来源与候选

| 来源 | 本次复核 | 结论 |
| --- | --- | --- |
| [TomyJan/SnowLuma](https://github.com/TomyJan/SnowLuma/releases/tag/v2.4.2) | 2026-11-09 建立的复制镜像；本次读取的 main 仍为下述提交，未见该日期之后的 push | 本次固定参考样本，不认定为官方继任者或持续维护分支 |
| [XingYunStar/snowluma](https://github.com/XingYunStar/snowluma/releases/tag/v2.4.2) | main 同一提交；先前核对的 Windows 包摘要与 TomyJan 一致 | 来源交叉核对；额外 Docker 产物不在该结论内 |
| [JosephTian876/SnowLuma](https://github.com/JosephTian876/SnowLuma/releases/tag/v2.4.2) | main 同一提交；Windows ZIP 摘要与 TomyJan 不同 | 保留先前静态内容比较，不能仅按归档差异判定恶意 |
| [zhx57/SnowLuma](https://github.com/zhx57/SnowLuma) | 基于 v2.3.3 的 Docker 改动，包含不同原生模块 | 不是本次 Windows 参考样本 |
| [DandanLLab/SnowCatQQ](https://github.com/DandanLLab/SnowCatQQ/tree/5fe48676bcaf3bddea0b6f3e6ce302a8e51c6bc1) | 新活跃候选；该提交将默认协议改为 OneBot12；README 的 MIT 标识与实际受限 LICENSE 不一致 | 另行审查，不能当成旧 SnowLuma 的透明替换或已审核来源 |

前三个镜像 main 本次均核到同一提交，没有因此获得新的运行安全证据。原 `SnowLuma/SnowLuma` 在先前审查时返回404，本次未核实下架原因；星数、fork 标识和发布者介绍不能单独证明来源可信。

固定基线：

- 仓库：`TomyJan/SnowLuma`，版本 `v2.4.2`。
- 提交：`f2ea3354f8bbe8672cbb4ae6a2b4e1fbeff44faf`。
- 源码树：`4a6e4331f2e69538ab29c9430cc512809792e4d9`。
- `pnpm-lock.yaml` SHA256：`8eda72cd63748e155dd8a3d3e3c8d46f25c53dd137a15ebdee8e935636832bc4`。
- Windows 完整 ZIP SHA256：`0912926c5e73260f35b000278a8658493fc9452f36782c32fa86f0e825bad81a`。
- Windows lite ZIP SHA256：`14c6f137196d5f556e6c601a880ee8aa238ffaf4227696848a146209f96d0f31`。

本次 GitHub 发行资产元数据与上述包摘要一致。Lite 包在先前审查中实际下载并读取归档核对，但未安装或运行；本次实际构建从固定源码产生。完整输入、构建与输出摘要见[审计证据 JSON](audits/snowluma-2.4.2-review.json)，步骤见[公开部分构建指南](SNOWLUMA_BUILD.md)。摘要相同只能证明所比较的字节相同，不能证明闭源组件的行为。

## 静态审查与许可证

- 启动脚本先检查 Node 版本，再运行 `index.mjs`。固定版本要求 Node `^24.22.1 || >=26.12.1`，pnpm `11.25.0`。QQ_Service 当前附带的 Windows Node `24.19.0` 不满足要求，不可直接拿来启动 SnowLuma。
- 新建 OneBot 配置默认监听本机 HTTP `3000`、WS `3001`，各自生成随机 Token。旧配置省略 host 时可能归一化为 `0.0.0.0`，仍须检查实际保存的监听范围。WebUI 默认 `127.0.0.1:5099`；WebUI 密码与 HTTP／WS Token 是三种不同凭据。
- WebUI 正常认证使用加盐 scrypt，开发模式存在固定口令，接入时不得使用 `SNOWLUMA_DEV_MODE=1`。Hook 自动加载默认关闭，但环境变量可覆盖；不应继承其他应用的开发或自动注入设置。
- 原更新源仍指向先前不可访问的原仓库，默认 `auto` 路径含公共代理；摘要、大小和归档路径检查不等于独立发布者证明。`updateSource.mode:direct` 只是直连选择，**不是关闭更新**。本次没有自动跟随新版本。
- SnowLuma 具有自己的 `#sl` 状态回复及 Webhook／SMTP 通知。其回复不经过 QQ_Service 的发送权限门，按下文独立关闭；没有完成捆绑包或原生组件的动态外联验证。
- LICENSE 明确是源码可见、非 OSI 的非商业许可，并限制公开修改和衍生项目；native 为专有组件。EULA 对将原生组件并入第三方安装包、Docker 或自动部署提出书面授权要求。QQ_Service 保持独立协议实现，不把上游组件重新标为 MIT 或随产品发布。

固定源码未包含 SnowLuma、WebSocket、FFmpeg 原生组件的完整构建来源；Vite 构建实际复制预编译文件，SQLite 也取自锁定的 `@appthreat/sqlite3@9.1.0` 预编译包。可以验证公开 JS 层及固定 native 输入，不能称为完整源码重建。先前读取的五个 Windows 原生文件未发现嵌入 Authenticode 签名；本次未建立发行包与公开成功 CI 之间的完整溯源。

## 实际公开层构建结果

本次在独立个人研究目录中完成冻结依赖安装：使用官方 npm 覆盖上游 `.npmrc` 的镜像，pnpm `11.25.0`、`--frozen-lockfile --ignore-scripts`。589条锁定条目的供应链策略检查通过，不等于每条依赖都完成了人工安全审计。上游默认允许 esbuild 和 Parcel watcher 安装脚本，因此不能笼统称所有默认安装都没有脚本。

编译使用已有 Node `24.22.2` 容器，非 root、禁网、只读根文件系统，仅挂载独立构建目录及审计脚本，不挂 QQ 数据、主项目密钥库或模型 Key。Proton、core、WebUI 类型检查、WebUI 构建四阶段连续三次成功，产物为 Windows x64 目标的71文件、25,150,426字节；1367个固定源文件及锁文件均无改动。布局检查与 `node --check` 通过，SnowLuma 服务和 QQ 原生组件未运行。

三次输出中70文件逐字相同，只有 `index.mjs` 不稳定。对第二、第三份 bundle 的纯静态 AST 比较显示：5904个无重名顶层函数的名称／正文摘要集合一致，其余2946条顶层语句内容及顺序一致，554个函数声明位置变化。因此不能宣称字节级可复现或完整语义等价证明。较早对 TomyJan／Joseph 发行包的静态比较也曾发现声明顺序差异；两个结论分别保留，不能把本次 AST 数量当作对发行包的新测量。

编译过程加装正常 `process.dlopen` 路径的拒绝守卫，只允许构建工具依赖的 native，拒绝 SnowLuma／QQ／SQLite 运行时 native。三次共记录15次构建工具加载，没有受保护组件的加载尝试。该守卫与已审入口提供构建隔离证据，不是对任意原生加载机制的完备证明。

本次输出的五个 Windows native 摘要均与既有固定样本一致：

| 路径 | SHA256 |
| --- | --- |
| `native/snowluma-win32-x64.dll` | `61de2ef3c147f34c3c9115f6f912f5fd1c73c2cc56c86fad786809b2b7742371` |
| `native/snowluma-win32-x64.node` | `8ebc683922c93f6377834886624bc2fa127c74a342eb78a4503b684da8a0c22e` |
| `native/websocket-win32-x64.node` | `6e71a14b1d28a6259bc1fb52dea2bdf13f100b326c04b14132f7a53b64fe9383` |
| `native/ffmpeg/ffmpegAddon.win32.x64.node` | `80a4dfbb170f093f4a64fe241b8583fb630c58219100cad7a3cad798f71864db` |
| `native/sqlite/prebuilds/win32-x64/@appthreat+sqlite3.node` | `e8898fd92aebbecdc946c14e2a9f9c481946de3cbde1ebc3c647c02892640598` |

这些文件没有加入 QQ_Service 仓库、EXE、Docker 或下载产物。

## 外部手动接入

1. 先按适用许可自行准备固定 SnowLuma，在独立目录、兼容 Node 下运行，并按其界面接入目标 QQ。QQ_Service 只提供外部连接，不承担 SnowLuma 的安装、进程注入或升级。
2. 在外部 SnowLuma 为目标 QQ 配置本机 HTTP 动作端和 Event／Universal WS 事件端，分别保存两个 Token。多 QQ 需为每个账号选择其独立端口及凭据，不混接一个账号的 HTTP 与另一个账号的 WS。
3. 禁用该外部实例的 `statusCommand.enabled`（默认 `#sl` 回复），保持 `historySync.enabled:false`、`notifications.channelIds:[]`；关闭全局通知渠道、Hook 自动加载和开发模式，按需手动选择测试 QQ 进程。不要将 QQ_Service 模型 Key 或密钥库传入外部程序。
4. 在「账号控制 → 连接 QQ」选择“SnowLuma · 外部实验接入”。填写事件 WS 地址（常见 `ws://127.0.0.1:3001`）与 WS Token、HTTP 地址（常见 `http://127.0.0.1:3000`）与 HTTP Token；管理页常见 `http://127.0.0.1:5099`。以本账号实际配置为准。
5. 保存并应用，测试连接。应用核对 HTTP 登录 QQ、`get_version_info` 的 `SnowLuma / 2.4.2-node / v11`、HTTP `get_status` 的在线／good 状态，以及 WS `self_id` 和在线状态。只有 WS 已连上或 HTTP 可访问均不足以完成验证；Api-only WS 不能代替事件连接。
6. 核对群读取／发送范围后显式启动并释放权限。切换连接端仍恢复只读，不会自动转移原有运行任务或重试未知投递。模块页提供固定来源说明和打开管理页，不显示自动安装／启动按钮。

版本握手核对的是外部端点报告的协议身份，不是对外部二进制来源的加密证明。与 NapCat 切换不改变稳定 profile、实际 QQ、人格和记忆身份；新事件及动作引用则绑定连接端和每次连接代。旧消息继续可读，缺来源的旧原始编号或其他连接代的编号不能用于引用、回应、转发、撤回，避免同一数字在两个连接端指向不同消息。

## 尚待完成的运行验收

以下仍为 `pending`，外部手动适配可用不代表这些项目已完成：

- 全新 Windows 隔离环境中记录进程、文件／注册表／启动项变化及实际外联，不提供主账号、模型 Key 或其他资料。
- 解释非必要下载、提权、持久化和通知行为，核对非开发模式、监听范围、独立 Token、固定文件及更新状态。
- 独立测试 QQ 的真实登录、HTTP／WS 身份与在线一致性、18项业务工具的实际客户端效果，以及断线、旧事件回放、重连和切回 NapCat。
- 记录系统、外部程序完整摘要、运行观察与未覆盖范围。原生安全性、QQ风控或不同 fork 的兼容性均不能由协议 fixture 保证。

实际自动测试与当前构建结果见[验证记录](VALIDATION.md)。

## 固定来源参考

- [LICENSE](https://github.com/TomyJan/SnowLuma/blob/f2ea3354f8bbe8672cbb4ae6a2b4e1fbeff44faf/LICENSE) · [EULA](https://github.com/TomyJan/SnowLuma/blob/f2ea3354f8bbe8672cbb4ae6a2b4e1fbeff44faf/EULA.md) · [隐私说明](https://github.com/TomyJan/SnowLuma/blob/f2ea3354f8bbe8672cbb4ae6a2b4e1fbeff44faf/PRIVACY.md)
- [Node 要求](https://github.com/TomyJan/SnowLuma/blob/f2ea3354f8bbe8672cbb4ae6a2b4e1fbeff44faf/package.json) · [启动脚本](https://github.com/TomyJan/SnowLuma/blob/f2ea3354f8bbe8672cbb4ae6a2b4e1fbeff44faf/packages/runtime/launcher.bat)
- [OneBot 默认配置](https://github.com/TomyJan/SnowLuma/blob/f2ea3354f8bbe8672cbb4ae6a2b4e1fbeff44faf/packages/onebot/src/config.ts) · [WebUI 认证](https://github.com/TomyJan/SnowLuma/blob/f2ea3354f8bbe8672cbb4ae6a2b4e1fbeff44faf/packages/core/src/webui/auth.ts)
- [更新源](https://github.com/TomyJan/SnowLuma/blob/f2ea3354f8bbe8672cbb4ae6a2b4e1fbeff44faf/packages/core/src/update/sources.ts) · [下载校验](https://github.com/TomyJan/SnowLuma/blob/f2ea3354f8bbe8672cbb4ae6a2b4e1fbeff44faf/packages/core/src/update/download.ts)
- [原生输入复制](https://github.com/TomyJan/SnowLuma/blob/f2ea3354f8bbe8672cbb4ae6a2b4e1fbeff44faf/packages/core/vite.config.ts) · [SQLite 输入](https://github.com/TomyJan/SnowLuma/blob/f2ea3354f8bbe8672cbb4ae6a2b4e1fbeff44faf/packages/sqlite/src/vite.ts)
- [SnowCatQQ 固定候选的实际 LICENSE](https://github.com/DandanLLab/SnowCatQQ/blob/5fe48676bcaf3bddea0b6f3e6ce302a8e51c6bc1/LICENSE)
