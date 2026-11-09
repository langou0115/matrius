# Matrius

轻量、单用户实例、可自行部署的 AI 对话应用。提供桌面与移动 Web 响应式界面，支持安装为 PWA。

## 特性

- **多轮对话**：流式回复、停止、引用、分支、搜索与置顶；思考、工具与后续思考按事件顺序展示，整轮连续计时，中断保留内容和上下文
- **单用户实例**：登录后访问唯一工作区，对话和文件统一保存到实例后端
- **自带模型**：支持 OpenAI Chat Completions、Responses、Anthropic Messages 及兼容服务，密钥只保存在本机
- **完整渲染**：Markdown / GFM、KaTeX 公式、代码高亮、复制与折叠
- **实例访问保护**：单一所有者登录与改密，无用户管理或管理员控制台
- **自部署后端**：FastAPI + SQLite + 本地文件存储 + 进程内缓存，Caddy 统一入口
- **远程发布**：本机一条命令，服务器构建并运行 Caddy / Web / API 三个容器
- **可安装 Web 应用**：提供 PWA manifest 与 service worker，安装后可离线打开应用外壳

> 每个实例只有一个所有者，没有本地/云端模式切换。聊天、记忆与偏好以服务端为唯一事实源；模型配置与 API key 保存在当前浏览器。外部多用户/实例管理不在本项目范围内。

模型回复失败时，可在浏览器 Console 查看 `[Matrius Agent]`，或执行 `copy(matriusDiagnostics.export())` 导出当前页面的诊断摘要（不含密钥和正文）；字段说明见[模型回复诊断](doc/development.md#模型回复诊断)。

## 技术栈

| 部分 | 选型 |
| --- | --- |
| 客户端 | React 19、TypeScript、Vite 8 |
| 路由 | React Router 7（`src/router/routes.tsx`） |
| 后端 | Python 3.12、FastAPI、SQLite、SQLAlchemy、Alembic |
| 运行时能力 | 进程内缓存/限流、本地文件存储、DuckDuckGo 优先（Bing 回退）搜索、trafilatura 正文提取 |
| 基础设施 | Caddy（生产只运行 Caddy / Web / API 三个容器） |
| 部署 | Docker Compose、SSH、`npm run deploy` |

## 本地开发

要求 Node.js 24、npm 和 uv（管理 Python 3.12+）；支持 Windows、macOS、Linux。不需要 Docker、SSH 或 WSL。

下面命令须在包含 `package.json` 的项目根目录运行；其他目录可使用 `npm --prefix <项目绝对路径> run dev`。若报用户目录下找不到 `package.json`（ENOENT），先切换到项目目录。

```bash
npm ci
npm run dev
```

打开 `http://localhost:8081`，登录实例后在「设置 → 模型服务」添加服务商和模型后即可对话。

`npm run dev` 完全在本机运行 Vite、FastAPI 与 SQLite：数据保存在 `server/.data/matrius.db` 和 `server/.data/files`（已加入 `.gitignore`），不连接服务器。前后端保存后热更新，Ctrl+C 一并停止本机进程。启动时会自动迁移开发库；开发会话已在运行时，可用 `npm run db:migrate` 单独升级同一个开发库而不重启服务。开发实例所有者使用 `.env.local` 的 `INITIAL_ADMIN_USERNAME` / `INITIAL_ADMIN_PASSWORD`，未设置时回退到 `admin` / `dev-password`；密码仍是 `change-me` 时拒绝启动。`npm run dev` 不读取 `docker-compose/.env.production`。已有开发实例所有者会在启动时同步为当前配置的密码。`npm run dev -- --reset-db` 会清空本地开发数据后重新迁移；`npm run dev -- --check` 只校验工具、端口与路径；`npm run dev -- --clear` 会重建 Vite 的依赖预构建。

开发模式可访问 `/mock`，其中 `/mock/process` 可预览思考过程、工具步骤和中断状态，`/mock/storage` 可预览保存失败提示，均不调用模型；回答末尾的来源区留待后续实现。Vite 的 HMR 会自行重连，模型回复生成期间不再暂停热更新；刷新或离开页面时仍保留 `beforeunload` 确认，避免误丢正在进行的回复。正式 Web 使用静态生产构建。

```bash
npm run build   # Vite 生产构建到 dist/（Dockerfile.web 使用）
npm run test    # 全部测试，按文件串行执行
```

## 部署

服务器只需 Docker、SSH 和常用命令行工具，本机不需要 Python、Docker 或数据库。

```bash
cp docker-compose/.env.production.example docker-compose/.env.production  # 服务器地址与端口
cp .env.local.example .env.local                                          # 本地开发与通用设置
npm run deploy                                                            # 首次自动初始化，之后更新
```

`.env.local` 管本地开发和通用应用设置（`DEV_*`、`INITIAL_ADMIN_*`、登录有效期等），其中通用项会在部署时写入服务器配置。代理分两个键：`WEBTOOL_PROXY_URL` 只用于本机开发、不会同步；`WEBTOOL_PROXY_URL_PRODUCTION` 才会在部署时映射为服务器的 `WEBTOOL_PROXY_URL`，且必须是容器可达地址（如 `host.docker.internal`），loopback 会被拒绝。SSH 目标、公开端口和工作目录等服务器相关内容放在 `docker-compose/.env.production`。每次 `npm run deploy` 都会同步源码、备份数据库、构建并更新 Web/API、应用迁移、刷新实例所有者密码、更新 Caddy 并做健康检查；新服务器首次执行时会自动生成配置、创建 SQLite 数据库和实例所有者，数据卷长期保留。实例所有者凭据来自 `.env.local` 的 `INITIAL_ADMIN_USERNAME` / `INITIAL_ADMIN_PASSWORD`，以最近一次部署为准；两个值都不填时，首次初始化会随机生成并打印一次，之后不会改动现有密码。

默认端口：`16666` 为网页 + API，`16667` 仅 API（可选）；在 `docker-compose/.env.production` 用 `APP_PORT` / `API_PORT` 覆盖，详见[修改端口](doc/deployment.md#修改端口)。每次命令完成同步、构建、健康检查后退出；功能清单中的能力在部署成功后对实例所有者开放。

Web/API 源码直接打入各自镜像，不挂载源码、不运行开发服务器；`matrius_prod_api_data` 数据卷长期保留。

服务器初始化、账号、HTTPS、备份与 CD 见[服务器部署](doc/deployment.md)。

## 文档

| 文档 | 内容 |
| --- | --- |
| [文档索引](doc/README.md) | 全部文档入口 |
| [产品](doc/product.md) | 产品边界与本地/实例 |
| [后端](doc/backend.md) | API、数据模型与实现 |
| [认证](doc/auth.md) | 实例登录、迁移与功能能力 |
| [开发与验证](doc/development.md) | 命令、构建、测试与 Mock |
| [服务器部署](doc/deployment.md) | 初始化、发布、备份与运维 |

## 验证

```bash
npx tsc --noEmit
npx eslint .        # 可选，使用 eslint.config.mjs
npm run test
```

后端测试见[后端 README](server/README.md)。

## 许可

见 [LICENSE](LICENSE)。
