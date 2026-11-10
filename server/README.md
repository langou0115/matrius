本项目为无需登录的单用户实例；所有访问者共享数据。资源设置中的磁盘容量来自服务器数据目录所在文件系统（容器内为数据卷所在文件系统），不再使用账户配额。详见[实例访问](../doc/instance.md)。

# Matrius Server

Matrius 单用户实例的后端：FastAPI + SQLite + 本地文件存储 + 进程内缓存，搜索与网页抓取用纯 Python 实现。

服务端是实例的唯一事实源，保存会话、消息、已读状态、记忆、画像、偏好和文件元数据；Agent Runtime 仍运行在客户端，服务端不运行 Agent Loop，也不保存模型 API key。

完整设计与接口契约见 [后端架构](../doc/backend.md)，服务器准备与更新见[部署指南](../doc/deployment.md)。

## 目录

```text
server/
├── app/
│   ├── main.py              # 应用装配、CORS、请求日志、异常响应
│   ├── config.py            # pydantic-settings 环境变量
│   ├── db.py                # async engine / get_db / SQLite PRAGMA
│   ├── storage.py           # 本地文件存储（DATA_DIR/files）
│   ├── instance/            # 实例上下文与限流
│   ├── conversations/       # 会话、消息、已读状态
│   ├── workspace/             # 偏好、画像、记忆、存量导入
│   ├── files/               # 上传、下载、解析（PDF/Office/纯文本）
│   ├── usage/               # 实例每日 Token 用量上报与查询
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

开发在仓库根目录执行 `npm run dev`：本机 uv 按锁文件安装依赖、启动 FastAPI 热重载，SQLite 数据库和上传文件都在 `server/.data`。全程不连接服务器，也不需要 Docker、SSH 或 `server/.env`；启动时自动迁移开发库并运行 `alembic check`。开发模式下后端直接读取仓库根目录的 `.env.local`，文件变化后代理、搜索/抓取预算、限流等运行时设置会在下一次请求生效，无需重启；端口、数据库路径、管理员初始化和日志级别仍需重启。

正式发布用 `npm run deploy`，服务器构建包含源码的 Web/API 生产镜像，自动应用迁移，健康检查后退出；不挂载源码、不热重载。部署成功后功能清单中的能力即对所有实例开放。完整说明见[开发与验证](../doc/development.md)。

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

当前迁移链只有一条基线 `0001_initial`，空库初始化不会生成备份文件。开发期由旧增量链创建的数据库需要删除 `DATA_DIR`（推荐）或执行一次 `alembic stamp 0001_initial`；旧生产卷同理，否则入口的 `upgrade head` 会因找不到旧 revision 失败。


## 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `APP_ENV` | `development` | `production` 时关闭 `/docs`，并提高启动校验 |
| `APP_URL` | `http://localhost:8000` | 对外地址，仅用于文档/诊断 |
| `CORS_ORIGINS` | 空 | 逗号分隔；同源部署无需设置 |
| `LOG_LEVEL` | `INFO` | JSON 日志级别 |
| `DATABASE_URL` | `sqlite+aiosqlite:///./.data/matrius.db` | 必须使用 `sqlite+aiosqlite://` |
| `DATA_DIR` | `./.data` | SQLite 与上传文件的根目录；生产为 `/data` |
| `SQLITE_BUSY_TIMEOUT_MS` | `30000` | SQLite 写锁等待时间 |
| `CACHE_MAX_ENTRIES` / `CACHE_MAX_BYTES` | `10000` / 64 MiB | 进程内缓存上限，超出后淘汰最旧条目 |
| `SEARCH_TIMEOUT_SECONDS` | `8` | 整次搜索预算，DuckDuckGo 与 Bing 回退共用 |
| `SEARCH_DDGS_TIMEOUT_SECONDS` | `4` | 单次 ddgs 尝试上限，其余预算留给 Bing 回退 |
| `SEARCH_MAX_ATTEMPTS` | `2` | 每个来源最多尝试次数（仅快速失败或传输错误会重试） |
| `SEARCH_FALLBACK` | `true` | DuckDuckGo 失败/空结果时是否回退 Bing RSS |
| `SEARCH_BREAKER_FAILURES` / `SEARCH_BREAKER_COOLDOWN_SECONDS` | `3` / `60` | 连续失败熔断阈值与冷却时间；阈值 `0` 关闭 |
| `SEARCH_MAX_BYTES` | `2097152` | Bing RSS 响应体上限 |
| `WEBTOOL_PROXY_URL` | 空 | 可选上游代理，搜索与网页读取共用；配置后始终走代理 |
| `SEARCH_USER_AGENT` | 内置 UA | 搜索与网页读取请求头 |
| `FETCH_TIMEOUT_SECONDS` | `45` | 整次网页读取截止时间（含排队与提取） |
| `FETCH_MAX_ATTEMPTS` | `2` | 下载最多尝试次数；仅超时/传输错误/5xx/短 429 重试 |
| `FETCH_MAX_BYTES` | `5242880` | 网页读取响应体上限（5 MiB） |
| `MAX_UPLOAD_BYTES` | `20971520` | 单文件上限（20 MiB） |
| `FETCH_MAX_CHARS` | `50000` | 单次网页读取最大字符数 |

生产配置在首次 `npm run deploy` 时自动生成到服务器 `<workspace>/production.env`；也可通过 `REMOTE_ENV_FILE` 使用已有文件。模板见仓库 `docker-compose/.env.production.example`：其中部署段（SSH 目标、公开端口、工作目录）由本机 `docker-compose/.env.production` 读取，运行时段描述服务器上的生成文件。`.env.local` 只放本地开发与通用应用设置；开发时后端会在文件变化后自动重新读取运行时设置，生产容器仍只使用部署时写入的环境变量。其中限额、`LOG_LEVEL` 等通用项会在部署时写入服务器的 `production.env`。代理分两个键：`WEBTOOL_PROXY_URL` 只用于本机开发、不会上传；`WEBTOOL_PROXY_URL_PRODUCTION` 在部署时映射为服务器的 `WEBTOOL_PROXY_URL`，必须是容器可达地址（如 `host.docker.internal`，loopback 会被拒绝）。不要把真实密钥提交到仓库。

## API 概览


```text

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
POST   /api/workspace/import

POST   /api/files                         # multipart
GET    /api/files?conversationId=
GET    /api/files/{id}
GET    /api/files/{id}/content
DELETE /api/files/{id}

GET    /api/usage?days=366                # 每日累计 + 全量合计
POST   /api/usage                         # 每轮回复的 token 用量
POST   /api/usage/backfill                # 实例一次，估算历史会话

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

- 文件内容写入 `DATA_DIR/files`，对象键为 `<fileId>/<safeName>`，数据库只保存元数据；写入使用临时文件 + `os.replace` 原子替换。
- 上传类型白名单：纯文本/代码/Markdown/CSV、图片、PDF、DOCX/XLSX/PPTX。不支持旧版 DOC/XLS/PPT，也不做 OCR。
- 文件读取与 grep 只对已上传文件生效；解析结果缓存在 API 进程内 1 小时，重启后重新解析。
- 搜索优先 `ddgs` 的 DuckDuckGo 后端，只有失败、超时、限流或零结果时才在剩余预算内回退 Bing RSS；整次默认 8 秒，连续失败会短暂熔断。DuckDuckGo 的 HTML 接口使用 GET：部分代理地址会对 POST 返回 HTTP 202 验证页；Bing 复用长连接并会重试一次瞬时传输错误。结果去重、按关键词相关性排序并优先保证域名多样性。可达来源零结果返回 `[]` 且不缓存；只有实际尝试的所有来源都失败才返回 502。
- 网页读取前校验 URL：仅 http/https、禁止凭据、localhost、私网/链路本地/云元数据地址，并解析 DNS 检查全部地址；最多手动跟随 5 次重定向，每一跳重新校验。缺失或 `application/octet-stream` 的响应会嗅探前 4 KiB，二进制内容直接拒绝；HTML 依次用 trafilatura（precision → recall）、`html_markdown.py`、lxml 提取。`WEBTOOL_PROXY_URL` 同时用于搜索与抓取，配置后始终走代理。生产环境仍建议在主机/云防火墙限制 API 容器的出站网段。

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

部署统一使用 `npm run deploy`：首次执行自动初始化数据卷、数据库与实例记录，之后每次部署都会备份数据库、应用迁移、更新 Web/API 与 Caddy。生产只运行 Caddy / Web / API 三个容器。

## 测试实例与新功能开放
