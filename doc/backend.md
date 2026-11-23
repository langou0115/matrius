# 后端架构

后端是 `server/` 下的单 Node/TypeScript 进程，使用 Fastify 与 node:sqlite，入口为 server/main.ts，应用装配在 server/app.ts。

浏览器通过 /api/agent/runs 的 SSE 提交运行请求并消费事件，并通过 /api/agent/models 查询服务商模型目录。server/agent 负责模型调用、上下文、工具循环、压缩、标题与记忆。工具通过 server/agent/tools 注册并直接调用 server/services。旧 /api/tools/* 接口已移除，无需恢复。

业务数据只存服务端，SQLite 在 DATA_DIR/matrius.db（默认 ~/.matrius/matrius.db），文件在 DATA_DIR/files，临时草稿在 DATA_DIR/drafts；DATA_DIR 与可选的 AUTH_SECRET 可在 `.env.local` 配置（生产模式同样读取 `.env.local`）。上传文件总量受 STORAGE_LIMIT_BYTES 限制（默认 128 MiB），不读取部署主机磁盘容量。所有客户端共享 instance_id=1，写入使用 baseRevision 乐观并发。模型配置与 API key 保存在服务端 `model_configs` 表中（`/api/models` 不回传明文密钥），请求 `/api/agent/*` 时由服务端直接读取使用；桌面端 SSH / WSL 主机配置与口令保存在 `work_hosts` 表中（`/api/hosts` 同样不回传明文密钥，网页端不展示该功能），项目绑定配置与 Codex / Antigravity / Claude Code 分立 AI 配置（网络代理与启动参数）保存在 `work_projects` 表中（项目创建后名称、主机与目录锁定不可修改，仅支持通过 `PATCH /api/projects/:id` 更新 AI 配置；`/api/projects` 与 `/api/hosts/:hostId/fs` 支持浏览本机 / WSL / SSH 目录与文件，`/api/projects/:projectId/cli-sessions` 支持发现并检测本机 / WSL / SSH 下 Claude Code、Codex 与 Antigravity 的历史及运行中会话状态），桌面端项目、分组与终端标签排序、默认终端与历史输出开关保存在 `work_settings` 表中，桌面端交互终端会话由服务端基于 `node-pty` 与 `@fastify/websocket` 在进程内维护（`/api/work/terminals*`，支持本机 / WSL / SSH 伪终端、按 CLI 类型注入对应网络代理与启动参数且普通终端默认不继承、WebSocket 双向流与回溯缓冲）；若配置了 `AUTH_SECRET`，受保护路由需先通过 `/api/auth/unlock` 签发 HMAC 签名 `HttpOnly` Cookie 后才可访问。

桌面工作区 Git 通过 `GET /api/projects/:projectId/git` 查询项目所在仓库，支持通过 `POST /api/projects/:projectId/git/stage`、`unstage`、`discard`、`checkout`、`pull`、`push` 与 `fetch` 管理暂存区、工作区更改与分支同步，并使用 `POST /api/projects/:projectId/git/commits` 提交所选路径或暂存区变更。Git 在项目所在的本机、WSL 或 SSH 主机执行，远程跟踪分支来自最近一次 Git fetch 的本地记录。提交图通过 `GET /api/projects/:projectId/git/graph` 返回最近 100 个提交及其父提交、作者邮箱与正文说明。文件差异通过 `GET /api/projects/:projectId/git/diff` 读取工作区或暂存区单文件差异，提交历史改动通过 `GET /api/projects/:projectId/git/commits/:oid/files` 按轻量列表获取变更文件，并在点选单个文件时通过 `GET /api/projects/:projectId/git/commits/:oid/diff?path=…` 按需读取单文件差异，单次返回最多 256 KiB。

桌面工作区通过 `GET /api/hosts/:hostId/fs/preview?path=…` 读取本机、WSL 或 SSH 主机上的普通文件。接口返回 UTF-8 文本及内容版本，单文件读取上限为 256 KiB，响应不缓存。本机项目使用 `PUT /api/projects/:projectId/files/text` 保存目录内的文本文件。服务端检查版本后替换文件，版本冲突返回 409。编辑器字号和自动保存开关通过 `/api/work/settings` 读写，由 SQLite 的 `work_settings` 表持久化。

迁移由 server/db/migrate.ts 与 server/db/migrations 的 SQL 执行，保留 alembic_version 修订表兼容旧数据库，无需 Python 或 Alembic CLI。数据格式使用 server/db/codecs.ts。草稿元数据、缓存与限流在进程内，必须保持单 Node 进程。

Office 使用受控 OfficeCLI 子进程，旧格式转换使用 LibreOffice kit，PDF 使用 pdf-lib 与 unpdf。配置与目录详见 [server/README](../server/README.md)。
