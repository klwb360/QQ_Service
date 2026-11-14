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

## 设计参考：qq-dsh-bridge

下列 MIT 许可仅对应所列旧固定版本。后续用户提供的0.2.2-rc1源码归档，包内许可为PolyForm Noncommercial 1.0.0；它只用于静态阅读，未复制、修改或随本项目分发，不能沿用下列MIT许可。两份材料的来源、归档摘要和实现区别见 [只读审查说明](docs/BRIDGE_DESIGN_REVIEW.md)。

开发分支的群聊表达与发送节奏设计参考 [NoMindSama/qq-dsh-bridge](https://github.com/NoMindSama/qq-dsh-bridge)，审查固定提交为 [`5f3f4ffa70f444a612e8e02b740cd1dc1d6f663d`](https://github.com/NoMindSama/qq-dsh-bridge/tree/5f3f4ffa70f444a612e8e02b740cd1dc1d6f663d)（2026-10-30；2026-11-14 核查时仍为其 `main`）。参考内容包括明确数组分条、消息间隔限制、逐条权限检查，以及人格习惯与发送协议分离。实际源码证据及本项目的实现区别见 [自由群聊指南](docs/SOCIAL_CHAT.md#设计参考)。

QQ_Service 在现有框架中独立重实现相关设计，没有复制此次审查涉及的上游发送源码，也没有因此引入 DSH、`@snowluma/sdk` 或 `@snowluma/mcp`。以下保留上游版权和 MIT 许可声明作为来源记录；该许可不覆盖 SnowLuma 等独立第三方组件。上游 [LICENSE 正文](https://github.com/NoMindSama/qq-dsh-bridge/blob/5f3f4ffa70f444a612e8e02b740cd1dc1d6f663d/LICENSE#L1-L35) 后另附第三方说明，GitHub 的自动许可标签不能替代正文。

```text
MIT License

Copyright (c) 2026 Derpyu520 and qq-bridge / QSH contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## 用户按需另行安装或访问

- **NapCatQQ / NapCat Docker**：未捆绑于本项目源码或 EXE。应用安装器引用固定官方 Docker 镜像；原生 Windows 路径由用户从上游单独下载和安装。许可证见 [NapCatQQ LICENSE](https://github.com/NapNeko/NapCatQQ/blob/main/LICENSE)，商业用途与分发限制需单独遵守。
- **OpenAI Codex CLI（历史版本）**：旧版本曾支持用户按需安装；v0.7.0 已移除此安装与订阅登录能力，不读取或自动删除旧认证资料。历史源码和许可证见 [OpenAI Codex](https://github.com/openai/codex)。
- **Docker Desktop**：应用内 Docker 部署路径需要用户单独安装和启用；原生 NapCat 直连不依赖它。遵循 [Docker Desktop 条款](https://www.docker.com/legal/docker-subscription-service-agreement/)。
- **OpenAI API**：网络服务，使用用户自行创建的项目 API Key，受账户权限、适用额度及 [OpenAI 服务条款](https://openai.com/policies/services-agreement/) 约束；额度激活见 [专用 API 配置](docs/OPENAI_API_SETUP.md)。
- **DeepSeek API**：网络服务，需要用户提供自己的 API Key，遵循 [DeepSeek 平台](https://platform.deepseek.com/) 的服务条款与费用规则。

QQ_Service 未修改或重新许可这些上游项目。发布或商业使用前应检查上游最新许可与服务条件。
