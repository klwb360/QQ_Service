# SnowLuma 实验连接端审查记录

审查日期：2026-11-11。**当前状态：部分静态审查完成，Windows 隔离运行检查未完成；连接入口保持禁用。**

这份记录不等于恶意软件检测报告，也不保证 QQ 账号可用性。源码可读、镜像哈希相同以及固定版本均不能证明闭源组件安全。QQ_Service 不随 EXE 或容器分发 SnowLuma 原生组件，不自动下载、安装或更新未知 fork。

## 候选与来源

| 候选 | 本次发现 | 处理 |
|---|---|---|
| [TomyJan/SnowLuma](https://github.com/TomyJan/SnowLuma/releases/tag/v2.4.2) | 2026-11-09 创建的复制镜像；main 为下述固定提交；有 Windows 归档和摘要文件 | 主要待验证样本，不能认作官方继任者 |
| [XingYunStar/snowluma](https://github.com/XingYunStar/snowluma/releases/tag/v2.4.2) | 源码树和 Windows 完整/lite 包摘要与 TomyJan 一致 | 交叉核对来源；其额外 Docker 产物不纳入此结论 |
| [JosephTian876/SnowLuma](https://github.com/JosephTian876/SnowLuma/releases/tag/v2.4.2) | 源码提交相同，Windows ZIP 摘要不同 | 已额外比较 lite 内容，见下文；不直接据此判定恶意 |
| [zhx57/SnowLuma](https://github.com/zhx57/SnowLuma) | 导入 v2.3.3 后增加 Docker 改动，包含不同原生模块，未见 Releases | 不作为本次 Windows 默认候选 |

原 `SnowLuma/SnowLuma` 仓库在审查时返回404；本次没有核实其下架原因。GitHub 的 fork 字段、星数和发布者自述均不能单独证明来源可信。

固定基线：

- 仓库：`TomyJan/SnowLuma`
- 版本：`v2.4.2`
- 提交：`f2ea3354f8bbe8672cbb4ae6a2b4e1fbeff44faf`
- 源码树：`4a6e4331f2e69538ab29c9430cc512809792e4d9`
- Windows 完整 ZIP SHA-256：`0912926c5e73260f35b000278a8658493fc9452f36782c32fa86f0e825bad81a`
- Windows lite ZIP SHA-256：`14c6f137196d5f556e6c601a880ee8aa238ffaf4227696848a146209f96d0f31`

完整包摘要来自 GitHub 资产元数据；lite 包另经本次实际下载、读取 ZIP 内容并计算摘要核对，**未执行或安装**。

## 已完成的静态检查

- 启动脚本检查 Node 版本后运行 `index.mjs`，该脚本中未见下载或提权行为；已查 manifest 未见安装生命周期下载脚本。尚未完成全部传递依赖审计。
- WebUI 认证使用加盐 scrypt，正常初始化使用随机口令；开发模式存在固定口令，因此不能用于实际接入。默认 WebUI 监听 `127.0.0.1:5099`，仍需核对用户实际配置。
- 更新源仍指向已不可访问的原仓库，源选择包含公共代理。下载过程有摘要、大小和归档路径校验，但其元数据本身缺少独立发布者证明；不得自动跟随未经审查的新版本。
- 构建直接复制预编译原生模块，无法仅用公开 TypeScript 源码完整重建这些组件。已读 Windows lite 包中的五个 DLL/NODE 没有嵌入 Authenticode 签名。
- 镜像内未找到与该固定提交发行包对应的完整成功构建溯源，不能声称包由公开 CI 可复现地产生。
- 存在可配置的 Webhook/SMTP 通知功能。隐私说明提及未来遥测且称公开版尚未包含；仅凭当前源码搜索不能排除整个捆绑包或原生组件的外联行为。

TomyJan 与 Joseph 的 lite 包共71个普通文件，70个逐字相同，五个原生模块也相同。唯一不同的 `index.mjs` 大小、行数一致；逐行集合、5649个顶层函数块的名称和正文哈希集合、去掉这些函数块后的剩余文本均一致。静态比较表现为顶层函数声明顺序变化，未发现新增代码、域名或文件。这不替代完整语法分析、可复现构建或动态检查。

静态核对的原生文件 SHA-256：

| 路径 | SHA-256 |
|---|---|
| `native/snowluma-win32-x64.dll` | `61de2ef3c147f34c3c9115f6f912f5fd1c73c2cc56c86fad786809b2b7742371` |
| `native/snowluma-win32-x64.node` | `8ebc683922c93f6377834886624bc2fa127c74a342eb78a4503b684da8a0c22e` |
| `native/websocket-win32-x64.node` | `6e71a14b1d28a6259bc1fb52dea2bdf13f100b326c04b14132f7a53b64fe9383` |
| `native/ffmpeg/ffmpegAddon.win32.x64.node` | `80a4dfbb170f093f4a64fe241b8583fb630c58219100cad7a3cad798f71864db` |
| `native/sqlite/prebuilds/win32-x64/@appthreat+sqlite3.node` | `e8898fd92aebbecdc946c14e2a9f9c481946de3cbde1ebc3c647c02892640598` |

## 尚未完成的启用条件

1. 在全新 Windows 虚拟机快照中，先不提供 QQ 登录、模型密钥和其他账号资料，记录进程、文件/注册表/启动项变化及实际外联。
2. 解释全部新增下载、外发、提权或持久化行为；存在无法解释的异常即停止验证。
3. 核对非开发模式、本机监听、独立 HTTP/WS Token，关闭非必要通知外发；使用固定安装包，禁止未经复审的更新进入测试样本。
4. 使用独立测试 QQ 验证 HTTP 登录身份与 WS `self_id` 一致，以及文本、@、戳一戳、群列表、断线、回放去重和切回 NapCat。WS 已连接本身不代表 QQ 在线。
5. 记录测试系统、完整文件清单与摘要、外联清单、测试结果和残余风险，重新核对适用许可，再通过代码审查更新连接器准入状态。

当前 Linux 开发环境没有完成上述 Windows 动态验证，不能以本地 HTTP fixture 测试代替。生产准入由程序内固定审查状态控制；保存配置、修改前端或设置环境变量均不能将未审查后端变为可用。

## 接入与许可边界

SnowLuma 只承担 QQ 收发，模型 API、人格、记忆和插件仍由 QQ_Service 管理。其 HTTP Token 和 WS Token 可不同，不能混用，也不能使用 WebUI 密码替代。禁止将 QQ_Service 模型 API Key 传给 SnowLuma。

镜像保留的是源码可见非商业许可及 EULA，并非 MIT。尤其原生组件、自动部署和第三方分发存在额外授权条件；镜像的存在不产生新的许可权利。本版本不打包它的原生组件、不引入其 SDK，也不自动下载安装。真正开放实验功能前应重新检查当时适用的条款。

参考文件均固定于上述提交：

- [许可](https://github.com/TomyJan/SnowLuma/blob/f2ea3354f8bbe8672cbb4ae6a2b4e1fbeff44faf/LICENSE) · [EULA](https://github.com/TomyJan/SnowLuma/blob/f2ea3354f8bbe8672cbb4ae6a2b4e1fbeff44faf/EULA.md) · [隐私说明](https://github.com/TomyJan/SnowLuma/blob/f2ea3354f8bbe8672cbb4ae6a2b4e1fbeff44faf/PRIVACY.md)
- [启动脚本](https://github.com/TomyJan/SnowLuma/blob/f2ea3354f8bbe8672cbb4ae6a2b4e1fbeff44faf/packages/runtime/launcher.bat)
- [更新源](https://github.com/TomyJan/SnowLuma/blob/f2ea3354f8bbe8672cbb4ae6a2b4e1fbeff44faf/packages/core/src/update/sources.ts)
- [下载校验](https://github.com/TomyJan/SnowLuma/blob/f2ea3354f8bbe8672cbb4ae6a2b4e1fbeff44faf/packages/core/src/update/download.ts)
- [原生组件构建复制](https://github.com/TomyJan/SnowLuma/blob/f2ea3354f8bbe8672cbb4ae6a2b4e1fbeff44faf/packages/core/vite.config.ts)
