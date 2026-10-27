# Matrius

轻量、多用户、可自行部署的 AI 对话应用。当前以 Web 为主，移动端后续适配。

## 特性

- **多轮对话**：流式回复、停止、引用、分支、搜索与置顶；思考、工具与后续思考按事件顺序展示，整轮连续计时，中断保留内容和上下文
- **本地优先**：未登录即可使用，对话保存在浏览器 IndexedDB
- **自带模型**：支持 OpenAI Chat Completions、Responses、Anthropic Messages 及兼容服务，密钥只保存在本机
- **完整渲染**：Markdown / GFM、KaTeX 公式、代码高亮、复制与折叠
- **账号与灰度**：管理员建号、首次改密；新功能先在测试账号验证，再按账号发布
- **自部署后端**：FastAPI + SQLite + 本地文件存储 + 进程内缓存，Caddy 统一入口
- **远程发布**：本机一条命令，服务器构建并运行 Caddy / Web / API 三个容器

> 未登录读写本机 IndexedDB，登录后读写账号云端数据，二者独立、不自动导入或合并。模型配置与 API key 始终保存在本机，登录前后共用。

## 技术栈

| 部分 | 选型 |
| --- | --- |
| 客户端 | Expo SDK 57、React Native、React、TypeScript |
| 路由 | Expo Router（`src/app/`） |
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

打开 `http://localhost:8081`，在「设置 → 模型服务」添加服务商和模型后即可对话。

`npm run dev` 完全在本机运行 Expo、FastAPI 与 SQLite：数据保存在 `server/.data/dev.db` 和 `server/.data/files`（已加入 `.gitignore`），不连接服务器。前后端保存后热更新，Ctrl+C 一并停止本机进程。启动时会自动迁移开发库；开发会话已在运行时，可用 `npm run db:migrate` 单独升级同一个开发库而不重启服务。开发管理员使用 `.env.local` 的 `INITIAL_ADMIN_USERNAME` / `INITIAL_ADMIN_PASSWORD`，未设置时回退到 `admin` / `dev-password`；密码仍是 `change-me` 时拒绝启动。`npm run dev` 不读取 `docker-compose/.env.production`。已有开发管理员会在启动时同步为当前配置的密码。`npm run dev -- --reset-db` 会清空本地开发数据后重新迁移。

只调试前端也可用 `npm run web`。两种开发方式都可访问 `/mock`，其中 `/mock/process` 可预览思考过程、工具步骤和中断状态，不调用模型；回答末尾的来源区留待后续实现。生成期间会暂缓开发热更新，避免代码保存打断回答；本次更新后需手动重启开发命令以应用 Metro 配置。正式 Web 使用静态生产构建。

```bash
npm run export:web && npm run serve   # 本地验证生产构建
```

## 部署

服务器只需 Docker、SSH 和常用命令行工具，本机不需要 Python、Docker 或数据库。

```bash
cp docker-compose/.env.production.example docker-compose/.env.production  # 服务器地址与端口
cp .env.local.example .env.local                                          # 本地开发与通用设置
npm run deploy                                                            # 首次自动初始化，之后更新
```

`.env.local` 管本地开发和通用应用设置（`DEV_*`、`INITIAL_ADMIN_*`、登录有效期等），其中通用项会在部署时写入服务器配置。代理分两个键：`WEBTOOL_PROXY_URL` 只用于本机开发、不会同步；`WEBTOOL_PROXY_URL_PRODUCTION` 才会在部署时映射为服务器的 `WEBTOOL_PROXY_URL`，且必须是容器可达地址（如 `host.docker.internal`），loopback 会被拒绝。SSH 目标、公开端口和工作目录等服务器相关内容放在 `docker-compose/.env.production`。每次 `npm run deploy` 都会同步源码、备份数据库、构建并更新 Web/API、应用迁移、刷新管理员密码、更新 Caddy 并做健康检查；新服务器首次执行时会自动生成配置、创建 SQLite 数据库和管理员，数据卷长期保留。管理员账号密码来自 `.env.local` 的 `INITIAL_ADMIN_USERNAME` / `INITIAL_ADMIN_PASSWORD`，以最近一次部署为准；两个值都不填时，首次初始化会随机生成并打印一次，之后不会改动现有密码。

默认端口：`16666` 为网页 + API，`16667` 仅 API（可选）；在 `docker-compose/.env.production` 用 `APP_PORT` / `API_PORT` 覆盖，详见[修改端口](doc/deployment.md#修改端口)。每次命令完成同步、构建、健康检查后退出；代码中 stage=stable 的功能在部署成功后对所有账号开放。

Web/API 源码直接打入各自镜像，不挂载源码、不运行开发服务器；`matrius_prod_api_data` 数据卷长期保留。

服务器初始化、账号、HTTPS、备份与 CD 见[服务器部署](doc/deployment.md)。

## 文档

| 文档 | 内容 |
| --- | --- |
| [文档索引](doc/README.md) | 全部文档入口 |
| [产品](doc/product.md) | 产品边界与本地/云端模式 |
| [后端](doc/backend.md) | API、数据模型与实现 |
| [认证](doc/auth.md) | 登录、管理员与功能开关 |
| [开发与验证](doc/development.md) | 命令、构建、测试与 Mock |
| [服务器部署](doc/deployment.md) | 初始化、发布、备份与运维 |

## 验证

```bash
npx expo lint
npx tsc --noEmit
npm run test:rendering
npm run test:models
npm run test:auth
npm run test:deploy
npm run test:dev
```

后端测试见[后端 README](server/README.md)。

## 许可

见 [LICENSE](LICENSE)。
