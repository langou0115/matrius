本项目为无需登录的单用户实例；所有访问者共享数据。资源设置中的磁盘容量来自服务器数据目录所在文件系统（容器内为数据卷所在文件系统），不再使用账户配额。详见[实例访问](doc/instance.md)。

# Matrius

轻量、单用户实例、可自行部署的 AI 对话应用。提供桌面与移动 Web 响应式界面，支持安装为 PWA。

> 后端已迁移到单 Node/TypeScript 进程。应用代码位于 `ui/`、`server/`、`contract/`；`npm run dev` 启动 Node API + Vite。

## 特性

- **多轮对话**：流式回复、停止、引用、分支、搜索与置顶；思考、工具与后续思考按事件顺序展示，整轮连续计时，中断保留内容和上下文
- **单用户实例**：访问唯一工作区，对话和文件统一保存到实例后端
- **自带模型**：支持 OpenAI Chat Completions、Responses、Anthropic Messages 及兼容服务，密钥只保存在本机
- **完整渲染**：Markdown / GFM、KaTeX 公式、代码高亮、复制与折叠
- **无登录**：所有客户端共享唯一实例，没有账户或管理员控制台
- **自部署后端**：Node 24 + Fastify + SQLite + 本地文件存储 + 进程内缓存，Caddy 统一入口
- **远程发布**：本机一条命令，服务器构建并运行 Caddy / Web / API 三个容器
- **可安装 Web 应用**：提供 PWA manifest 与 service worker，安装后可离线打开应用外壳

> 每个实例只有一个所有者，没有本地/云端模式切换。聊天、记忆与偏好以服务端为唯一事实源；模型配置与 API key 保存在当前浏览器。外部多用户/实例管理不在本项目范围内。

模型回复失败时，可在浏览器 Console 查看 `[Matrius Agent]`，或执行 `copy(matriusDiagnostics.export())` 导出当前页面的诊断摘要（不含密钥和正文）；字段说明见[模型回复诊断](doc/development.md#模型回复诊断)。

## 技术栈

| 部分 | 选型 |
| --- | --- |
| 客户端 | React 19、TypeScript、Vite 8 |
| 路由 | React Router 7（`ui/router/routes.tsx`） |
| 后端 | Node 24、TypeScript、Fastify、SQLite |
| 运行时能力 | 进程内缓存/限流、本地文件存储、DuckDuckGo 优先（Bing 回退）搜索、Node 正文提取；旧版 Office 用 `@deepseek-ai/libreoffice-kit`，现代 Office 用 OfficeCLI，PDF 用 `pdf-lib` + `unpdf` |
| 基础设施 | Caddy（生产只运行 Caddy / Web / API 三个容器） |
| 部署 | 暂时禁用（Docker/Compose 待切换到 Node API） |

## 本地开发

要求 Node.js 24 和 npm。支持 Windows、macOS、Linux，不需要 Python、uv、Docker、SSH 或 WSL。

下面命令须在包含 `package.json` 的项目根目录运行；其他目录可使用 `npm --prefix <项目绝对路径> run dev`。若报用户目录下找不到 `package.json`（ENOENT），先切换到项目目录。

```bash
npm ci
npm run dev           # Node API + Vite
npm run dev:server    # 只启动 TypeScript/Fastify 后端
```

打开 `http://localhost:8081`，在「设置 → 模型服务」添加服务商和模型后即可对话。


开发模式可访问 `/mock`，其中 `/mock/process` 可预览思考过程、工具步骤和中断状态，`/mock/storage` 可预览保存失败提示，均不调用模型；回答末尾的来源区留待后续实现。Vite 的 HMR 会自行重连，模型回复生成期间不再暂停热更新；刷新或离开页面时仍保留 `beforeunload` 确认，避免误丢正在进行的回复。正式 Web 使用静态生产构建。

```bash
npm run build   # Vite 生产构建到 dist/（Dockerfile.web 使用）
npm run test    # 全部测试，按文件串行执行
```

## 部署

服务器只需 Docker、SSH 和常用命令行工具，本机不需要 Python、Docker 或数据库。

> 部署命令已暂时禁用：镜像/Compose 仍在从 Python API 切到 Node API，`npm run deploy` 已从 `package.json` 移除。开发与测试使用 `npm run dev`；部署恢复前不要按旧文档发布。历史部署说明见[服务器部署](doc/deployment.md)。


默认端口：`16666` 为网页 + API，`16667` 仅 API（可选）；在 `docker-compose/.env.production` 用 `APP_PORT` / `API_PORT` 覆盖，详见[修改端口](doc/deployment.md#修改端口)。每次命令完成同步、构建、健康检查后退出；功能清单中的能力在部署成功后对实例开放。

Web/API 源码直接打入各自镜像，不挂载源码、不运行开发服务器；`matrius_prod_api_data` 数据卷长期保留。

服务器初始化、实例、HTTPS、备份与 CD 见[服务器部署](doc/deployment.md)。

## 文档

| 文档 | 内容 |
| --- | --- |
| [文档索引](doc/README.md) | 全部文档入口 |
| [产品](doc/product.md) | 产品边界与本地/实例 |
| [后端](doc/backend.md) | API、数据模型与实现 |
| [实例访问](doc/instance.md) | 实例登录、迁移与功能能力 |
| [开发与验证](doc/development.md) | 命令、构建、测试与 Mock |
| [服务器部署](doc/deployment.md) | 初始化、发布、备份与运维 |

## 验证

```bash
npx tsc --noEmit
npm run typecheck:server
npm run test
npm run test:server
npx eslint .        # 可选，使用 eslint.config.mjs
```

新后端结构与迁移规则见[server/README.md](server/README.md)。

## 许可

见 [LICENSE](LICENSE)。
