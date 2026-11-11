# Third-party notices

QQ_Service 的自有源码采用 [MIT](LICENSE) 许可证。这个许可不替代以下组件的许可证。

## 随 Windows EXE 分发

| 组件 | 本版版本 | 上游与许可证 |
| --- | --- | --- |
| Electron | 44.7.0 | [Electron](https://github.com/electron/electron)，MIT；分发包保留 `LICENSE.electron.txt` |
| Chromium 及其依赖 | 由 Electron 44.7.0 提供 | [Chromium](https://www.chromium.org/)，BSD 及各依赖许可证；分发包保留 `LICENSES.chromium.html` |
| Node.js | 24.19.0 | [Node.js](https://github.com/nodejs/node)，MIT 及捆绑依赖许可证；保留 `resources/runtime/LICENSE` |
| npm | 11.17.0 | [npm CLI](https://github.com/npm/cli)，Artistic License 2.0 及依赖许可证；保留 npm 包及其依赖的 LICENSE 文件 |
| ws | 8.22.0 | [ws](https://github.com/websockets/ws)，MIT；保留 `resources/backend/node_modules/ws/LICENSE` |

开发分支的 MCP 功能另附带 `@modelcontextprotocol/sdk` 1.32.2、`ajv` 8.20.0 和 `ajv-formats` 3.0.1，均为 MIT。Windows 打包按锁文件复制完整生产依赖及其许可证文件，详见 `resources/backend/node_modules/`；已发布 v0.8.0 不含这些新增依赖。第三方 MCP 服务由用户另行配置，其代码、依赖与服务条款需分别遵守。

Electron 构建工具仅作为开发依赖，依其许可证使用。发布源码包含锁定依赖元数据；构建时从上游下载运行环境。

## 用户按需另行安装或访问

- **NapCatQQ / NapCat Docker**：未捆绑于本项目源码或 EXE。应用安装器引用固定官方 Docker 镜像；原生 Windows 路径由用户从上游单独下载和安装。许可证见 [NapCatQQ LICENSE](https://github.com/NapNeko/NapCatQQ/blob/main/LICENSE)，商业用途与分发限制需单独遵守。
- **OpenAI Codex CLI（历史版本）**：旧版本曾支持用户按需安装；v0.7.0 已移除此安装与订阅登录能力，不读取或自动删除旧认证资料。历史源码和许可证见 [OpenAI Codex](https://github.com/openai/codex)。
- **Docker Desktop**：应用内 Docker 部署路径需要用户单独安装和启用；原生 NapCat 直连不依赖它。遵循 [Docker Desktop 条款](https://www.docker.com/legal/docker-subscription-service-agreement/)。
- **OpenAI API**：网络服务，使用用户自行创建的项目 API Key，受账户权限、适用额度及 [OpenAI 服务条款](https://openai.com/policies/services-agreement/) 约束；额度激活见 [专用 API 配置](docs/OPENAI_API_SETUP.md)。
- **DeepSeek API**：网络服务，需要用户提供自己的 API Key，遵循 [DeepSeek 平台](https://platform.deepseek.com/) 的服务条款与费用规则。

QQ_Service 未修改或重新许可这些上游项目。发布或商业使用前应检查上游最新许可与服务条件。
