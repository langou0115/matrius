# AGENTS.md

Matrius 是 React 19 + TypeScript（Vite 8）UI 与单 Node/TypeScript 后端的自部署 AI 对话应用。应用代码根目录只有三块：`ui/`（前端）、`server/`（后端）、`contract/`（前后端共用的类型与无副作用纯逻辑，不得 import Node/DOM/React/数据库）。Python/FastAPI 后端已移除；服务端是唯一业务实现。

## 开始前

- 前端是普通 React Web 应用，使用 Vite 8 构建、React Router 7 路由；不要再引入 Expo、React Native Web 或 Metro。
- 按任务阅读对应文档：

| 任务 | 文档 |
| --- | --- |
| 产品边界与开发顺序 | [产品](doc/product.md) |
| 页面、模块与文件职责 | [客户端结构](doc/client-structure.md) |
| 界面视觉与交互规范 | [UI 风格](doc/ui-style.md) |
| 存储与数据访问 | [存储与数据](doc/data.md) |
| 实例访问与功能开关 | [实例访问](doc/instance.md) |
| 后端接口与数据模型 | [后端架构](doc/backend.md)、[server/README.md](server/README.md) |
| 命令、测试与交付 | [开发与验证](doc/development.md) |

## 常用命令

```bash
npm ci
npm run dev                 # 本机 Node API + Vite（默认 Web 端），数据默认在 ~/.matrius
npm run dev:web             # 显式以 Web 端启动本机开发服务
npm run dev:desktop         # 以桌面端预览模式启动（显示桌面端专属「工作 / 对话」切换栏）
npm run dev:server          # 只启动 TypeScript/Fastify 后端（tsx watch）
npm run build               # 只执行 Vite 生产构建到 dist/
npm run start               # 先全量构建 dist/，再单进程启动（读 .env.local 并托管界面与 /api/*）
npm run db:migrate          # 只迁移本机开发库
npm run test                # UI/共享测试，限制文件级并发（--test-concurrency=2）
npm run test:server         # 后端测试（node:test + tsx），限制文件级并发（--test-concurrency=2）
npm run typecheck:server    # 后端类型检查
npx tsc --noEmit            # UI 类型检查
npx eslint .                # 使用 eslint.config.mjs 检查，可选
```

`npm run dev` 支持 `--check`、`--reset-db` 和 `--clear`（重建 Vite 依赖预构建）；`npm run dev -- --clear` 等价于给 Vite 传 `--force`。Node API 启动时自动执行 baseline migration，不需要 Python、uv 或 Alembic CLI。

## 前端约定

- 前端是 React 19 + TypeScript 的普通 Web 应用，Vite 8 构建、React Router 7 路由；入口是根目录 `index.html` 与 `ui/main.tsx`。
- 路由只有一个事实源：`ui/router/routes.tsx`。新增页面必须在其中注册；除聊天路由外页面使用 `React.lazy`；`/debug` 与 `/mock/*` 由 `DevOnly` 保护，生产构建直接回到 `/`，未知 URL 也重定向到 `/`。
- 导航统一从 `@/router` 导入 `Link`（支持 `asChild`）、`router.push/replace/back`、`Redirect`、`usePathname`、`useLocalSearchParams` 和 `Href`；功能代码不要直接导入 `react-router-dom`。
- 不再有 `.web.tsx` / `.web.ts` 后缀、平台 fallback 兄弟文件或 `ui/app/`；所有页面与组件都是普通 `X.tsx` / `X.ts`。工作（Work）相关功能与界面（侧栏「工作 / 对话」切换栏与设置页「工作 → 主机」管理）仅面向桌面端（`npm run dev:desktop` 预览），网页端（Web / PWA）及移动端均按 Web 端处理，不提供也没有工作相关功能。
- 页面外壳在 `ui/components/web/app-shell.tsx`；只在 Web 端运行，不添加原生工程、移动端壳或第二套路由。
- 生产 Web 支持 PWA：`index.html` 直接包含 manifest 链接、主题色与 Apple 触摸图标元数据，`public/sw.js` 缓存应用外壳；不再有导出后 HTML 注入步骤。

## 架构与边界

- 依赖方向：UI → features → repository → API / storage。
- Agent Runtime 与模型工具模块都在 `server/agent`（工具在 `server/agent/tools`），通过 `POST /api/agent/runs` 的 SSE 与 UI 通信。服务端工具由 Agent 直接调用 `server/services/*`，不再通过 HTTP 回调自身。UI 只保留客户端通信（`ui/core/api/agent-runs.ts` 消费 SSE、`ui/core/api/agent-aux.ts` 请求标题与记忆）；上下文组装、token 估算、系统提示、提示词包装与 Provider 校验等纯逻辑在 `contract/agent-*.ts`，两端共用同一份，不再各存副本。
- 单用户实例：服务端是业务数据的唯一事实源，不提供本地工作区、匿名使用或本地/云端切换；模型服务配置与 API key 保存在服务端 SQLite（`model_configs` 表），不再持久化到浏览器 IndexedDB；客户端只发送模型选择，不回传明文密钥。
- 若 `.env.local`（或环境变量）配置了 `AUTH_SECRET`，所有受保护 `/api/*` 与 `/debug*` 均需先在开屏界面输入密钥，通过后由服务端签发 HMAC 校验的 `HttpOnly` Cookie 放行；未配置 `AUTH_SECRET` 时保持免登录直连。
- 所有客户端共享唯一实例；业务表使用 instance_id=1，写操作使用 baseRevision 乐观并发。
- 持久数据在 `DATA_DIR/matrius.db`（默认 `~/.matrius/matrius.db`），文件落在 `DATA_DIR/files/<fileId>/<文件名>`，文档草稿落在 `DATA_DIR/drafts`（进程内元数据 + 文件系统，重启即失效），限流与短期缓存只存在于 Node 进程内存。上传文件总量受 `STORAGE_LIMIT_BYTES` 限制（默认 128 MiB），不读取部署主机磁盘容量。首版 TypeScript 后端不改 schema，继续用 `alembic_version`；之后的迁移走 `server/db/migrations/`。
- 文档引擎：`server/vendor/officecli` 负责现代 DOCX/XLSX/PPTX 的结构查看与编辑；旧版 DOC/XLS/PPT 转换使用 `@deepseek-ai/libreoffice-kit`；PDF 由 Node 的 `pdf-lib` + `unpdf` 处理。工具与 Agent 都在服务端，OfficeCLI 仍作为受控子进程。macOS 本机需设置 `OFFICECLI_PATH`。
- 保持简单：不引入微服务、多 Agent 编排、RBAC、组织、租户或多用户管理；`/admin` 与 `/api/admin/*` 已移除。
- 新增状态管理、网络或代码生成库前先与维护者确认。

## 功能开关

- 新功能先在 `server/features/registry.ts` 登记。登记后对所有访问实例的客户端生效，没有账户、角色或预览白名单。
- 前端统一用 `useFeature` / `FeatureGate`，后端用 `require_feature`，禁止按客户端用户名授权。
- 在本机 `npm run dev` 或 `npm run start` 验证通过后再提交；不配置多机服务器发布。

## 运行与部署

- 不做镜像构建与云端自动发布；日常个人使用直接执行 `npm run start`（先全量打包 `dist/`，再以单 Node 进程托管前端与 `/api/*`，需要外部访问时可搭配 `cpolar` 等隧道及 `AUTH_SECRET`）。
- `npm run dev` 在本机并行运行 Node API 与 Vite 热更新，数据默认在 `~/.matrius/matrius.db` 和 `~/.matrius/files`（`.env.local` 的 `DATA_DIR` 可改写）；Ctrl+C 仅停止本机进程。Node 启动时自动迁移数据库；开发会话已运行时可用 `npm run db:migrate` 单独升级同一个开发库。
- `.env.local` 管本地开发与生产通用应用设置：`AUTH_SECRET`、`AUTH_SESSION_TTL_SECONDS`、`DATA_DIR`、`STORAGE_LIMIT_BYTES`、`WEB_PORT` / `API_PORT`、限额、`LOG_LEVEL` 与 `WEBTOOL_PROXY_URL` 等（生产模式同样读取 `.env.local`，进程环境变量优先级更高；`npm run start` 监听 `API_PORT`，默认 `8000`）。
- API 必须保持单 Node 进程：文档草稿、限流和缓存都在进程内，多 worker 会不可见且互相拆分限额。
- 不配置自动 CI。

## 完成前

- 完成任务前按改动范围验证，如实报告实际执行了什么：文案、样式、单个组件局部调整等小改动只做类型检查或运行相关测试，不必跑全量 `npm run test`；共享逻辑、数据/持久化、模型/协议、构建配置或跨模块行为改动才跑全量测试。不要声称执行了未运行的测试。
- 涉及 TypeScript 代码时至少运行 `npx tsc --noEmit`；涉及代码风格时可再运行 `npx eslint .`。
- 未实测的浏览器行为要说明范围，不把推断写成已验证。
- 产品边界、持久化、目录职责或命令变化时同步更新 `doc/` 和 README。
- 不提交密钥、令牌或真实用户数据。
