# 后端架构

后端是 `server/` 下的单 Node/TypeScript 进程，使用 Fastify 与 node:sqlite，入口为 server/main.ts，应用装配在 server/app.ts。

浏览器通过 /api/agent/runs 的 SSE 提交运行请求并消费事件，并通过 /api/agent/models 查询服务商模型目录。server/agent 负责模型调用、上下文、工具循环、压缩、标题与记忆。工具通过 server/agent/tools 注册并直接调用 server/services。旧 /api/tools/* 接口已移除，无需恢复。

业务数据只存服务端，SQLite 在 DATA_DIR/matrius.db（默认 ~/.matrius/matrius.db），文件在 DATA_DIR/files，临时草稿在 DATA_DIR/drafts；DATA_DIR 与可选的 AUTH_SECRET 可在 `.env.local` 配置（生产模式同样读取 `.env.local`）。上传文件总量受 STORAGE_LIMIT_BYTES 限制（默认 128 MiB），不读取部署主机磁盘容量。所有客户端共享 instance_id=1，写入使用 baseRevision 乐观并发。模型配置与 API key 同样保存在服务端 `model_configs` 表中（`/api/models` 不回传明文密钥），请求 `/api/agent/*` 时由服务端直接读取使用；若配置了 `AUTH_SECRET`，受保护路由需先通过 `/api/auth/unlock` 签发 HMAC 签名 `HttpOnly` Cookie 后才可访问。

迁移由 server/db/migrate.ts 与 server/db/migrations 的 SQL 执行，保留 alembic_version 修订表兼容旧数据库，无需 Python 或 Alembic CLI。数据格式使用 server/db/codecs.ts。草稿元数据、缓存与限流在进程内，必须保持单 Node 进程。

Office 使用受控 OfficeCLI 子进程，旧格式转换使用 LibreOffice kit，PDF 使用 pdf-lib 与 unpdf。配置与目录详见 [server/README](../server/README.md)。
