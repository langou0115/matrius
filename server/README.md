# Matrius Server

Matrius 云端模式的后端：FastAPI + SQLite + 本地文件存储 + 进程内缓存，搜索与网页抓取用纯 Python 实现。

服务端是云端模式的唯一事实源，保存会话、消息、已读状态、记忆、画像、偏好和文件元数据；Agent Runtime 仍运行在客户端，服务端不运行 Agent Loop，也不保存模型 API key。

完整设计与接口契约见 [后端架构](../doc/backend.md)，服务器准备与更新见[部署指南](../doc/deployment.md)。

## 目录

```text
server/
├── app/
│   ├── main.py              # 应用装配、CORS、请求日志、异常响应
│   ├── config.py            # pydantic-settings 环境变量
│   ├── db.py                # async engine / get_db / SQLite PRAGMA
│   ├── cache.py             # 进程内缓存、滑动窗口限流、登录锁定
│   ├── storage.py           # 本地文件存储（DATA_DIR/files）
│   ├── auth/                # 登录、会话、依赖、限流
│   ├── admin/               # 管理员用户管理
│   ├── conversations/       # 会话、消息、已读状态
│   ├── account/             # 偏好、画像、记忆、存量导入
│   ├── files/               # 上传、下载、解析（PDF/Office/纯文本）
│   ├── tools/               # DuckDuckGo/Bing 搜索、网页读取、文件读/检索
│   └── models/              # SQLAlchemy 表
├── alembic/versions/        # 数据库迁移
├── scripts/entrypoint.sh    # 修正卷权限、迁移、bootstrap、启动 uvicorn
├── tests/                   # pytest 集成测试
├── Dockerfile
├── pyproject.toml
└── uv.lock
```

## 运行与验证

开发在仓库根目录执行 `npm run dev`：本机 uv 按锁文件安装依赖、启动 FastAPI 热重载，SQLite 数据库和上传文件都在 `server/.data`。全程不连接服务器，也不需要 Docker、SSH 或 `server/.env`；启动时自动迁移开发库并运行 `alembic check`。

正式发布用 `npm run deploy`，服务器构建包含源码的 Web/API 生产镜像，自动应用迁移并刷新管理员密码，健康检查后退出；不挂载源码、不热重载。部署成功后 stage=stable 的功能即对所有账号开放。完整说明见[开发与验证](../doc/development.md)。

本机单独安装后端测试依赖：

```bash
cd server
uv sync --frozen --extra dev
```

### 测试与检查

```bash
uv run --no-sync ruff check .
uv run --no-sync pytest
```

测试使用内存 SQLite（启用外键），每个用例前重置进程内缓存，不会连接外部服务。仓库没有自动 CI，发布前需在本地执行这些检查。

### 新增迁移

```bash
uv run --no-sync alembic revision --autogenerate -m "describe change"
```

提交前检查生成的迁移：索引、约束、级联删除必须显式存在。涉及迁移时应在临时空 SQLite 上验证全部迁移可执行（`tests/test_migrations.py` 覆盖 `upgrade head` 与 `check`）。生产部署时由 API 容器入口执行 `alembic upgrade head` 和 `alembic check`，不再有独立的 `migrate` 容器。

`app.bootstrap` 在 `users` 表为空时创建初始管理员；已有用户时，如果配置了 `INITIAL_ADMIN_USERNAME` / `INITIAL_ADMIN_PASSWORD`，会把该账号密码更新为当前值，因此每次部署以最新的管理员设置为准。两个值留空时不会改动现有密码。

## 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `APP_ENV` | `development` | `production` 时关闭 `/docs`，并提高启动校验 |
| `APP_URL` | `http://localhost:8000` | 对外地址，仅用于文档/诊断 |
| `CORS_ORIGINS` | 空 | 逗号分隔；同源部署无需设置 |
| `LOG_LEVEL` | `INFO` | JSON 日志级别 |
| `DATABASE_URL` | `sqlite+aiosqlite:///./.data/dev.db` | 必须使用 `sqlite+aiosqlite://` |
| `DATA_DIR` | `./.data` | SQLite 与上传文件的根目录；生产为 `/data` |
| `SQLITE_BUSY_TIMEOUT_MS` | `30000` | SQLite 写锁等待时间 |
| `CACHE_MAX_ENTRIES` / `CACHE_MAX_BYTES` | `10000` / 64 MiB | 进程内缓存上限，超出后淘汰最旧条目 |
| `SEARCH_TIMEOUT_SECONDS` | `15` | 单个搜索来源超时 |
| `SEARCH_MAX_BYTES` | `2097152` | 单个搜索响应体上限 |
| `SEARCH_PROXY_URL` | 空 | 可选搜索上游代理 |
| `SEARCH_USER_AGENT` | 内置 UA | 搜索引擎请求头 |
| `FETCH_MAX_BYTES` | `5242880` | 网页读取响应体上限（5 MiB） |
| `AUTH_SESSION_TTL_SECONDS` | `604800` | 登录会话有效期 |
| `INITIAL_ADMIN_USERNAME` / `INITIAL_ADMIN_PASSWORD` | 空 | 空库创建管理员；已有用户时按当前值更新密码 |
| `MAX_UPLOAD_BYTES` | `20971520` | 单文件上限（20 MiB） |
| `STORAGE_QUOTA_BYTES` | `536870912` | 每用户存储配额（512 MiB） |
| `FETCH_MAX_CHARS` | `50000` | 单次网页读取最大字符数 |

生产配置在首次 `npm run deploy` 时自动生成到服务器 `<workspace>/production.env`；也可通过 `REMOTE_ENV_FILE` 使用已有文件。模板见仓库 `docker-compose/.env.production.example`：其中部署段（SSH 目标、公开端口、工作目录）由本机 `docker-compose/.env.production` 读取，运行时段描述服务器上的生成文件。`.env.local` 只放本地开发与通用应用设置；其中登录有效期、限额、`SEARCH_PROXY_URL` 等通用项会在部署时写入服务器的 `production.env`。不要把真实密钥提交到仓库。

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

- 文件内容写入 `DATA_DIR/files`，对象键为 `users/{userId}/{fileId}/{safeName}`，数据库只保存元数据；写入使用临时文件 + `os.replace` 原子替换。
- 上传类型白名单：纯文本/代码/Markdown/CSV、图片、PDF、DOCX/XLSX/PPTX。不支持旧版 DOC/XLS/PPT，也不做 OCR。
- 文件读取与 grep 只对已上传文件生效；解析结果缓存在 API 进程内 1 小时，重启后重新解析。
- 搜索并行请求 DuckDuckGo HTML（失败回退 lite 端点）与 Bing RSS，结果去重并限制每域 2 条；单来源失败时降级，全部失败返回 502。
- 网页读取前校验 URL：仅 http/https、禁止凭据、localhost、私网/链路本地/云元数据地址，并解析 DNS 检查全部地址；最多手动跟随 5 次重定向，每一跳重新校验。生产环境仍建议在主机/云防火墙限制 API 容器的出站网段。
- 限流与登录锁定使用进程内滑动窗口：登录按 IP 与用户名，登录失败 15 次锁定 15 分钟；其余接口按用户。重启后清零，因此 API 必须单 worker 运行。

## 容器

```bash
# 仅构建（context 必须是 server/）
docker build -t matrius-api:local server
```

构建时先探测 `PYPI_INDEX_CANDIDATES`（默认官方 PyPI 与清华镜像），选择最快且可达的源安装 uv；随后把 `uv.lock` 导出为带 sha256 的 requirements，再从同一批候选源中择优安装。镜像源缺少包或临时失败时会重试下一个源，哈希校验保证不同源下载的内容一致。

生产镜像以 root 入口启动，修正 `/data` 卷权限后用 `gosu` 降权到 uid 10001 的 `matrius` 用户运行，依赖版本仍完全来自 `uv.lock`。入口依次执行 `alembic upgrade head`、`alembic check`、`python -m app.bootstrap`，然后运行单 worker 的：

```bash
uvicorn app.main:app --host 0.0.0.0 --port 8000 --proxy-headers --forwarded-allow-ips=*
```

不要增加 `--workers`：缓存和限流是进程内状态。

部署统一使用 `npm run deploy`：首次执行自动初始化数据卷、数据库与空库管理员，之后每次部署都会备份数据库、应用迁移、刷新管理员密码并更新 Web/API 与 Caddy。生产只运行 Caddy / Web / API 三个容器。

## 测试账号与新功能开放

preview 仅对 `admin_test` 开放，账号由已有管理员正常创建并完成首次改密；不自动创建测试账号或设置默认测试密码。新增功能在 `app/features/registry.py` 以 preview 登记，接口依赖 `require_feature(id)`；验证后只把指定条目标为 stable，再通过手动 CD 发布。`UserOut.features` 和 `/api/features` 返回当前账号能力，`/api/features/labs` 演示完整服务端校验。参考[认证规则](../doc/auth.md#同一地址的账号功能开关)。
