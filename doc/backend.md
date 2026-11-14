# 后端架构

后端是 `server/` 下的单 Node/TypeScript 进程，使用 Fastify 与 node:sqlite，入口为 server/main.ts，应用装配在 server/app.ts。

浏览器通过 /api/agent/runs 的 SSE 提交运行请求并消费事件。server/agent 负责模型调用、上下文、工具循环、压缩、标题与记忆。工具通过 server/tools 注册并直接调用 server/services。旧 /api/tools/* 接口已移除，无需恢复。

业务数据只存服务端，SQLite 在 DATA_DIR/matrius.db，文件在 DATA_DIR/files，临时草稿在 DATA_DIR/drafts。所有客户端共享 instance_id=1，写入使用 baseRevision 乐观并发。模型配置与 key 仅保存在客户端，每次运行临时发送，服务端不落库、不记录密钥。

迁移由 server/db/migrate.ts 与 server/db/migrations 的 SQL 执行，保留 alembic_version 修订表兼容旧数据库，无需 Python 或 Alembic CLI。数据格式使用 server/db/codecs.ts。草稿元数据、缓存与限流在进程内，必须保持单 Node 进程。

Office 使用受控 OfficeCLI 子进程，旧格式转换使用 LibreOffice kit，PDF 使用 pdf-lib 与 unpdf。配置与目录详见 [server/README](../server/README.md)。部署链路尚未恢复。
