# Docker 运行 QQ_Service

Docker 运行 Node.js 服务端、网页仪表盘、账号任务、人格和记忆存储。浏览器访问仪表盘即可使用，Windows EXE 仍可单独使用。Electron 桌面窗口、托盘和 Windows 程序选择器不在容器中运行。

QQ 连接端独立运行。第一版容器不会安装、启动或停止宿主机 NapCat，也不会挂载 Docker socket。SnowLuma 仍受实验功能安全检查限制，部署到 Docker 不会自动解锁。

## 启动

安装 Docker Desktop（Linux containers）或 Docker Engine 和 Compose 插件，在仓库根目录运行：

```sh
docker compose up -d --build
```

打开 <http://127.0.0.1:8787>。初次运行账号列表为空，在账号控制中创建账号并完成配置。

```sh
docker compose ps
docker compose logs --tail=100 qq-service
docker compose down
```

`down` 保留命名卷中的配置和历史。`docker compose down -v` 会删除数据卷，不要用于普通升级或重启。

镜像以非 root 用户运行；默认只将端口发布到宿主机 `127.0.0.1`，根文件系统只读，可写目录为 `/data` 和临时 `/tmp`。网页没有面向公网的用户登录系统，请保留本机端口绑定，不要直接公开端口或通过未鉴权反向代理暴露。

## 连接宿主机上的 NapCat Shell

1. 在宿主机独立安装并启动 NapCat Shell，登录目标 QQ。
2. 在 NapCat 启用 OneBot 正向 WebSocket，设置独立 Token。
3. 在 QQ_Service 账号连接中使用 `ws://host.docker.internal:3001`，端口与 NapCat 保持一致，Token 填入独立凭据栏。
4. 登录页由宿主机浏览器打开，可继续使用 `http://127.0.0.1:6099`，按实际端口调整。
5. 测试连接、核对实际登录 QQ，再配置群读取与发送范围，最后显式启动账号并释放权限。

容器里的 `127.0.0.1` 指向容器自身。若连接被拒绝，先检查 NapCat 的 OneBot 服务是否允许从 Docker 网关连接；只绑定宿主机回环地址的服务在部分系统上无法通过网关访问。需要调整时使用可达的监听地址，并用宿主机防火墙将访问限制到本机 Docker 网络，保留 Token。不要将 OneBot 端口开放到公网。

Compose 已为 Linux 设置 `host.docker.internal:host-gateway`；Docker Desktop 同样可使用这个主机名。可从容器验证 TCP 连通性，示例不会发送 QQ 消息：

```sh
docker compose exec qq-service node -e "const s=require('node:net').connect(3001,'host.docker.internal');s.on('connect',()=>{console.log('TCP connected');s.end()});s.on('error',e=>{console.error(e.message);process.exitCode=1})"
```

如果 NapCat 在另一个容器中，可将两者加入同一个受信任的 Docker 网络，在 `QQ_SERVICE_ONEBOT_HOSTS` 中显式加入它的服务名，再填写该服务名对应的 OneBot 地址。每个 QQ 仍需独立端口或连接配置，不能自动跟随其他账号。

## 配置与持久化

| 配置 | Compose 默认值 | 用途 |
| --- | --- | --- |
| `QQ_DASHBOARD_DATA_DIR` | `/data` | 配置、密钥库、SQLite、插件等持久数据 |
| `QQ_DASHBOARD_PORT` | `3210` | 容器内部 HTTP 端口 |
| `QQ_SERVICE_CONTAINER` | `1` | 外部连接模式，禁用本机模块安装与启动操作 |
| `QQ_SERVICE_HOST` | `0.0.0.0` | 容器内部监听地址；宿主端口仍绑定回环地址 |
| `QQ_SERVICE_PUBLIC_ORIGIN` | 两个本机8787地址 | 显式允许的浏览器 Host 和 Origin |
| `QQ_SERVICE_ONEBOT_HOSTS` | `host.docker.internal` | 除回环地址外允许连接的主机名，逗号分隔 |

更改宿主端口时，同时修改 Compose `ports` 和 `QQ_SERVICE_PUBLIC_ORIGIN`。Origin 必须包含协议和端口，不能包含路径、Token 或通配符。不要把 API Key 写进 Dockerfile 或公开的 Compose 文件；在仪表盘中填入密钥即可。

自定义插件可先将可信插件放入数据卷的某个子目录，再在模块页填写容器内路径。镜像还带有 `/app/examples/plugins` 下的示例插件。插件在容器中只具备容器内可见的文件和网络权限；不要为了使用插件而挂载整个宿主机目录。

## 备份和升级

升级前停止服务并备份整个数据卷，必须包含密钥库及加密密钥文件，单独复制 SQLite 或配置不能恢复全部凭据。可以将停止后容器的 `/data` 复制到本机私有备份目录：

```sh
docker compose stop qq-service
docker compose cp qq-service:/data ./qq-service-backup
docker compose up -d --build
```

备份目录含私密数据，不要提交到 GitHub。迁移 Windows EXE 数据时，先退出 EXE，并完整备份其数据目录；容器内 `/data` 对应同一类应用数据，但不要让 EXE 和容器同时读写同一份 SQLite 或密钥库。恢复的数据需可由容器用户 UID/GID 1000 读写。

## 构建与检查

```sh
docker build -t qq-service:local .
node scripts/docker-smoke.mjs qq-service:local
```

烟雾检查使用独立临时容器、网络和数据卷，检查网页、API、CSRF/Host/Origin防护、账号与密钥持久化、非root用户和关闭流程，并通过模拟 OneBot 服务验证容器间连接和 QQ 身份核对，不登录真实 QQ、不调用模型。检查结束会删除其临时资源，不触碰 Compose 的应用数据卷。

在需要企业或会话代理 CA 的环境中，可使用 BuildKit Secret：

```sh
docker build --secret id=proxy_ca,src=/path/to/trusted-ca.pem -t qq-service:local .
```

CA 仅在依赖安装步骤挂载，不写入镜像。普通 Docker Desktop 构建不需要该参数；不要通过关闭 TLS 验证来解决证书问题。
