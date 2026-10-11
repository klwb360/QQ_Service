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

Electron 构建工具仅作为开发依赖，依其许可证使用。发布源码包含锁定依赖元数据；构建时从上游下载运行环境。

## 用户按需另行安装或访问

- **NapCatQQ / NapCat Docker**：未捆绑于本项目源码或 EXE。安装器引用固定官方 Docker 镜像，许可证见 [NapCatQQ LICENSE](https://github.com/NapNeko/NapCatQQ/blob/main/LICENSE)。其商业用途与分发限制需要单独遵守。
- **OpenAI Codex CLI**：未捆绑于 EXE，通过官方 `@openai/codex@0.149.1` npm 包按需安装。源码和许可证见 [OpenAI Codex](https://github.com/openai/codex)。本人 ChatGPT 订阅授权及推理受相应服务条款与账户额度约束。
- **Docker Desktop**：需要用户单独安装和启用，遵循 [Docker Desktop 条款](https://www.docker.com/legal/docker-subscription-service-agreement/)。
- **DeepSeek API**：网络服务，需要用户提供自己的 API Key，遵循 [DeepSeek 平台](https://platform.deepseek.com/) 的服务条款与费用规则。

QQ_Service 未修改或重新许可这些上游项目。发布或商业使用前应检查上游最新许可与服务条件。
