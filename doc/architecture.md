# 架构与模块边界

[文档索引](README.md)

## 单用户实例

```text
根目录三块：
ui/          React 19 + Vite + React Router 7 + SSE 客户端
server/      Fastify、SQLite、工具、文档服务
contract/    前后端共用的类型契约（仅 type，编译后消失）

ui/
├── 聊天 UI、会话状态
├── Agent Runtime 在 server/agent；客户端只保留 SSE 通信适配
├── REST + SSE /api/* → Node/Fastify → SQLite / 文件系统
└── IndexedDB：模型配置、密钥与设备状态

server/
├── routes/      REST 路由
├── services/    搜索、抓取、文件、文档、PDF
├── agent/       Agent 循环、上下文、压缩、标题、记忆、工具模块
└── db/          SQLite、codecs、迁移
```

服务端是业务数据的唯一事实源，不提供匿名本地工作区、双向同步或本地/云端模式切换。
Agent Runtime 与服务端工具位于 `server/agent`；浏览器只保留 SSE 通信适配与展示逻辑。
模型配置与密钥只持久化在当前浏览器；每次 Agent run 临时发送给服务端，服务端不落库、不写日志。

## 单用户实例与访问

每个部署只有一个工作区，`instance` 单例表绑定唯一 `id`。
无需登录；所有可访问部署地址的客户端共享同一实例数据。
没有用户创建、角色、用户停用、`/admin` 或 `/api/admin/*`。
跨设备与多标签页仍使用 `baseRevision` 防止静默覆盖。
`/api/workspace/import` 保留作旧数据导入兼容，不能用来访问或混入其他历史实例的数据。

外部多用户、域名分配与实例管理属于另一个项目，本工程短期不做。

## 存储

- 本机默认：`~/.matrius/matrius.db`、`~/.matrius/files/<fileId>/<文件名>`；`.env.local` 的 `DATA_DIR` 可改写数据根目录。
- 临时草稿在 `DATA_DIR/drafts/<draftId>/`，元数据仅在 API 内存，重启失效。
- 上传文件总量受 `STORAGE_LIMIT_BYTES` 限制（默认 128 MiB），不读取主机磁盘容量。
- 搜索结果缓存、限流和并发计数在进程内；Node 服务保持单进程。
- 首版 TypeScript 后端不改 schema，继续使用 `alembic_version`；数据迁移走 `server/db/migrations/`，旧库选择与旧文件迁移见[存储与数据](data.md)。

## 依赖与职责

UI → features → repository → API / storage。
路由事实源为 `ui/router/routes.tsx`，页面外壳为 `ui/components/web/app-shell.tsx`。
模型、聊天、记忆、文件、设置分别位于 `ui/features/`，无 DOM 的客户端协议适配位于 `ui/core/`。
服务端 Agent 目标位于 `server/agent/`，模型工具模块位于 `server/agent/tools/`，业务服务位于 `server/services/`，REST 路由位于 `server/routes/`。
开发预览只在 `/mock/*`，使用内存数据，生产构建关闭。

不增加微服务、RBAC、组织、租户或多 Agent 编排。接口细节见[后端架构](backend.md)与[server/README.md](../server/README.md)。
