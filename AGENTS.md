# AGENTS.md

Matrius 是 React 19 + TypeScript（Vite 8）UI 与单 Node/TypeScript 后端的自部署 AI 对话应用。应用代码根目录只有三块：`ui/`（前端）、`server/`（后端）、`contract/`（前后端共用的类型契约，仅 `type`）。Python/FastAPI 后端已移除；服务端是唯一业务实现。

## 开始前

- 前端是普通 React Web 应用，使用 Vite 8 构建、React Router 7 路由；不要再引入 Expo、React Native Web 或 Metro。
- 按任务阅读对应文档：

| 任务 | 文档 |
| --- | --- |
| 产品边界与开发顺序 | [产品](doc/product.md) |
| 页面、模块与文件职责 | [客户端结构](doc/client-structure.md) |
| 存储与数据访问 | [存储与数据](doc/data.md) |
| 认证与功能开关 | [实例访问](doc/instance.md) |
| 后端接口与数据模型 | [后端架构](doc/backend.md)、[server/README.md](server/README.md) |
| 命令、测试与交付 | [开发与验证](doc/development.md) |
| 服务器与运维 | [服务器部署](doc/deployment.md) |

## 常用命令

```bash
npm ci
npm run dev                 # 本机 Node API + Vite，数据在 server/.data
npm run dev:server          # 只启动 TypeScript/Fastify 后端（tsx watch）
npm run build               # Vite 生产构建到 dist/
npm run db:migrate          # 只迁移本机开发库
npm run test                # UI/共享测试，按文件串行执行
npm run test:server         # 后端测试（node:test + tsx）
npm run typecheck:server    # 后端类型检查
npx tsc --noEmit            # UI 类型检查
npx eslint .                # 使用 eslint.config.mjs 检查，可选
```

`npm run dev` 支持 `--check`、`--reset-db` 和 `--clear`（重建 Vite 依赖预构建）；`npm run dev -- --clear` 等价于给 Vite 传 `--force`。Node API 启动时自动执行 baseline migration，不需要 Python、uv 或 Alembic CLI。

## 前端约定

- 前端是 React 19 + TypeScript 的普通 Web 应用，Vite 8 构建、React Router 7 路由；入口是根目录 `index.html` 与 `ui/main.tsx`。
- 路由只有一个事实源：`ui/router/routes.tsx`。新增页面必须在其中注册；除聊天路由外页面使用 `React.lazy`；`/mock/*` 由 `MockOnly` 保护，生产构建直接回到 `/`，未知 URL 也重定向到 `/`。
- 导航统一从 `@/router` 导入 `Link`（支持 `asChild`）、`router.push/replace/back`、`Redirect`、`usePathname`、`useLocalSearchParams` 和 `Href`；功能代码不要直接导入 `react-router-dom`。
- 不再有 `.web.tsx` / `.web.ts` 后缀、平台 fallback 兄弟文件或 `ui/app/`；所有页面与组件都是普通 `X.tsx` / `X.ts`，只维护 Web + PWA 目标。
- 页面外壳在 `ui/components/web/app-shell.tsx`；只在 Web 端运行，不添加原生工程、移动端壳或第二套路由。
- 生产 Web 支持 PWA：`index.html` 直接包含 manifest 链接、主题色与 Apple 触摸图标元数据，`public/sw.js` 缓存应用外壳；不再有导出后 HTML 注入步骤。

## 架构与边界

- 依赖方向：UI → features → repository → API / storage。
- Agent Runtime 与模型工具模块都在 `server/agent`（工具在 `server/agent/tools`），通过 `POST /api/agent/runs` 的 SSE 与 UI 通信。服务端工具由 Agent 直接调用 `server/services/*`，不再通过 HTTP 回调自身。`ui/core/agent` 只剩测试注入的浏览器实现和共享小工具，生产聊天不再使用；后续可删除。
- 单用户实例：服务端是业务数据的唯一事实源，不提供本地工作区、匿名使用或本地/云端切换；IndexedDB 仅存模型配置、密钥和设备状态。
- 模型配置与 API key 只持久化在客户端；每次 Agent run 临时发送给服务端，服务端不落库、不写日志。若迁移后的默认实现变化，必须先更新文档和设置说明。
- 无需登录，所有客户端共享唯一实例；业务表使用 instance_id=1，写操作使用 baseRevision 乐观并发。
- 持久数据在 `DATA_DIR/matrius.db`，文件落在 `DATA_DIR/files/<fileId>/<文件名>`，文档草稿落在 `DATA_DIR/drafts`（进程内元数据 + 文件系统，重启即失效），限流与短期缓存只存在于 Node 进程内存。首版 TypeScript 后端不改 schema，继续用 `alembic_version`；之后的迁移走 `server/db/migrations/`。
- 文档引擎：`server/vendor/officecli` 负责现代 DOCX/XLSX/PPTX 的结构查看与编辑；旧版 DOC/XLS/PPT 转换使用 `@deepseek-ai/libreoffice-kit`；PDF 由 Node 的 `pdf-lib` + `unpdf` 处理。工具与 Agent 都在服务端，OfficeCLI 仍作为受控子进程。macOS 本机需设置 `OFFICECLI_PATH`。
- 保持简单：不引入微服务、多 Agent 编排、RBAC、组织、租户或多用户管理；`/admin` 与 `/api/admin/*` 已移除。
- 新增状态管理、网络或代码生成库前先与维护者确认。

## 功能开关

- 新功能先在 `server/features/registry.ts` 登记。登记后对所有访问实例的客户端生效，没有账户、角色或预览白名单。
- 前端统一用 `useFeature` / `FeatureGate`，后端用 `require_feature`，禁止按客户端用户名授权。
- 在本机 `npm run dev` 验证通过后再提交；部署命令恢复前不要发布到实例。

## 部署

- 部署命令已暂时禁用：镜像/Compose 仍在从 Python API 切到 Node API，`npm run deploy` 已从 `package.json` 移除；切换完成后再恢复。
- `npm run dev` 完全在本机常驻运行 Node API 与 Vite，数据在 `server/.data/matrius.db` 和 `server/.data/files`，不访问服务器；Ctrl+C 仅停止本机进程。Node 启动时自动迁移开发库；开发会话已运行时可用 `npm run db:migrate` 单独升级同一个开发库。
- 部署成功后，`server/features/registry.ts` 中登记的功能立即对实例开放。
- 生产只运行 Caddy / Web / API 三个容器，持久化只有 `matrius_prod_api_data` 卷（SQLite + 上传文件）。API 镜像额外包含 Linux OfficeCLI、LibreOffice 与中文字体，镜像会明显增大；`/tmp` 使用 512 MiB tmpfs 供转换使用。
- API 必须保持单 Node 进程：文档草稿、限流和缓存都在进程内，多 worker 会不可见且互相拆分限额。部署命令恢复后仍应保持这一约束。
- `.env.local` 管本地开发与通用应用设置：`DEV_WEB_PORT` / `DEV_API_PORT`、限额等。服务器相关内容放在 `docker-compose/.env.production`（SSH 目标、`APP_PORT` / `API_PORT` / `APP_HTTPS_PORT`、`REMOTE_WORKSPACE`），部署命令恢复后从该文件读取；`.env.local` 只作覆盖。`.env.local` 中的通用应用项（限额、`LOG_LEVEL` 等）会在部署时写入服务器 `production.env`。本机代理写 `WEBTOOL_PROXY_URL`，只在开发时使用、不会上传；生产代理写 `WEBTOOL_PROXY_URL_PRODUCTION`，部署时映射为服务器的 `WEBTOOL_PROXY_URL`，且必须是容器可达地址（`host.docker.internal` 等，loopback 会被拒绝）。启动与部署不再创建或更新账户凭据。`dev` 不连接服务器，也不读取生产配置。
- 不在本机对服务器执行迁移；`docker compose down` 永远不加 `-v`。
- 不配置自动 CI；部署命令恢复后再手动 CD。

## 完成前

- 完成任务前按改动范围验证，如实报告实际执行了什么：文案、样式、单个组件局部调整等小改动只做类型检查或运行相关测试，不必跑全量 `npm run test`；共享逻辑、数据/持久化、模型/协议、构建配置或跨模块行为改动才跑全量测试。不要声称执行了未运行的测试。
- 涉及 TypeScript 代码时至少运行 `npx tsc --noEmit`；涉及代码风格时可再运行 `npx eslint .`。
- 未实测的浏览器行为要说明范围，不把推断写成已验证。
- 产品边界、持久化、目录职责或命令变化时同步更新 `doc/` 和 README。
- 不提交密钥、令牌或真实用户数据。
