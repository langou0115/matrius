# 开发文档索引

本目录维护 Matrius 的产品边界、架构约定、存储契约、Agent Runtime、客户端结构与开发验证规范。

## 当前现状

- 前端已实现桌面与移动 Web 响应式界面（767px 断点）及 PWA 应用外壳，入口为根目录 `index.html` 与 `ui/main.tsx`。
- 后端为单 Node/TypeScript 进程（Fastify + `node:sqlite`），入口为 `server/main.ts`；Agent Runtime、工具调用、搜索抓取与文档处理全部位于服务端，浏览器通过 `/api/agent/runs` 的 SSE 消费运行事件。
- 单用户实例：会话、消息、记忆、个性化、文件、Token 用量、定时任务以及模型配置与 API Key 均以服务端 SQLite 为唯一事实源；可通过 `.env.local` 配置 `AUTH_SECRET` 启用开屏访问密钥锁（`HttpOnly` Cookie），未配置时免登录直连。
- 日常使用单进程 `npm run start`（先全量构建 `dist/`，再启动 Node 服务同时托管页面与 `/api/*`）；开发调试使用 `npm run dev`。后端契约与说明见[后端架构](backend.md)与[server/README.md](../server/README.md)。

| 文档 | 内容 |
| --- | --- |
| [产品与开发边界](product.md) | 单用户实例定位、核心功能与技术边界 |
| [架构与模块边界](architecture.md) | `ui/` / `server/` / `contract/` 分层、认证与存储边界 |
| [实例访问与资源](instance.md) | `AUTH_SECRET` 密钥锁、特性列表与存储配额 |
| [存储与数据](data.md) | SQLite、文件目录、服务端模型密钥、`baseRevision` 并发与迁移 |
| [后端架构](backend.md) | Node/Fastify 边界、SSE 接口、并发控制与服务概览 |
| [Agent、模型与工具](agent.md) | 服务端 Agent Runtime、模型目录与内置工具边界 |
| [文件读取与个人记忆](files-and-memory.md) | 文档工具与引擎限制、个人记忆摘要提炼与注入 |
| [客户端结构与修改入口](client-structure.md) | 实际文件目录、路由、响应式与各功能模块入口 |
| [Web 客户端约定](client.md) | 路由、主题、字体、Streamdown 渲染与浏览器适配 |
| [UI 风格与交互规范](ui-style.md) | 界面视觉规范、断点尺寸、图标与无障碍规则 |
| [开发与验证](development.md) | 启动命令、`.env.local` 配置、缓存机制与测试规范 |
| [模板迁移记录](migration.md) | 历史迁移归档（旧多账户、客户端 Runtime 与 Python 后端已废弃） |
| [历史压测记录](performance.md)、[多账户压测（历史）](performance-multiaccount.md) | 已移除的 Python/FastAPI 后端压测存档，不适用于当前 Node 后端 |

## 文档维护约定

- `AGENTS.md` 保留给编码助手的核心约束和入口索引，专题细节写在对应文档。
- 目录或功能模块变动时同步更新 `doc/client-structure.md`；命令或配置变化同步更新 `README.md`、`doc/development.md` 与 `AGENTS.md`。
- 区分已实现现状与后续规划，不把历史方案或未实现目标写成现状。
