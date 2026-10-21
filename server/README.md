# Matrius Server

Matrius 云端模式的后端：FastAPI + PostgreSQL + Redis + RustFS + OpenSERP。

服务端是云端模式的唯一事实源，保存会话、消息、已读状态、记忆、画像、偏好和文件元数据；Agent Runtime 仍运行在客户端，服务端不运行 Agent Loop，也不保存模型 API key。

完整设计与接口契约见 [后端架构](../doc/backend.md)，服务器准备与更新见[部署指南](../doc/deployment.md)。

## 目录

```text
server/
├── app/
│   ├── main.py              # 应用装配、CORS、请求日志、异常响应
│   ├── config.py            # pydantic-settings 环境变量
│   ├── db.py / redis.py / storage.py
│   ├── auth/                # 登录、会话、依赖、限流
│   ├── admin/               # 管理员用户管理
│   ├── conversations/       # 会话、消息、已读状态
│   ├── account/             # 偏好、画像、记忆、存量导入
│   ├── files/               # 上传、下载、解析（PDF/Office/纯文本）
│   ├── tools/               # OpenSERP 搜索、网页读取、文件读/检索
│   └── models/              # SQLAlchemy 表
├── alembic/versions/        # 数据库迁移
├── tests/                   # pytest 集成测试
├── Dockerfile
├── pyproject.toml
└── uv.lock
```

## 运行与验证

后端只在服务器 Compose 运行，本机使用仓库根目录的 `npm run remote` 同步前后端代码，并在服务器构建、启动生产镜像；每次命令完成一次部署和健康检查后退出。默认部署不更新功能发布清单，`npm run remote -- --publish` 在健康检查后发布 stable 功能。首次运行自动生成服务器配置、初始化服务并创建管理员；后续迁移使用显式 `--migrate`。本机只需 `.env.local` 中的 SSH 配置，不需要 `server/.env` 或数据隧道。完整说明见[远程构建与部署](../doc/development.md#远程构建与发布npm-run-remote)。

安装 Python 依赖仅用于需要在本机执行的测试和静态检查，不是远程运行的前置条件：

```bash
cd server
bash scripts/install-python-deps.sh --dev
```

`install-python-deps.sh` 从 `uv.lock` 导出带 sha256 的依赖清单，并探测候选 PyPI 源；依赖变化后重新执行安装，后续命令使用 `uv run --no-sync`。

### 测试与检查

```bash
uv run --no-sync ruff check .
uv run --no-sync pytest
```

测试使用内存 SQLite（启用外键），速率限制与 Redis 缓存被替换为 no-op，不会连接外部服务。仓库没有自动 CI，发布前需在本地执行这些检查。

### 新增迁移

```bash
uv run --no-sync alembic revision --autogenerate -m "describe change"
```

提交前检查生成的迁移：索引、约束、级联删除必须显式存在。涉及迁移时应在空 PostgreSQL 上验证全部迁移；生产部署时由 `migrate` 容器执行 `alembic upgrade head`。

`app.bootstrap` 只在 `users` 表为空时创建初始管理员；用户名和密码来自 `INITIAL_ADMIN_USERNAME` / `INITIAL_ADMIN_PASSWORD`。创建后应从生产环境变量中移除密码。

## 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `APP_ENV` | `development` | `production` 时关闭 `/docs`，并提高启动校验 |
| `APP_URL` | `http://localhost:8000` | 对外地址，仅用于文档/诊断 |
| `CORS_ORIGINS` | 空 | 逗号分隔；同源部署无需设置 |
| `LOG_LEVEL` | `INFO` | JSON 日志级别 |
| `DATABASE_URL` | 本地 PostgreSQL | 必须使用 `postgresql+asyncpg://` |
| `REDIS_URL` | `redis://localhost:6379/0` | 限流与短期缓存 |
| `RUSTFS_ENDPOINT` | `http://localhost:9000` | S3 兼容端点，使用 path-style |
| `RUSTFS_ACCESS_KEY` / `RUSTFS_SECRET_KEY` | 空 | 对象存储凭据 |
| `RUSTFS_BUCKET` | `matrius` | 启动时自动创建 |
| `OPENSERP_URL` | `http://localhost:7000` | 搜索/网页提取服务 |
| `OPENSERP_PROXY_URL` / `OPENSERP_PROXY_TAG` | 空 | 可选上游代理 |
| `AUTH_SESSION_TTL_SECONDS` | `604800` | 登录会话有效期 |
| `INITIAL_ADMIN_USERNAME` / `INITIAL_ADMIN_PASSWORD` | 空 | 仅空库初始化使用 |
| `MAX_UPLOAD_BYTES` | `20971520` | 单文件上限（20 MiB） |
| `STORAGE_QUOTA_BYTES` | `536870912` | 每用户存储配额（512 MiB） |
| `FETCH_MAX_CHARS` | `50000` | 单次网页读取最大字符数 |

生产配置默认由首次 `npm run remote` 生成在服务器 `<workspace>/production.env`；也可通过 `REMOTE_ENV_FILE` 使用已有文件。模板见仓库 `docker-compose/.env.production.example`。不要把真实密钥提交到仓库，也不要放到开发机。

## API 概览

所有业务接口位于 `/api`，除登录和健康检查外都需要 `Authorization: Bearer <token>`。

```text
POST   /api/auth/login | /api/admin/auth/login
GET    /api/auth/me
POST   /api/auth/logout | /api/auth/change-password

GET    /api/conversations                 # keyset 分页
POST   /api/conversations
GET    /api/conversations/{id}            # 默认返回最后 50 条消息
PATCH  /api/conversations/{id}
DELETE /api/conversations/{id}
POST   /api/conversations/{id}/messages
PATCH  /api/messages/{id}
DELETE /api/messages/{id}

GET/PUT /api/preferences
GET/PUT /api/profile
GET     /api/profile/fields
GET/PUT/DELETE /api/profile/fields/{key}
GET/POST /api/memories
PATCH/DELETE /api/memories/{id}
POST   /api/account/import

POST   /api/files                         # multipart
GET    /api/files?conversationId=
GET    /api/files/{id}
GET    /api/files/{id}/content
DELETE /api/files/{id}

POST   /api/tools/search
POST   /api/tools/fetch
POST   /api/tools/files/read
POST   /api/tools/files/grep

GET    /api/health
GET    /api/health/ready
```

- 新建会话/消息可携带客户端生成的 `id`，重复 POST 返回已有记录，用于网络重试幂等。
- 修改和删除带 `baseRevision`；版本不匹配返回 `409` 和当前记录。
- 消息 `position` 由服务端在会话行锁内分配，客户端不要自行推断顺序。
- 时间戳均为 epoch 毫秒。
- 错误格式：`{"error": {"code": "...", "message": "..."}}`；冲突额外包含 `current`。
- 回复结束时客户端再 POST 助手消息；`streaming` 状态会被拒绝，服务端不会保存半截回复。

## 数据与限制

- 文件写入 RustFS 的对象键为 `users/{userId}/{fileId}/{safeName}`，数据库只保存元数据。
- 上传类型白名单：纯文本/代码/Markdown/CSV、图片、PDF、DOCX/XLSX/PPTX。不支持旧版 DOC/XLS/PPT，也不做 OCR。
- 文件读取与 grep 只对已上传文件生效；解析结果缓存在 Redis `filetext:{fileId}:{sha256}`，TTL 1 小时。
- 搜索调用 OpenSERP，默认引擎 `duckduckgo,bing,baidu`，结果去重并限制每域 2 条。
- 网页读取前校验 URL：仅 http/https、禁止凭据、localhost、私网/链路本地/云元数据地址，并解析 DNS 检查全部地址；OpenSERP 部署在独立网络。生产环境仍建议在主机/云防火墙限制其出站网段。
- 限流使用 Redis 滑动窗口：登录按 IP 与用户名，登录失败 15 次锁定 15 分钟；其余接口按用户。登录在 Redis 不可用时 fail-closed，其他接口 fail-open 并记录告警。

## 容器

```bash
# 仅构建（context 必须是 server/）
docker build -t matrius-api:local server
```

构建时先探测 `PYPI_INDEX_CANDIDATES`（默认官方 PyPI 与清华镜像），选择最快且可达的源安装 uv；随后把 `uv.lock` 导出为带 sha256 的 requirements，再从同一批候选源中择优安装。镜像源缺少包或临时失败时会重试下一个源，哈希校验保证不同源下载的内容一致。

生产镜像以非 root 用户运行，依赖版本仍完全来自 `uv.lock`。镜像启动命令为：

```bash
uvicorn app.main:app --host 0.0.0.0 --port 8000 --proxy-headers --forwarded-allow-ips=*
```

部署使用 `npm run remote`，功能发布使用 `npm run remote -- --publish`；首次运行或显式 `--migrate` 通过一次性容器执行迁移与管理员引导。

## 测试账号与新功能开放

服务配置 `PREVIEW_USERNAME=admin_test`，账号由已有管理员正常创建并完成首次改密；不自动创建测试账号或设置默认测试密码。新增功能在 `app/features/registry.py` 以 preview 登记，接口依赖 `require_feature(id)`；验证后只把指定条目标为 stable，再通过手动 CD 发布。`UserOut.features` 和 `/api/features` 返回当前账号能力，`/api/features/labs` 演示完整服务端校验。参考[认证规则](../doc/auth.md#同一地址的账号功能开关)。
