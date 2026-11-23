# 存储与数据

[文档索引](README.md)

## 唯一事实源

会话、消息、已读、记忆、画像、外观、网络工具偏好、模型服务配置与 API key、文件元数据和 Token 用量统一保存到实例后端。
浏览器不维护聊天工作区、模型配置或 API key 副本，不提供匿名模式、离线写入或本地/云端同步。
UI → features → repository → API → SQLite / 文件系统。

仅最近会话位置等设备状态可留在浏览器。
旧浏览器工作区与模型数据不再加载或写入；`browser-store.ts` 中的历史格式读取与迁移辅助函数不构成产品模式。
`/mock/*` 的工作区和模型配置只在内存中，正式构建不可访问。

## 目录

```text
本机默认：~/.matrius/
├── matrius.db                   # SQLite；运行时另有 -wal、-shm
├── files/
│   └── <fileId>/
│       └── <文件名>             # 上传和工具保存的文件
└── drafts/
    └── <draftId>/               # 临时文档草稿
```

`DATA_DIR` 是数据根目录，默认 `~/.matrius`；在 `.env.local` 取消注释并改写 `DATA_DIR` 可换到其他位置（默认示例保持注释）。
上传文件总量受 `STORAGE_LIMIT_BYTES` 限制，默认 128 MiB，可在 `.env.local` 改写；`GET /api/files/usage` 返回该逻辑配额，不再用 `fs.statfs` 读取主机的文件系统容量。
对象键为 `<fileId>/<safeName>`，不包含用户目录；文件名沿用上传/重命名的安全文件名校验。
上传、文档新建/编辑保存、重命名都使用同一规则。
文件重命名会更新磁盘路径和数据库对象键，数据库提交失败时清理新副本。
同一文件的编辑保存和重命名在单 Node 进程内串行执行；覆盖提交失败时恢复原文件内容。
文件内容以临时文件 + `os.replace` 原子替换，路径解析拒绝越出根目录的对象键。
SQLite 事务与文件替换不是跨存储的原子事务；备份和恢复应覆盖数据库与整个文件目录。

## 数据库与初始化

默认数据目录从旧的 `server/.data` 改为 `~/.matrius`；若要沿用旧开发数据，先停止 API，再把旧目录的 `matrius.db*`、`files/` 和 `drafts/` 复制到新目录（或在 `.env.local` 把 `DATA_DIR` 指回旧路径）。

服务启动（`npm run start`、`npm run dev`）及 `npm run db:migrate` 直接在 `DATA_DIR/matrius.db`（默认 `~/.matrius/matrius.db`）上执行 `server/db/migrations` 的 SQL 迁移（由 `server/db/migrate.ts` 执行，并保留 `alembic_version` 表兼容旧库）；`npm run dev -- --reset-db` 清空当前数据目录的数据库、上传文件和草稿。

数据库以 `0001_initial` 为基线创建单实例 schema（`instance.id=1` 及指向它的业务表），随后按序应用 `0002_scheduled_tasks`、`0003_ui_blocks`、`0004_model_configs`、`0005_work_hosts`、`0006_work_projects` 等迁移。空库初始化不会生成迁移备份或其他伴随文件；新库的持久内容只有 `matrius.db` 和 `files/`。
上传文件写入 `DATA_DIR/files/<fileId>/<safeName>`，数据库只保存元数据；旧版 `users/<userId>/...` 布局及其迁移逻辑已移除，开发阶段不迁移旧账户数据。

## 写入与冲突

桌面工作区的默认 Git 差异视图保存在 SQLite 的 `work_settings.editor_diff_layout`。迁移 `0016_work_editor_diff_layout` 为已有实例补上「行内」默认值。

会话与消息、记忆、画像和偏好使用 `baseRevision` 乐观并发，冲突返回 409；单用户的多设备/多标签页仍需冲突保护。

桌面预览的上传文件总量上限和网页工具代理保存在 `desktop_chat_settings` 表中，由 `GET /api/desktop/chat-settings` 读取和 `PUT /api/desktop/chat-settings` 更新。更新需提供 `baseRevision`，成功后立即应用到当前服务端实例。
工作区持久化队列直接调用 REST，流式期间合并保存，完成时提交最终内容；网络失败明确提示，不回退到 IndexedDB。
消息的文件引用、引用原文、反馈、思考与工具顺序、滚动摘要等继续随现有消息结构保存。
图片请求字节不写入聊天工作区快照。
已读与当前设备打开的会话分开；当前会话地址由 Router 与设备状态恢复。

## 临时状态与密钥

搜索结果/文件文本缓存、滑动窗口限流和并发计数存在 API 内存，重启清零。
文档草稿元数据在内存、字节在 drafts 下，重启失效，因此 API 保持单 Node 进程。
Agent 循环、取消与运行状态在服务端进程内，刷新页面或重启服务不保证恢复；输入框草稿仍只保留在页面会话。
模型 API key 保存在服务端 `model_configs` 表中，不回传给浏览器、不写日志；`/api/agent/*` 请求时由服务端直接取出并转发给模型服务商。
