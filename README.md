# Matrius

轻量级、单用户、可自部署的 AI 对话应用。前端基于 React 19 + TypeScript + Vite 8，后端采用单进程 Node 24 + Fastify + `node:sqlite`，支持桌面与移动 Web 响应式布局及 PWA 安装。

[功能特性](#功能特性) · [快速开始](#快速开始) · [环境配置](#环境配置) · [开发与命令](#开发与命令) · [项目结构](#项目结构) · [开发文档](#开发文档)

---

## 设计理念

- **单用户单一事实源**：没有复杂的多租户、组织或 RBAC 控制台；对话、记忆、文件、Token 用量与模型配置统一持久化在本机服务端 SQLite（默认 `~/.matrius`），更换设备或域名无需重配。
- **开箱即用，单进程运行**：`npm run start` 自动构建静态产物并由单个 Node 进程同时托管前端页面与 `/api/*`，可直接配合端口转发或反代工具（如 `cpolar`、Caddy、Nginx）使用。
- **密钥不回传浏览器**：模型服务商配置与 API Key 存储在服务端 `model_configs` 表中，请求时由服务端直接读取并调用上游，不回传明文给前端，也不写入日志。

---

## 功能特性

- **多轮流式对话**：支持停止生成、生成中纠偏（steer）、划词引用、会话分支（fork）、标题与正文搜索、置顶与 AI 自动标题；思考与工具执行过程按发生顺序实时展示，中断后保留已生成内容与上下文。
- **网页端边界**：网页端仅提供对话、资料库、定时任务与设置等核心能力；**工作（Work）相关功能仅面向桌面端（Desktop），网页端不提供**（本地可通过 `npm run dev:desktop` 预览桌面端入口）。
- **完整富文本渲染**：基于 Streamdown 渲染 Markdown / GFM 表格与脚注、KaTeX 数学公式、Shiki 按需代码高亮与 Mermaid 图表，联网引用自动编号并与来源侧栏联动。
- **多模型自带密钥（BYOK）**：支持 OpenAI Chat Completions、OpenAI Responses、Anthropic Messages 及兼容协议；支持从服务端代理拉取服务商模型列表，并为对话、标题生成与个人记忆分别指定模型。
- **服务端 Agent 工具链**：
  - **联网检索与读取**：内置 DuckDuckGo / Bing RSS 搜索（含官网公告/Changelog 补全）与网页正文提取。
  - **资料库与文档处理**：支持文件上传、逻辑配额控制（默认 `128 MiB`）与搜索排序；模型可通过 `file` 工具读取、检索、创建与编辑 TXT/Markdown/CSV/DOCX/XLSX/PPTX/PDF 文档（集成 OfficeCLI、LibreOffice 转换与 `pdf-lib` / `unpdf`）。
  - **交互卡片、记忆与定时任务**：支持结构化 UI 块输出、后台个人记忆摘要整理、个性化指令，以及按周期或一次性触发的定时任务。
- **轻量访问锁与 PWA**：可通过 `.env.local` 配置 `AUTH_SECRET` 启用开屏密钥解锁（HMAC 签名 `HttpOnly` Cookie），未配置时免登录直连；支持安装为 PWA 缓存应用外壳。

---

## 快速开始

### 环境要求

- **Node.js 24+** 与 **npm**（使用 Node 内置 `node:sqlite`，支持 Linux、macOS、Windows，无需 Python、uv 或外部数据库）

### 启动应用

```bash
git clone <your-repo-url>
cd matrius
npm ci
npm run start
```

- `npm run start` 会先执行完整前端打包（`vite build` 输出到 `dist/`），随后启动单进程服务端（自动初始化数据库并托管界面与 `/api/*`）。
- 启动就绪后终端会打印访问地址（默认 `http://localhost:8000`）。

### 可选：本地配置文件 `.env.local`

```bash
cp .env.local.example .env.local
```

若需要通过内网穿透（如 `cpolar`）在手机等外网设备访问，建议在 `.env.local` 中设置 `AUTH_SECRET` 开启开屏访问锁，并将穿透目标指向配置好的 `API_PORT`（单进程只需暴露一个端口）。

---

## 环境配置

`.env.local` 在开发模式与 `npm run start` 生产模式下均会读取，进程环境变量优先级高于 `.env.local`（`APP_ENV=test` 时跳过 `.env.local`）。

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `API_PORT` | `8000` | Node 后端与 `npm run start` 单进程监听端口 |
| `WEB_PORT` | `8081` | 仅 `npm run dev` 时 Vite 前端热更新监听端口 |
| `HOST` | `0.0.0.0` | Fastify 绑定地址；仅本机反代/隧道转发时可设为 `127.0.0.1` |
| `AUTH_SECRET` | 空 | 设置后开启开屏访问密钥锁；留空则免登录直连 |
| `AUTH_SESSION_TTL_SECONDS` | `604800` | 已解锁 `HttpOnly` Cookie 有效期（秒，默认 7 天） |
| `DATA_DIR` | `~/.matrius` | 数据根目录，存放 `matrius.db`、`files/` 与 `drafts/` |
| `STORAGE_LIMIT_BYTES` | `134217728` | 资料库文件总量逻辑配额（字节，默认 128 MiB） |
| `WEBTOOL_PROXY_URL` | 空 | 联网搜索与网页抓取可选上游 HTTP/SOCKS 代理地址 |
| `ENABLE_DEBUG_PAGE` | 开发开启 / 生产关闭 | 是否启用 `/debug`（本地 Swagger 与健康检查） |
| `LOG_LEVEL` | `info` | Fastify / Pino 日志级别（已对密钥与 Cookie 字段脱敏） |

更多环境变量见 [.env.local.example](.env.local.example) 与 [server/README.md](server/README.md)。

---

## 开发与命令

```bash
npm run start              # 先全量构建 dist/，再启动单进程生产服务（读取 .env.local）
npm run dev                # 开发模式：默认启动 Web 端（Node API + Vite 热更新）
npm run dev:web            # 显式以 Web 端启动开发模式
npm run dev:desktop        # 以桌面端预览模式启动（显示桌面端专属「工作 / 对话」切换栏）
npm run dev:server         # 仅启动 Node/Fastify 后端（tsx watch 自动重载）
npm run build              # 仅执行 Vite 生产构建到 dist/
npm run db:migrate         # 手动执行开发库 SQL 迁移
npm run test               # 运行前端与共享脚本测试（按文件并发）
npm run test:server        # 运行后端测试（node:test + tsx，按文件并发）
npm run typecheck:server   # 后端 TypeScript 类型检查
npx tsc --noEmit           # 前端 TypeScript 类型检查
npx eslint .               # ESLint 检查
```

- `npm run dev` 支持 `--check`（校验环境与端口）、`--reset-db`（清空开发库与文件）与 `--clear`（重建 Vite 依赖预构建）。
- 开发模式默认访问 `http://localhost:8081`（或 `.env.local` 中的 `WEB_PORT`），提供 `/debug` 接口调试页与 `/mock` 示例预览页；生产构建会自动关闭 `/mock/*`。

---

## 项目结构

```text
matrius/
├── ui/                  # React 19 前端界面、路由与客户端状态（Vite 8）
├── server/              # 单进程 Node/Fastify 后端（SQLite、Agent、工具、文档与搜索）
├── contract/            # 前后端共用契约与纯逻辑（禁止依赖 Node / DOM / React / DB）
├── scripts/             # 启动、开发引导与 KaTeX 资源同步脚本
├── public/              # 静态资源、PWA manifest、Service Worker 与文件图标
├── tests/               # 前端、共享逻辑与启动脚本测试
├── doc/                 # 架构、产品、存储与开发规范文档
└── .env.local.example   # 环境变量配置模板
```

默认数据目录结构：

```text
~/.matrius/              # 可通过 DATA_DIR 覆盖
├── matrius.db           # SQLite 主库（含 WAL 文件）
├── files/<fileId>/      # 上传文件与工具保存的文档
└── drafts/<draftId>/    # 文档编辑临时草稿（进程重启失效）
```

---

## 技术栈

| 模块 | 选型 |
| --- | --- |
| 前端界面 | React 19、TypeScript、Vite 8、React Router 7、Tailwind CSS v4、Streamdown、KaTeX、Shiki |
| 后端服务 | Node 24、TypeScript、Fastify、node:sqlite（WAL）、Zod、TypeBox |
| 模型与工具 | `@mariozechner/pi-ai` / `pi-agent-core`、OfficeCLI、`@deepseek-ai/libreoffice-kit`、`pdf-lib`、`unpdf` |

---

## 开发文档

| 文档 | 说明 |
| --- | --- |
| [文档索引](doc/README.md) | 全部专题文档目录 |
| [产品与开发边界](doc/product.md) | 单用户实例定位、核心功能与边界约定 |
| [架构与模块边界](doc/architecture.md) | 三层目录边界、认证与数据流 |
| [实例访问与资源](doc/instance.md) | `AUTH_SECRET` 访问锁、特性清单与存储配额 |
| [存储与数据](doc/data.md) | SQLite schema、文件目录、`baseRevision` 并发与密钥隔离 |
| [Agent、模型与工具](doc/agent.md) | 服务端 Agent Runtime、SSE 协议与工具规范 |
| [客户端结构与修改入口](doc/client-structure.md) | 前端模块清单、路由与响应式断点 |
| [开发与验证](doc/development.md) | 本地启动、缓存机制、测试规范与交付检查 |
| [后端说明](server/README.md) | Fastify 路由、配置项、迁移与工具开发规范 |
