# 开发与发布

[返回首页](../README.md) · [功能实现与架构](ARCHITECTURE.md) · [验证记录](VALIDATION.md)

## 源码运行

需要 Node.js 24。仪表盘使用原生 HTML/CSS/JavaScript，后台使用 Node HTTP、`node:sqlite` 和 `ws`，不需要额外的前端构建服务。

```bash
git clone https://github.com/klwb360/QQ_Service.git
cd QQ_Service
npm ci --ignore-scripts
npm start
```

浏览器打开 `http://127.0.0.1:3210`。旧 `start.cmd` / PowerShell 入口保留供 Windows 源码运行，固定打开 3210。

## 检查与测试

```bash
npm run check
npm test
```

常规测试使用模拟 OneBot 与模型，覆盖配置应用与失败恢复、工作群只读、本人 GPT 权限、上下文隔离、收藏账号来源、HTTP 请求保护和后台生命周期。测试范围与可选 Electron 交互检查见 [验证记录](VALIDATION.md)。不需要真实 QQ 登录或模型额度。

## 桌面开发与 Windows 打包

在 Windows 上：

```bash
npm ci
npm run prepare:windows
npm run desktop
```

生成便携 EXE：

```bash
npm run build:exe
```

产物在 `dist/QQ_Service-0.2.1-Windows-x64.exe`。`npm run build:installer` 提供可选 NSIS 安装包目标；v0.2.1 Release 交付便携 EXE。

构建脚本从 Node.js 官方网站下载固定版本并校验固定 SHA-256。桌面壳放在 ASAR，后台和自带 Node/npm 放在独立 resources；只打包后台生产依赖，不打包本地配置、凭据或历史。

`scripts/verify-packaged.cjs` 在打包后检查 Windows x64 PE、桌面 ASAR、Node/npm、后台/UI、ws 依赖及产品版本，缺少资源时构建失败。

| 依赖 | 当前固定版本 |
| --- | --- |
| Node.js（Windows 自带运行时） | 24.19.0 |
| Electron | 44.7.0 |
| electron-builder | 26.15.3 |
| ws | 8.22.0 |
| NapCat（外部模块） | v4.18.37，首次安装后记录镜像摘要 |
| Codex CLI（外部模块） | 0.149.1 |

如果开发安装使用了 `npm ci --ignore-scripts`，桌面运行前还需执行 `node node_modules/electron/install.js`，下载 Electron 开发运行环境。

## 环境变量

| 变量 | 用途 |
| --- | --- |
| `QQ_DASHBOARD_DATA_DIR` | 覆盖用户数据目录；调试时建议使用独立临时目录 |
| `QQ_DASHBOARD_PORT` | 浏览器源码模式的后台端口，默认 3210 |
| `QQBRIDGE_NODE_RUNTIME` | 未打包桌面模式使用的 Node.js 24 绝对路径 |
| `QQ_DASHBOARD_NPM_CLI` | 未打包开发模式使用的 npm CLI 绝对路径 |

正式 EXE 使用附带运行时，桌面后台选择随机空闲本机端口。Linux 桌面开发需要通过后两个变量指定本机 Node 24 和 npm CLI，并准备显示服务；该模式不替代 Windows 实机验收。

## GitHub Actions 与 Release

[Windows application](https://github.com/klwb360/QQ_Service/actions/workflows/windows.yml) 在推送 `main`、提交 PR 或手动触发时，执行依赖安装、语法检查、自动测试、Windows x64 EXE 构建和 SHA256 生成。

推送 `v*` 标签时，标签必须与 `package.json` 版本一致。Windows 构建成功后，独立发布任务创建 Release，并上传 EXE 和校验文件。第三方 Actions 固定到提交 SHA；本地打包命令使用 `--publish never`。

发布新版本时更新 `package.json` 与锁文件、界面版本、下载说明和验证记录，再提交匹配的版本标签。只有标签发布流程会更新正式 Release；普通文档提交不会替换已有 EXE。

## 修改或新增功能

现有代码入口及不可破坏的权限规则见 [功能实现与架构](ARCHITECTURE.md)。新增模块需要固定安装动作与状态检查；新增应用需要平台适配器和数据迁移，当前不能只在界面填写地址就接入任意平台。
