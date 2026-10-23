# 后端架构与云端数据契约

[文档索引](README.md)

后端位于 [`server/`](../server/)，使用 Python 3.12 + FastAPI，部署说明见[服务器部署](deployment.md)。

## 边界

```text
客户端 Agent Runtime（上下文、循环、流式事件、工具调度、取消）
    │
    ├── REST /api/* ──────────────→ FastAPI
    │                                 ├── 认证、校验、限流
    │                                 ├── SQLite（事实源，/data/matrius.db）
    │                                 ├── 本地文件（/data/files）
    │                                 ├── 进程内缓存与限流
    │                                 └── DuckDuckGo / Bing（搜索）、trafilatura（网页提取）
    │
    └── /api/model-proxy/* ──────→ 现有 Node 模型中继 → 模型服务商
```

- 服务端**不运行 Agent Loop**，不保存流式中间态，也不保管模型 API key。
- API 必须以**单个 uvicorn worker** 运行：缓存和限流是进程内状态，多 worker 会各自计数。单进程不妨碍并发，模型代理、搜索与抓取都是 async I/O。
- 服务端保存账号数据，供登录后的后台双向同步；客户端 IndexedDB 仍是实时数据源，断网时可继续使用。
- 云端模式（服务端唯一事实源、客户端不再写本地）尚未实现。
- 同一来源部署下 Web 与 API 同源，CORS 默认无需配置；原生端使用 Bearer token。

## 目录职责

```text
app/main.py             应用装配、请求 ID/日志、CORS、异常映射
app/config.py           pydantic-settings
app/db.py               async engine / get_db / SQLite PRAGMA
app/cache.py            进程内缓存、滑动窗口限流、登录锁定
app/storage.py          本地文件存储（DATA_DIR/files）
app/auth/               密码哈希、Bearer 会话、鉴权依赖、普通登录
app/admin/              管理员登录与用户管理
app/conversations/      会话、消息、已读状态、keyset 分页
app/account/            偏好、画像、画像字段、记忆、账号导入与合并
app/files/              上传、下载、删除、配额、文本提取
app/tools/              搜索、URL 校验、网页读取、文件读/grep
app/models/             SQLAlchemy 表
alembic/                迁移
tests/                  集成测试（内存 SQLite）
```

路由层可以直接承载业务逻辑；出现重复或复杂事务时再抽服务。`account/import_service.py` 是独立事务逻辑的例子。

## 认证

### 普通登录

```text
POST /api/auth/login  { username, password }
→ { token, user: { id, username, isAdmin, mustChangePassword } }
```

- token 为 `secrets.token_urlsafe(32)`，数据库只保存 SHA-256。
- 请求使用 `Authorization: Bearer <token>`。
- `auth_sessions` 保存 `scope`（`user` / `admin`）、过期时间、最后访问时间、撤销时间。
- 管理员使用独立入口 `POST /api/admin/auth/login`，只能签发 admin scope；普通接口同时接受 user 与 admin token，管理员接口要求 admin scope。
- `must_change_password=true` 时只有 `me`、改密和登出可用，其余接口返回 403。
- 密码使用 Argon2id，允许 1–256 个字符；新密码不能与当前密码相同。
- 登录按 IP（10/分钟）和用户名（5/分钟）限流；连续失败 15 次锁定 15 分钟。计数在进程内，API 重启后清零。

### 初始化与管理员

- `python -m app.bootstrap` 在 `users` 为空时创建初始管理员；已有用户则跳过。生产环境缺少 `INITIAL_ADMIN_*` 且用户表为空时直接失败，避免部署出无法登录的实例。
- 管理员接口：`GET /api/admin/auth/me`（校验 admin scope）、用户列表、创建、重置密码、启停用。
- 创建/重置后的默认密码为 `<username>@123`，`must_change_password=true`，密码只在本次响应返回。
- 不允许停用自己或最后一个启用中的管理员。

## 云端数据契约

### 通用字段

```text
id             UUID，可由客户端预生成
user_id        资源归属，所有读写都有 WHERE user_id = :current
client_id      旧本地 id；unique(user_id, client_id)，仅用于导入与重试
revision       从 1 开始，每次修改 +1
created_at / updated_at  服务端 timestamptz
```

- 客户端创建时可提供 `id`；已存在时返回现有记录（HTTP 200/201 由实现决定，重复请求不产生新数据）。
- 修改/删除提供 `baseRevision`，`UPDATE ... WHERE revision = baseRevision`；未命中返回 `409`：

```json
{
  "error": {
    "code": "conflict",
    "message": "...",
    "current": { "id": "...", "revision": 7, "...": "..." }
  }
}
```

客户端应从 `error.current` 读取最新记录。

- 删除是硬删除；会话级联删除消息。跨用户访问统一返回 404。
- `updated_at` 只在追加消息时更新（用于列表排序）；PATCH 已读状态或元数据只增加 revision，不改变排序。
- 服务端时间在响应中统一返回 epoch 毫秒。

### 会话

```text
GET    /api/conversations?limit=50&cursor=
POST   /api/conversations
GET    /api/conversations/{id}?messageLimit=50&before=
PATCH  /api/conversations/{id}
DELETE /api/conversations/{id}?baseRevision=
```

- 列表按 `pinned desc, updated_at desc, id desc` 排序，keyset 游标不暴露偏移。
- 会话字段：`title`、`pinned`、`modelId`、`titleSource`（`auto|ai|manual`）、`clientUpdatedAt`、`readState`、`revision`。
- 详情默认返回最后 50 条消息；`before=<position>` 向前翻页。
- `PATCH` 可改标题、置顶、模型、标题来源和已读状态。

### 已读状态

会话上保存两组三态：

```json
"readState": {
  "completed": { "state": "absent" }
             | { "state": "unread" }
             | { "state": "read", "readAt": 1760000000000 },
  "error":     { "state": "absent" | "unread" | "read", "readAt": 1760000000000 }
}
```

- 省略某个分支表示不修改；响应总是返回完整三态。
- 追加 `complete` 或 `error` 的助手消息时，服务端置为 `unread`，但不增加 conversation revision。
- 客户端打开会话后通过 PATCH 置为 `read`。

### 消息

```text
POST   /api/conversations/{id}/messages
PATCH  /api/messages/{id}
DELETE /api/messages/{id}?baseRevision=
```

- 字段：`role`（`user|assistant`）、`content`、`quote`、`reasoning`、`thinkingMs`、`status`（`complete|stopped|error`）、`error`、`feedback`（`good|bad`）、`fileIds`、服务端 `position`。
- `status=streaming` 返回 422；用户消息固定 `complete`。
- `position` 在锁定会话行后取 `max(position)+1`，多设备并发追加不会重号。
- 工作流：先 POST 用户消息，回复结束后再 POST 助手消息；流式文本只存在客户端内存。页面中途关闭只会留下用户消息。
- 图片先通过文件 API 上传，消息只保存 `fileId` 引用。

### 账号数据

```text
GET/PUT /api/preferences                  { themeId, mode, baseRevision }
GET/PUT /api/profile                      { customInstructions, aboutName, occupation, aboutMore, baseRevision }
GET     /api/profile/fields
GET/PUT/DELETE /api/profile/fields/{key}  PUT 可带 baseRevision
GET/POST /api/memories
PATCH/DELETE /api/memories/{id}
```

- `preferences`、`profile` 为账号单例，首次读取时创建。
- `preferences.mode` 为 `light|dark|system`；主题 id 为客户端主题标识。
- 画像字段按 key 唯一；删除字段不删除账号。
- 记忆字段：`scope`（`global|conversation`）、`type`（`identity|workflow|voice|instruction`）、`status`（`active|archived`）、`content`、`source`（`manual|tool|extracted`）。
- 删除记忆为归档（`status=archived`），不是硬删除。
- 记忆与画像的分页均为 keyset（`updated_at + id`）。

### 账号导入与增量合并

```text
POST /api/account/import
{
  "schemaVersion": 1,
  "chat": { "conversations": [ {
    id, title, pinned, updatedAt, modelId, titleSource,
    readState: { completed: { state, readAt? }, error: { state, readAt? } },
    messages: [...]
  } ] },
  "appearance": { "themeId", "mode" },
  "personalization": { "customInstructions", "aboutName", "occupation", "aboutMore" }
}
→ { imported: { conversations, messages }, updated, skipped, failed: [{ clientId, reason }] }
```

- 单批最多 20 个会话、2000 条消息、8 MiB；客户端分批调用。
- 以 `clientId` 幂等。新会话计入 `imported`；已有会话按消息 `clientId` 追加新消息、更新变化的消息，有变化计入 `updated`，完全重复计入 `skipped`。
- 没有 `clientId` 的消息无法去重，只会在新建会话时写入；已有会话忽略这类消息。
- 会话元数据只在 `updatedAt` 不早于已保存的客户端时间时覆盖；已读状态按三态（`absent`/`unread`/`read`）更新。外观/个性化有值即增量更新，未传的字段保持不变。
- 每个会话使用 savepoint，单个会话失败不影响其他会话。
- 消息按数组顺序分配 `position`；本地 id 写入 `client_id`，服务端生成 UUID。
- 服务端在单进程内用 `asyncio.Lock` 串行执行导入，避免多个标签页并发同步时同时读到"不存在"并触发唯一约束；锁按事件循环绑定，仅对单 worker 有效。
- 删除不传播：接口没有墓碑或删除列表，不会移除服务端已有记录。

## 文件

```text
POST   /api/files            multipart: file, conversationId?, clientId?
GET    /api/files?conversationId=
GET    /api/files/{id}
GET    /api/files/{id}/content
DELETE /api/files/{id}
```

- 单文件默认 20 MiB，每用户默认 512 MiB；并发上传解析限制为 2。
- 白名单：文本/代码/Markdown/CSV、图片、PDF、DOCX、XLSX、PPTX。
- 对象键 `users/{userId}/{fileId}/{safeName}`；内容写入 `DATA_DIR/files`（生产为 `/data/files`），先写文件再写数据库，数据库失败时补偿删除对象。写入使用临时文件 + `os.replace` 原子替换。
- 下载先校验归属；设置 `X-Content-Type-Options: nosniff`，非图片使用 `Content-Disposition: attachment`。
- 删除先删对象再删记录；文件随会话删除只置空 `conversation_id`。
- 解析：PDF 用 pypdf；DOCX/XLSX/PPTX 用 python-docx/openpyxl/python-pptx；其他白名单文件按纯文本解码（UTF-8，失败时使用 charset-normalizer）。不做 OCR，不支持旧版 Office。
- 单次提取上限 2,000,000 字符；解析结果缓存在 API 进程内 1 小时，重启后重新解析。

## 云端工具

### 搜索

```text
POST /api/tools/search { query, limit? (1-20, 默认 10) }
```

- 并行请求 DuckDuckGo HTML（失败回退 lite 端点）与 Bing RSS；单个来源失败时降级，全部失败返回 502。
- 服务端规范化 URL、移除跟踪参数、去重、每域最多 2 条；标题截断 280 字符，摘要 640 字符。
- 结果缓存在进程内 5 分钟，并发 4，单来源超时 `SEARCH_TIMEOUT_SECONDS`（默认 15 秒），响应体上限 `SEARCH_MAX_BYTES`（默认 2 MiB）。
- 相同查询使用 single-flight 合并并发请求；每个账号最多 4 个在途搜索，超出立即返回 429。
- `WEBTOOL_PROXY_URL` 同时用于搜索和网页读取的上游连接；留空时直连。

### 网页读取

```text
POST /api/tools/fetch { url, mode? (fast|full) }
```

- 先做 SSRF 校验：仅 http/https、禁止 URL 凭据、禁止 localhost/私网/链路本地/ULA/组播，DNS 解析后要求所有地址 `is_global`。
- 手动跟随最多 5 次重定向，每一跳都用 `urljoin` 后重新校验，防止重定向到内网；非文本类型返回 422。
- 流式读取并按 `FETCH_MAX_BYTES`（默认 5 MiB）截断；`trafilatura` 提取正文（`fast` 偏 precision，`full` 偏 recall 并包含表格），失败时回退 lxml 纯文本。返回 title/url/text，文本截断 `FETCH_MAX_CHARS`。
- 相同 URL + 模式使用 single-flight 合并并发请求，结果缓存 10 分钟（`FETCH_CACHE_TTL_SECONDS`）；全局抓取并发 4，每个账号最多 4 个在途读取。
- `WEBTOOL_PROXY_URL` 同样作用于抓取请求；URL 与每一跳重定向仍在本地校验，代理不会跳过 SSRF 检查。
- 生产环境仍建议在主机或云防火墙限制 API 容器的出站网段，缩小 SSRF 与 DNS 重绑定的残余风险。

### 管理端测试

```text
POST /api/admin/tools/test
  { "kind": "search", "query": "..." }
  { "kind": "fetch", "url": "https://...", "mode": "fast|full" }
```

- 仅接受 admin scope 会话，与聊天流量分开限流（每账号 20 次/分钟），并复用真实搜索、抓取、缓存与代理路径。
- 返回结果包含 `tookMs` 与 `proxy`（是否配置了 `WEBTOOL_PROXY_URL`）；搜索返回规范化结果，读取返回 title/url/text/truncated/chars。失败沿用统一 `{"error":{"code","message"}}` 响应。

### 文件读取

```text
POST /api/tools/files/read { fileId, start?, end?, maxChars? }
POST /api/tools/files/grep { fileId, pattern, context?, maxMatches? }
```

- 仅能读取本人文件。
- read 按行返回，单次最多 50,000 字符，`truncated` 表示达到字符上限。
- grep 最多 200 条匹配，返回行号、匹配行和上下文。

## 限流

| 端点 | 限制 |
| --- | --- |
| 登录 | IP 10/分钟；用户名 5/分钟；连续失败 15 次锁定 15 分钟 |
| 会话/消息/账号写操作 | 用户 120/分钟 |
| 会话/消息/账号读取 | 用户 240/分钟 |
| 文件上传 | 用户 20/分钟，并发解析 2 |
| 搜索/网页读取 | 用户 30/分钟，并发 4 |
| 文件 read/grep | 用户 60/分钟 |

计数保存在 API 进程内，重启后清零；只影响频率限制，不影响账号与数据隔离。

## 健康检查与日志

- `GET /api/health`：数据库探活；成功 `{"service":"matrius","status":"ok"}`。远程发布与容器健康检查使用此接口。
- `GET /api/health/ready`：并行检查 `database`、`schema`（数据库 revision 与镜像 head 一致）、`cache`、`storage`；任一失败返回 503 与 `checks`。
- 日志为 JSON，包含 request id、user id、方法、路径、状态、耗时；不记录 Authorization、token、消息正文或文件内容。
- 响应头 `X-Request-ID` 可用于和服务端日志对照。

## 数据库

表与约束由 `alembic/versions/0001_initial.py` 建立：

```text
users, auth_sessions
conversations, messages
memory_entries
user_profiles, user_profile_fields, user_preferences
files
```

关键约束：

- `users` 对 `lower(username)` 唯一。
- `conversations/messages/memory_entries/files` 的 `(user_id, client_id)` 唯一（`client_id` 为 NULL 时不受限）。
- `messages` 的 `(conversation_id, position)` 唯一。
- 角色、状态、反馈、标题来源、已读状态均有 CHECK。
- 用户删除级联业务数据；会话删除级联消息；文件随会话删除仅置空关联。

生产数据库是单文件 SQLite（`/data/matrius.db`），启用 WAL、`foreign_keys=ON`、`busy_timeout`（默认 30 秒）和 `synchronous=NORMAL`。它只支持单机单实例：写事务串行化，`with_for_update()` 在 SQLite 上不生效，因此业务事务要保持短小，文件 I/O 不放在数据库事务内。需要多实例或高写入并发时应换回 PostgreSQL。

结构变更必须走 Alembic，并在空 SQLite 上验证全部迁移可执行；API 启动时运行 `alembic upgrade head` 和 `alembic check`。

## 账号功能开关

认证返回的 `UserOut` 增加 `features: string[]`，登录响应与 `/api/auth/me` 动态计算。清单位于 `app/features/registry.py`，preview 仅 `admin_test` 开放；stage 为 stable 的功能对所有已认证且完成首次改密的用户开放，部署成功后立即生效。`require_feature(id)` 必须用于新增受控接口，账号停用或会话撤销后不能继续调用。

- `GET /api/features`：返回当前账号可用的功能元数据。
- `GET /api/features/labs`：受 labs 功能校验的实验页数据；匿名 401、无功能权限 403。
- 认证与功能响应禁止缓存；权限不接受客户端 username、header 或 query 覆盖。

功能发布仅改变代码中的 stage，不修改用户数据或表结构；数据库迁移另行审查与执行。
