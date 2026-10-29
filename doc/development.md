# 开发、验证与交付

[文档索引](README.md)

## 环境与客户端命令

当前使用 npm 和 `package-lock.json`，Expo SDK 57。Node.js 版本需满足[对应 SDK 要求](https://docs.expo.dev/versions/v57.0.0/)。

```bash
npm ci                         # 根据锁文件安装依赖，生成 KaTeX 本地资源
npx expo start                 # Metro 开发服务
npm run android                # 打开 Android 开发目标
npm run ios                    # 打开 iOS 开发目标
npm run web                    # Web 开发
npm run dev                    # 本机全栈（后端 + Expo Web），等价于 npm run dev:web
npm run dev:ios                # 同一后端 + Expo iOS 目标（模拟器或 Expo Go）
npx expo start --port 8082      # 端口占用时换端口
npx expo lint                  # 使用仓库 ESLint 配置检查
npx tsc --noEmit               # TypeScript 类型检查
npm run test:rendering         # Markdown、公式、代码高亮与折叠/复制回归
npm run test:auth              # 账号、密码控件与同步途中删除的集成回归
npm run test:models            # Agent、会话删除合并与 IndexedDB 持久化回归
npm run assets:katex           # 按需重新生成本地公式 CSS 和字体（npm ci 后自动生成）
npx expo-doctor                # 诊断依赖与配置
npx expo install <package>     # 安装 SDK 兼容依赖
npx expo install --fix         # 按需修复不兼容版本
npx expo export --platform web # 导出 Web 静态产物到 dist/
npm run export:web             # 同上
npm run serve                  # 托管 dist/ 并提供同源模型中继（默认 8081）
```

- `npm run android` / `ios` 启动开发目标，不是生产构建。Android 模拟器需要 Android SDK；本机 iOS 模拟器需要 macOS 与 Xcode。
- Windows / WSL 开发时，确保真机或宿主机能访问 Metro 输出的地址；端口和网络以实际输出为准。不要沿用旧版 Flutter Web Server 命令。
- `npm ci` 的 postinstall 从安装的 KaTeX 生成同版本 CSS、WOFF2 字体和许可证到 `public/vendor/katex/<版本>/`；Expo 从 public 提供这些资源，避免 CSS 相对字体 URL 在 Metro 中失效。禁用安装脚本或升级 KaTeX 后运行 `npm run assets:katex`。
- 已提供 `eslint.config.js`、ESLint 与 Expo lint 配置，`npm ci` 后可直接执行 lint。消息渲染回归使用 Node 内置测试运行器、TypeScript 加载器和 LinkeDOM，不启动浏览器。
- 模板的 `reset-project` 脚本与命令已移除，避免重置业务页面。
- 若后续改为 Bun，提交对应锁文件后将 `npx` 换为 `bunx`，不要混用多套锁文件。

## 构建与发布

Web 使用 `web.output: single` 输出单页应用，支持运行时创建的 `/c/<conversation-id>`。托管服务需把页面路径回退到 `index.html`（如 Nginx `try_files $uri $uri/ /index.html;`）；静态资源仍按原路径提供。不能预生成浏览器本地的对话 ID。发布前验证对话链接直达、刷新、前进后退与无效 ID 提示。配置依据见 [Expo Web 发布](https://docs.expo.dev/guides/publishing-websites/)。

仓库内置零依赖的生产服务 `scripts/server.mjs`，执行 `npm run export:web && npm run serve` 即可同时托管 `dist/` 和同源模型中继 `/api/model-proxy`。静态回退规则与 Nginx 配置一致；SSE 响应直接透传，不做缓冲。可用 `PORT`、`HOST`、`MATRIUS_STATIC_DIR` 调整监听地址与产物目录。

中继只接受带 `x-matrius-target-origin` 的 GET/POST，并拒绝凭据、回环、私网和链路本地目标；DNS 解析结果会固定到实际连接，避免 DNS rebinding。若改用 Nginx 等托管服务，需要额外代理 `/api/model-proxy/`，保留请求头并关闭响应缓冲（`proxy_buffering off`）以支持流式输出。

中继逻辑与服务器框架解耦，导出为 `handleModelProxy(req, res): boolean`。生产部署中它保留在 Web 容器，由 Caddy 将 `/api/model-proxy/*` 路由过去；FastAPI 不处理模型请求。例如 Express：

```js
import modelProxy from './scripts/model-proxy.cjs';

app.use((req, res, next) => {
  if (!modelProxy.handleModelProxy(req, res)) next();
});
```

静态页面也可由该进程托管，或交给 Nginx/CDN；只要页面与 `/api/model-proxy` 保持同源，浏览器就不会遇到 CORS。

使用 [EAS Build](https://docs.expo.dev/build/introduction/) 构建和签名，EAS Submit 提交商店，EAS Update 发布兼容的 OTA 更新。

以下为后续配置流程，当前尚无 `eas.json`、EAS 项目关联或 Updates 配置，不代表现在可直接发布：

```bash
npx eas-cli@latest build:configure
npx eas-cli@latest build --platform android
npx eas-cli@latest build --platform ios
npx eas-cli@latest submit --platform android
npx eas-cli@latest submit --platform ios
```

开发客户端需先安装 `expo-dev-client` 并配置 development profile，再运行 `npx eas-cli@latest build --profile development --platform android` 或 iOS 对应命令。OTA 更新需先配置 EAS Update 与运行时兼容策略；新增原生模块或更改原生配置后需要新的二进制构建。

当前原生目录由 CNG 生成，原生行为通过 app config / config plugins 配置，不手工创建或修改 `ios/`、`android/`。

## 本机全栈开发：npm run dev

Windows、macOS、Linux 使用同一入口。本机只需 Node.js 24、npm 和 [uv](https://docs.astral.sh/uv/getting-started/installation/)；uv 按 `server/pyproject.toml` 和 `uv.lock` 自动准备 Python 3.12 及依赖。不需要 Docker、SSH、bash 或 WSL，也不会连接服务器。

先切换到含 `package.json` 的项目根目录，再运行以下命令。终端重开后可能回到用户目录，此时直接运行 npm 会报 `ENOENT ... package.json`；也可在任意目录使用 `npm --prefix <项目绝对路径> run dev`。

```bash
npm ci
npm run dev -- --check       # 校验工具、端口与路径，不启动服务
npm run dev                  # 常驻：迁移数据库 + FastAPI reload + Expo Web
npm run dev:web              # 同上
npm run dev:ios -- --check   # 校验 iOS 目标的 Expo 参数、API 地址与端口
npm run dev:ios              # 常驻：同一后端 + Expo iOS 目标
npm run db:migrate           # 只迁移 server/.data/dev.db，不启动服务
npm run web                  # 仅本机前端与模型中继
```

`npm run dev` 与 `npm run dev:web` 完全等价；`npm run dev:ios` 复用同一套迁移、管理员初始化、健康检查与进程清理，只替换 Expo 子进程参数：

- macOS：`expo start --ios`，打开 iOS Simulator。
- Windows / Linux / WSL：`expo start --lan`，终端输出 Expo Go 二维码；手机与电脑需在同一网络。
- `DEV_EXPO_HOST=tunnel` 改为 `expo start --tunnel`（只隧道 Metro，不隧道 API）；`DEV_EXPO_HOST=localhost` 适用于本机模拟器。
- API 默认绑定 `0.0.0.0`（可由 `DEV_API_HOST` 覆盖），使手机能直接访问；就绪探测仍走回环地址。
- 手机无法使用 Web 开发代理，Expo Go 直接请求 API。脚本默认使用本机非回环 IPv4 拼出 `EXPO_PUBLIC_API_BASE_URL`，并在启动日志打印实际地址与可达性提示；`.env.local` 中显式设置的值优先。
- WSL2 的 `0.0.0.0` 只暴露虚拟网卡；真机访问需要 Windows 端口转发/镜像网络，或设置手机可达的 `EXPO_PUBLIC_API_BASE_URL`。脚本只提示，不自动配置。

开发数据全部落在仓库内，且已被 `.gitignore` 排除：

```text
server/.venv/            # uv 管理的 Python 环境
server/.data/
├── dev.db               # SQLite；WAL 模式会额外生成 dev.db-wal / dev.db-shm
└── files/               # /api/files 写入的上传文件内容
```

浏览器自己的 IndexedDB 仍由浏览器管理，与 `server/.data` 是两套数据。

启动流程：`uv sync --frozen --extra dev` → 执行 `alembic upgrade head` → `alembic check`（模型与迁移不一致时直接失败）→ `app.bootstrap` 创建开发管理员并同步密码 → 启动 uvicorn `--reload` → 等待 `/api/health/ready` → 启动 Expo（Web 或 `--ios` 目标）。

API 只监听 `server/app` 下的 Python 应用代码，修改 `server/tests` 不触发重载。开发模式下后端直接读取 `.env.local`，并在每次读取配置时检查文件变化：代理、搜索/抓取预算、限流等运行时设置在保存后立即生效，不需要重启。端口、`DATABASE_URL` / `DATA_DIR`、`INITIAL_ADMIN_*` 和日志级别属于启动期设置，仍需重启。`npm run dev` 每次启动都会自动迁移；服务已在运行时单独执行 `npm run db:migrate` 即可升级同一个 `server/.data/dev.db`，不必重启开发会话。该命令固定使用开发数据库，不会读取 shell 或 `.env.local` 里的生产 `DATABASE_URL` / `DATA_DIR`。Windows 使用 `server/scripts/dev-api.py` 复用锁定版本 Uvicorn 的监听器，只定向终止并重建工作进程，避免 Uvicorn 默认的控制台 Ctrl+C 事件连带停止 npm/Expo。热重载会中断当时的开发请求。升级 Uvicorn 后需运行 `npm run test:dev`，其中 Windows 集成测试验证连续两次真实重载与进程树清理。

开发管理员和正式服务器都使用 `.env.local` 的 `INITIAL_ADMIN_USERNAME` / `INITIAL_ADMIN_PASSWORD`，启动时把已有账号密码同步为当前值；未设置时开发库回退到 `admin` / `dev-password`。`npm run dev` 不读取 `docker-compose/.env.production`。如果 `INITIAL_ADMIN_PASSWORD` 仍是示例占位值 `change-me`，开发命令会直接失败并要求先修改密码。

开发环境下，如果库中已有同名管理员但密码与当前配置不一致，启动时会将其密码同步为配置值；正式环境不会修改已有管理员密码。

```bash
npm run dev -- --reset-db     # 删除本地开发数据库和上传文件，再重新迁移
```

`--reset-db` 只删除 `server/.data/dev.db*` 和 `server/.data/files/`，不会碰其他文件。Windows 的文件锁更严格，执行前先按 Ctrl+C 停止 API；脚本会给出明确提示。

默认 Web 8081、API 8000，可在 `.env.local` 设置 `DEV_WEB_PORT` / `DEV_API_PORT`；`DEV_API_HOST` 控制 API 绑定地址，`DEV_EXPO_HOST` 控制非 macOS 上 Expo 的局域网/tunnel/localhost 模式，`EXPO_PUBLIC_API_BASE_URL` 供 Expo Go 直连 API。端口被占用时失败退出，不自动切换。Web 目标下 Metro 先处理 `/api/model-proxy`，再把其余 `/api/*` 代理给本机 FastAPI，浏览器无需跨域配置；iOS 目标不使用该代理。脚本不自动打开浏览器。

命令持续挂起，前后端保存即热更新。Ctrl+C 清理本机进程树；任何常驻子进程退出也会结束整个开发会话。服务器和正式数据不受影响。

Web 生成期间暂缓 HMR，全部回复结束后延迟恢复，避免代码修改导致 React 重挂载或整页刷新切断流。开发 Metro 关闭懒分包，避免断开 HMR 后在模型/工具按需加载时触发整页刷新；生产仍正常分包。修改 `metro.config.js` 后需重启开发命令。浏览器刷新或离开时，如果仍在生成，会触发离开确认；确认离开仍会中断客户端请求。

`/mock/process` 使用真实回复组件展示等待、思考、搜索、读取、完成、主动停止与连接中断，可直接比较状态与动效，不调用模型。预览及模拟数据只在开发构建加载。

### 多台电脑与数据隔离

每台开发机独立安装 Node.js、npm、uv 并运行 `npm ci`；各自使用自己的 `server/.data`，数据不会在电脑之间同步，也不会与正式服务器共享。需要正式数据时，用 `scripts/backup.sh` 生成的快照在本地恢复，或重新登录后通过应用内导入。

`INITIAL_ADMIN_USERNAME` / `INITIAL_ADMIN_PASSWORD` 同时用于开发库和正式服务器；正式服务器以最近一次部署为准。浏览器 IndexedDB 和登录 token 仍按站点与浏览器隔离。

## 远程构建与部署：npm run deploy

发布命令从原 npm run remote 更名为 npm run deploy。开发不再需要上传源码；只有正式发布才执行此命令。本机发布只需 Node.js、Git、OpenSSH、tar，不需要 Python 或 Docker。

部署连接信息（`REMOTE_USER` / `REMOTE_HOST`、SSH 覆盖项、`APP_PORT` / `API_PORT` / `APP_HTTPS_PORT`、`REMOTE_WORKSPACE`、`REMOTE_ENV_FILE`）放在本机 `docker-compose/.env.production`（从 `.env.production.example` 复制，已被 Git 忽略）。`.env.local` 只放本地开发与通用应用设置；通用项（登录有效期、限额、`LOG_LEVEL` 等）设置后会在部署时写入服务器的 `production.env`，留空则保留服务器原值。代理按用途分键：`WEBTOOL_PROXY_URL` 只用于本机开发，不会上传；`WEBTOOL_PROXY_URL_PRODUCTION` 会被映射为服务器的 `WEBTOOL_PROXY_URL`。生产 API 在容器内运行，代理地址必须是 `host.docker.internal` 等容器可达地址，loopback 会被部署拒绝。`INITIAL_ADMIN_PASSWORD` 仍是 `change-me` 时，部署会直接失败并要求先修改管理员密码。为了兼容旧配置，`.env.local` 中同名的部署项仍会覆盖 `.env.production`。

```bash
npm run deploy                       # 同步、构建、迁移、刷新管理员密码、健康检查后退出
npm run test:dev                     # 本地配置、SQLite URL、重置数据、进程清理、API 代理回归
npm run test:deploy                  # 源码上传、生产构建、自动初始化、并发锁回归
npm run test:auth
```

服务器只运行 Caddy / Web / API 三个容器，持久化只有 `matrius_prod_api_data` 卷（SQLite 数据库与上传文件）。Web 用 Dockerfile.web 构建静态生产产物并运行 Node 模型中继，API 用 server/Dockerfile 内置的入口脚本与单 worker Uvicorn 运行。源码直接复制进镜像，不挂载开发目录、不启动 Metro 或 reload；保留数据和 Caddy 配置所需卷。每次发布都调用两个镜像的 build，由 Docker 复用未变化的层，应用镜像变化后替换对应容器。

`npm run deploy` 每次执行同一套流程：生成缺失的服务器 production.env（新服务器首次执行时）、备份现有数据库、构建 Web/API、执行迁移、刷新管理员密码、更新容器与 Caddy、健康检查。新服务器不需要单独初始化命令；首次执行会创建数据卷和空库管理员。API 每次重建，入口在启动 Uvicorn 前执行 `alembic upgrade head`、`alembic check` 和 `bootstrap`，因此迁移总是随之应用。运行时 `/api/health` 也会校验版本，不一致返回 503。REMOTE_WORKSPACE 默认仍为服务器 $HOME/.matrius-remote，以复用已有配置和数据；更名命令不会创建新数据卷。APP_PORT、API_PORT、APP_HTTPS_PORT 在每次部署时应用，未填写的端口保留服务器原值。Compose 根据端口、镜像及环境配置变化按需重建 Caddy；Caddyfile 内容变化时强制重建，健康检查通过后才记录已应用的文件摘要。配置未变化时保留原 Caddy 容器。INITIAL_ADMIN_* 以最近一次部署为准：每次部署都会写入服务器并更新该管理员密码，两个值留空时不动现有密码。不在本机对云端库执行迁移。

同步包含未提交的新文件、修改和删除；排除密钥、.env、依赖、虚拟环境、构建产物、Git 元数据及符号链接。服务器会话锁防止两个发布同时覆盖源码。健康检查通过即完成发布，代码中 stage=stable 的功能随即对所有账号开放。回退为切换到已验证提交后重新 deploy；数据库结构回退须另行评估。

数据库已有数据时，每次部署都先用 SQLite backup API 生成一致性快照（包含 WAL 中已提交的事务）并复制到服务器 `<workspace>/backups/`（保留最近 10 份），备份失败或为空则中止。部署不再单独确认破坏性迁移，删表、删列等操作会随部署执行；发布前应在本地审查验证，备份是回退依据。迁移执行后运行 `alembic check`，模型与表结构不一致会中止发布。

手动 CD 同样使用 npm run deploy，不配置自动 CI。服务器准备、SSH 权限、备份见[服务器部署](deployment.md)。

## 按账号开发新功能

所有新增可见功能先登记到 `server/app/features/registry.py`（默认 preview），UI 使用 `useFeature` / `FeatureGate`、服务端使用 `require_feature`，并过滤设置搜索和直接路由访问。用 `admin_test` 在本机页面验证，也可部署候选包到正式地址继续验证。验证后只把指定条目改为 stable，再通过手动 CD 或 `npm run deploy` 发布；部署成功后这些功能即对所有账号开放。详细规则与共用代码/数据库的限制见[认证文档](auth.md#同一地址的账号功能开关)。

账号登录并完成首次改密后使用云端 REST 仓储，不读取或写入浏览器本地工作区；退出恢复本地数据，不自动上传或合并。模型配置与 API key 始终保存在本机并共用。浏览器登录态由 HttpOnly Cookie 维持，关闭标签页或重启浏览器后仍有效；Mock 不使用真实账号。`test:auth` 包含工作区模式隔离与云端 REST 增删改、版本冲突回归。

## 后端与基础设施

开发后端由 `npm run dev` 在本机运行，使用本机 SQLite 与本地文件目录；正式后端由 Compose 运行生产镜像。两套数据完全分离，开发进程不会连接服务器。

后端自动测试使用内存 SQLite，不依赖服务器。需要执行后端检查时安装 Python 开发依赖后运行：

```bash
cd server
uv sync --python 3.12 --frozen --extra dev
uv run --no-sync ruff check .
uv run --no-sync pytest
```

本机容量测试：在 `server/` 运行 `uv run --no-sync python scripts/benchmark.py`；仓库根目录运行 `node scripts/benchmark-relay.mjs` 测量模型 SSE 中继。前者创建隔离的临时 SQLite 并执行真实迁移，以单 worker Uvicorn 和真实 HTTP 测试认证后读写，保留限流；结束后清理测试库，不读取开发库或连接正式服务器。可用 `--seconds 30 --levels 1 10 25 50` 调整单档时长与并发。多账户场景使用 `--mode pinned --matrix "200:1,5;500:1" --target-rates read=120,mixed=100,write=60`：每个虚拟账户绑定自己的令牌、独立限速并可设置每账户并发，另含公平性、健康探测、跨租户隔离和进程 CPU/RSS/WAL 采样。结果写入 `doc/benchmark-results.json`，中继结果写入 `doc/benchmark-relay-results.json`。中继使用真实生产模块及本地模拟上游，仅在隔离测试环境替换出站网络，不改动生产目标校验。单账户并发与已知瓶颈见[容量报告](performance.md)，多账户稳定点、上限和服务器配置见[多账户容量报告](performance-multiaccount.md)。短时间本机压测不能作为生产 SLA。

修改数据库结构使用 Alembic，检查索引、约束与级联；涉及迁移时在临时空 SQLite 上验证全部迁移可执行（`server/tests/test_migrations.py` 覆盖这一点）。SQLite 的 `ALTER TABLE` 能力有限，Alembic 已启用 `render_as_batch`；重命名、删除列和收紧约束应拆成小步。仓库不配置自动 CI；日常部署用 `npm run deploy`，手动 CD 调用同一脚本发布已验证的 main 提交。完整服务器准备与备份见[服务器部署](deployment.md)。

## 验证与代码规则

- 完成任务前运行 `npx expo lint` 和 `npx tsc --noEmit`，如实报告结果和环境阻塞。
- 已有测试覆盖相关行为时运行必要的测试；消息渲染相关修改运行 `npm run test:rendering`；测试覆盖格式解析、公式/货币与代码边界、安全 URL/HTML、高亮、折叠和原文复制，以及消息赞/踩切换和分支上下文隔离。文档迁移无需新增业务测试。
- 不自动启动或控制浏览器、不生成浏览器截图、不访问运行中的 Web 端口；仅在用户明确要求 Web 浏览器验证时执行。未实测的平台行为说明限制。
- TypeScript 保持 strict；不滥用 `any`、关闭 lint 或压制告警来绕过问题。
- 引用与对话导航的回归在现有脚本中执行：`test:rendering` 覆盖选区边界、引用操作、会话草稿隔离、提问目录与跳转暂停跟随；`test:models` 覆盖三协议引用上下文、重新生成及 IndexedDB 恢复。原生选区、实际滚动几何与触屏行为仍需按需浏览器实测。
- 复用已有组件和服务，避免无关重构；不提交真实用户数据、密钥和令牌。
- 后续自动化测试应作为仓库资产提交，放在应用路由目录外。临时脚本、种子数据和测试产物应明确忽略，不能假设旧仓库的忽略规则已经迁移。

## 完成前检查

- 查看相关实现与文档，保持业务依赖方向和多用户隔离。
- 涉及功能时检查本地/云端模式边界、密钥处理、重试和数据保留。
- UI 涉及安全区、键盘、字体缩放、无障碍、长列表和 Web 适配时报告验证范围。
- 报告 lint、类型检查及相关测试的实际结果。
- 产品边界、持久化、目录职责或命令变化时同步更新对应文档与根 README。


## 开发示例对话

- 用户要求的界面调试数据位于 `dev/fixtures/chat-workspace.ts`，不放进业务组件或普通启动数据中。
- `npm run web` 后打开 `/mock`（例如 `http://localhost:8081/mock`，端口以实际启动输出为准）。这是预览索引页，列出当前各项 mock 测试，点进去即可查看，不需要管理员后台或登录。
- 新增一项 mock 测试：在 `src/app/mock/` 加一个路由文件（复用真实页面组件，见 `chat.web.tsx`），再往 `src/features/mock/mock-items.ts` 的 `mockItems` 加一条记录。索引页与工具栏标签都会自动跟上。
- Chat Mock 复用完整聊天界面与交互，只替换工作区初始数据并增加右下角工具卡片，不隐藏正式界面的入口。侧栏设置进入 `/mock/chat/settings`，复用正式设置组件；返回 `/mock/chat` 时保留会话、草稿与外观状态。设置属于聊天预览流程，不单独列为 Mock 测试项。
- 参考 `../openstudio/tests/seed-software-test.mjs` 的批量长对话与专项样例结构，提供 100 个八轮对话和 9 个专项会话，共 109 个会话、1730 条消息。
- 专项覆盖 Markdown 标题/列表/引用/表格/脚注、多语言代码块、公式与货币、50 轮长对话、40 段单条长回复、Unicode/RTL、长链接与 HTML 原文、短回复和未闭合标记；前四个专项会话置顶。
- 点击侧栏切换样例，也可通过搜索标题或正文定位内容，支持置顶、重命名、删除与输入草稿；配置并选中模型后，发送会调用真实模型，沿用正式对话流程。
- 示例模式不读取或写入浏览器真实工作区，变更仅保存在内存中。右下角提供重置和退出入口；刷新示例地址也会重置。
- `src/app/mock/_layout.tsx` 通过 `__DEV__` 统一保护全部 mock 子路由；新增页面自动受保护。索引页、工具栏与示例数据仅在 `__DEV__` 分支动态加载，release 模式访问这些路径会跳回首页。
- `npm run web` 使用开发 bundle，可访问 Mock；`npx expo export --platform web` 默认生成生产 bundle，Mock 不可用。`npm run dev` 也使用开发 bundle；`npm run deploy` 构建生产 bundle，服务器上的 `/mock` 同时由 Caddy 拒绝。`__DEV__` 取决于 bundle 的开发/生产模式，与域名、登录状态或 EAS profile 名称无关。
- 发布前检查导出的 JS/HTML 不包含 Mock 索引文案、工具栏或示例数据；路由名称和重定向页面仍可能存在于静态产物中，不代表 Mock 页面可用。
- 用户与助手消息共用 Markdown/GFM 与 KaTeX 渲染，支持标题、列表、引用、表格、脚注、公式和按需代码高亮；代码块可复制与折叠。Mermaid 等未知代码语言作为原文展示，已接入三种协议的实时流式模型输出。

## 设置页面验证

- 设置首页搜索名称、说明与关键词（如“暗色”“跟随系统”“Twitter”“版本”），点击结果进入对应详情；无匹配时可清空搜索。
- 检查显示模式和配色修改后返回首页显示当前值，再返回聊天保持会话和草稿。Chat Mock 执行相同流程，导航保持 `/mock/chat/settings` 前缀，刷新后恢复样例且不写真实数据。

## 模型接入验证

- `npm run test:models`：真实 pi 协议实现配合模拟服务商 SSE，验证三协议路径/鉴权、多轮上下文、分片 UTF-8、取消、超时、错误安全提示与会话密钥隔离，以及 IndexedDB v1→v2 原子迁移、增量正文写入、密钥独立记录和版本冲突。不会调用真实服务商，不需要 key。
- 同一脚本也直接测试无 React/DOM 的 `createAgentRuntime`，覆盖输入快照、单请求限制、批量回复、取消时保留正文、模块加载期间停止、销毁和订阅清理；检查 `core/agent/` 不导入功能模块、React 或 Web 实现。原生传输和真机行为需单独验证。
- 个性化回归包含默认值与字符上限、旧快照兼容、IndexedDB 保存/恢复、三协议系统提示注入，以及编辑偏好后重新生成采用最新指令。手动验证时从设置搜索“自定义指令”进入表单，编辑后返回对话、刷新或重新生成；Mock 执行相同流程但不写真实记录。记忆功能不在当前范围。
- 测试脚本显式使用 `--test-isolation=none`，确保当前 Node 与 TypeScript loader 环境执行并报告每个测试用例。模型接入修改同时运行 `npm run test:rendering`、lint、typecheck 与 Web 生产导出。
- 首次手动使用：设置 → 模型服务 → 添加服务商，填写名称、协议、基础地址和 key；保存后获取模型列表并添加模型，也可手动填写模型 ID。返回聊天选择模型并发送；生成中可停止，失败后可重新生成。模型请求与目录获取均经 `/api/model-proxy` 同源转发，本地/内网地址及原生端仍直连。`npm run web` 与 `npm run serve` 均已内置该中继；真实服务商兼容性仍需用自己的配置实测。
- 密钥与 Provider、模型元数据都保留在本机浏览器，删除服务商或清除站点数据才会移除密钥。无鉴权本地模型取消“接口需要 API key”。Chat Mock 支持相同真实调用，但会话和 Provider 配置只存在本次预览内存中。

## Linux 启动时 DevTools 缺少共享库

如果 `npm run web` 提示 `react-native-devtools: error while loading shared libraries: libatk-1.0.so.0`，是 React Native DevTools 的 Electron 桌面程序缺少系统图形库，不是应用代码错误。当前依赖会在 Metro 初始化时准备该程序，因此只启动 Web 也可能看到此错误；Web 页面使用浏览器开发者工具调试。

本机 Ubuntu 22.04 的 DevTools 二进制通过 `ldd` 检查，还缺少 GTK、Pango、AT-SPI、X11、GBM 与 ALSA 相关库。可在有管理员权限的终端安装：

```bash
sudo apt update
sudo apt install libatk1.0-0 libatk-bridge2.0-0 libgtk-3-0 libpango-1.0-0 libatspi2.0-0 libxcomposite1 libxdamage1 libxfixes3 libgbm1 libxkbcommon0 libasound2
npm run web
```

以上包名对应 Ubuntu 22.04；其他发行版需使用各自包名。打开桌面版原生 DevTools 还需要可用的图形会话，WSL 通常由 WSLg 提供。不要为此修改聊天代码、删除锁文件或重装业务依赖。


- 模型 SVG 图标来自 `@thesvg/react`，按单图标路径导入，选择品牌提供的彩色版本并保留原始填色/渐变；无需图标生成脚本，也不运行时请求外部图片。
