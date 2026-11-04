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
- 同一来源部署下 Web 与 API 同源，CORS 默认无需配置；Web 使用 HttpOnly Cookie，服务端同时接受 Bearer token。

## 目录职责

```text
app/main.py             应用装配、请求 ID/日志、CORS、异常映射
app/config.py           pydantic-settings
app/db.py               async engine / get_db / SQLite PRAGMA
app/cache.py            进程内缓存、滑动窗口限流、登录锁定
app/storage.py          本地文件存储（DATA_DIR/files）
app/auth/               密码哈希、Cookie/Bearer 会话、鉴权依赖、普通登录
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
- 浏览器同时收到 HttpOnly、SameSite=Lax 的持久 Cookie（`matrius_session` / `matrius_admin_session`，Max-Age 400 天，HTTPS 下加 Secure，`/me` 校验时滑动续期），Web 端不保存 token。
- 非浏览器客户端可使用 `Authorization: Bearer <token>`；Cookie 与 Bearer 同时存在时 Bearer 优先。
- `auth_sessions` 保存 `scope`（`user` / `admin`）、最后访问时间、撤销时间；新会话不设自动过期时间，退出或撤销后立即失效。
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

- 字段：`role`（`user|assistant`）、`content`、`steering`（用户补充消息）、`quote`、`reasoning`、`activities`（联网搜索/读取步骤，客户端上传前去掉 snippet/engine）、`process`（完整思考与工具事件顺序，仅用于展示）、`thinkingMs`、`status`（`complete|stopped|error`）、`error`、`feedback`（`good|bad`）、`fileIds`、服务端 `position`。
- `steering=true` 只用于真正注入当前 run 的用户补充/纠正；服务端只接受用户消息上的该标记。`position` 仍按追加顺序分配，客户端加载时依据该标记把消息显示在被插话的助手回复之前。回复正文已开始后发送的消息作为下一轮普通用户消息保存，不带该标记，位置就在已完成的回复之后。
- `status=streaming` 返回 422；用户消息固定 `complete`。
- `position` 在锁定会话行后取 `max(position)+1`，多设备并发追加不会重号。
- 工作流：先 POST 用户消息，回复结束后再 POST 助手消息；流式文本只存在客户端内存。页面中途关闭只会留下用户消息。
- 图片和文档先通过文件 API 上传，消息只保存 `fileIds` 引用（最多 20 个，去重并校验归属）。列表与详情响应同时返回 `files: [{ id, filename, contentType, size, revision }]`，顺序与 `fileIds` 一致；已删除或不属于本人的 ID 不输出。`get_conversation` 对本页所有 `file_ids` 只查询一次文件表。
- `PATCH /api/messages/{id}` 可传 `fileIds` 替换附件：未绑定会话的文件会绑定到当前会话，已属于其他会话的文件返回 422，传空数组表示清空。

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
  } ], "deletedConversationIds": ["local-conversation-id"] },
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
- 可传 `chat.deletedConversationIds`（单批最多 2000 个、每个 1–128 字符）。同一事务内先记录删除标识并级联删除会话正文，再导入其余会话；已删除 ID 的旧副本计入 `skipped`，即使时间戳更新也不复活。普通 REST 会话删除同样记录墓碑；重新创建已删除 ID 返回 409。
- `GET /api/account/conversation-deletions?limit=100&cursor=` 返回 `{ items: string[], nextCursor }`，按用户隔离、按标识 keyset 分页。客户端逐页读取，并在合并前删除本地对应会话；本地墓碑也过滤同步期间晚到的响应。
- 迁移 `0002_conversation_deletions.py` 新增仅含 `(user_id, client_id)` 的持久删除表，不存正文；普通 REST 会话创建/删除与导入共用写锁。

## 文件

```text
POST   /api/files            multipart: file, conversationId?, clientId?
GET    /api/files?query=&kind=all|image|document|text&sort=created|name|size
                  &order=asc|desc&conversationId=&cursor=&limit=1..200
GET    /api/files/usage                        → { used, quota }
POST   /api/files/bulk-delete { ids: [...] }   ≤100，去重
PATCH  /api/files/{id}        { filename }     不允许改扩展名
GET    /api/files/{id}
GET    /api/files/{id}/content
DELETE /api/files/{id}
```

- 单文件默认 20 MiB，每用户默认 512 MiB；并发上传解析限制为 2。
- `conversationId` 同时接受会话主键和客户端的 `clientId`：聊天客户端只知道后者；服务端解析后统一写入主键，列表过滤也支持两种形式。
- 白名单：文本/代码/Markdown/CSV、图片、PDF、DOCX、XLSX、PPTX，以及旧版 DOC/XLS/PPT。旧格式原样保存，读取时才转换。
- 列表按 `(sort_value, id)` keyset 分页，返回 `{ items, nextCursor }`；文件名搜索转义 `%`/`_`/`\`；`kind=document` 同时匹配现代与旧版 Office。
- 对象键 `users/{userId}/{fileId}/{safeName}`；内容写入 `DATA_DIR/files`（生产为 `/data/files`），先写文件再写数据库，数据库失败时补偿删除对象。写入使用临时文件 + `os.replace` 原子替换。
- 下载先校验归属；设置 `X-Content-Type-Options: nosniff`，非图片使用 `Content-Disposition: attachment`。
- 单条删除先删对象再删记录；批量删除先提交数据库删除再 best-effort 删除对象（最坏留下孤儿对象，不会出现“对象没了但行还在”）。文件随会话删除只置空 `conversation_id`。
- 重命名只改数据库文件名，不改对象键，`revision` 递增；空名或改扩展名返回 422。
- 解析：PDF 用 pypdf；DOCX/XLSX/PPTX 用 python-docx/openpyxl/python-pptx；旧版 Office 先经 LibreOffice 转换；其他白名单文件按纯文本解码（UTF-8，失败时使用 charset-normalizer）。不做 OCR。
- 单次提取上限 2,000,000 字符；解析结果缓存在 API 进程内 1 小时，重启后重新解析。

## 云端工具

### 搜索

```text
POST /api/tools/search { query, limit? (1-20, 默认 10) }
```

- 主来源是 `ddgs` 的 `duckduckgo` 后端；只有失败、超时、被限流或零结果时才在剩余预算内回退 Bing RSS，不混合两家的结果。整次搜索上限 `SEARCH_TIMEOUT_SECONDS`（默认 8 秒），单次 ddgs 上限 `SEARCH_DDGS_TIMEOUT_SECONDS`（默认 4 秒），为回退预留约 2 秒。DuckDuckGo 的 HTML 接口改用 GET：不少代理出口会对 POST 返回 HTTP 202 验证页，而同一地址仍接受 GET；202/403/429 归类为 `blocked`。
- 快速传输失败最多尝试 `SEARCH_MAX_ATTEMPTS`（默认 2）次；超出预算、被限流或耗时超过 2 秒的失败不重试，避免遗留后台请求。Bing 回退同样最多尝试 2 次，只重试超时或传输错误，并复用进程内的长连接以减少代理 TLS 握手开销。连续失败 `SEARCH_BREAKER_FAILURES`（默认 3）次后熔断 `SEARCH_BREAKER_COOLDOWN_SECONDS`（默认 60 秒），期间直接走 Bing；`0` 可关闭熔断，`SEARCH_FALLBACK=false` 可只保留 DuckDuckGo。
- 可达来源返回零结果时响应 `200 []`，不缓存；只有实际尝试的所有来源都失败才返回 502 `upstream_error`。这修复了旧逻辑中「DuckDuckGo 失败 + Bing 成功但零结果」被误报为 502 的问题。
- 服务端规范化 URL、移除跟踪参数、去重，按查询关键词与标题/域名/摘要的相关性排序，再优先保证域名多样性；标题截断 280 字符，摘要 640 字符。相关性只是词面匹配，不等于事实核实。
- 非空结果缓存在进程内 5 分钟；并发 4，Bing RSS 响应体上限 `SEARCH_MAX_BYTES`（默认 2 MiB）。
- 相同查询使用 single-flight 合并并发请求；每个账号最多 4 个在途搜索，超出立即返回 429。
- `WEBTOOL_PROXY_URL` 同时用于搜索和网页读取的上游连接；配置后始终走代理，没有直连兜底。生产值只来自 `.env.local` 的 `WEBTOOL_PROXY_URL_PRODUCTION`，开发机的 `WEBTOOL_PROXY_URL` 不会同步到服务器。

### 网页读取

```text
POST /api/tools/fetch { url, mode? (fast|full) }
```

- 先做 SSRF 校验：仅 http/https、禁止 URL 凭据、禁止 localhost/私网/链路本地/ULA/组播，DNS 解析后要求所有地址 `is_global`。
- 手动跟随最多 5 次重定向，每一跳都用 `urljoin` 后重新校验，防止重定向到内网；非文本类型返回 422。
- 整次 `FETCH_TIMEOUT_SECONDS`（默认 45 秒）截止时间覆盖排队、跳转、响应体下载和提取；流式读取按 `FETCH_MAX_BYTES`（默认 5 MiB）截断。下载失败只在超时、传输错误、5xx 或 `Retry-After <= 5` 秒的 429 时重试，最多 `FETCH_MAX_ATTEMPTS`（默认 2）次，剩余时间不足 5 秒不再重试。
- content-type 明确为文本时直接接受；明确为图片、音视频、字体、PDF、压缩包或 Office 文档时直接拒绝。缺失、`application/octet-stream` 或未知类型时读取前 4 KiB 嗅探：NUL、二进制魔数或大量不可打印字符拒绝；HTML / JSON / 纯文本按实际内容处理。非 HTML 的 JSON、XML、代码、纯文本和 Markdown 原样保留结构。
- HTML 的提取链是 `trafilatura`（`fast` 先 precision、`full` 先 recall，结果为空时换另一种偏向重试）→ `html_markdown.py` → lxml 纯文本。提取前清理 NUL 和 C0 控制字符；`html_markdown` 返回空字符串时继续降级到 lxml。返回 title/url/text，文本截断 `FETCH_MAX_CHARS`；text 字段可包含 Markdown。缓存版本随提取格式更新，避免复用旧版扁平正文。
- 404/410 返回 422 `fetch_not_found`；401/403 和验证页返回 422 `fetch_blocked`；纯 JavaScript 空壳返回 422 `fetch_requires_browser`。上游 429 返回 503 `fetch_rate_limited` 并传递 Retry-After，下载超时为 504 `fetch_timeout`，代理失败为 502 `fetch_proxy_error`，网络失败为 502 `fetch_network_error`。无浏览器渲染、登录或验证码处理能力；这些页面不会冒充成功读取。
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
- 返回结果包含 `tookMs`、`proxy`（是否配置了 `WEBTOOL_PROXY_URL`）和 `diagnostics`。搜索诊断包含 provider / status / attempts / elapsedMs / fallback / fallbackStatus 等；读取诊断包含 extractor / attempts / contentType / finalUrl / truncated。失败沿用统一 `{"error":{"code","message"}}` 响应。

### 统一文件工具

```text
POST /api/tools/file
{
  operation: list|read|grep|help|inspect|create|edit|save|delete,
  conversationId?, fileId?（UUID 或 draft:<uuid>）, filename?, format?,
  element?, path?, commands?, pdfChanges?, save?, start?, end?, maxChars?,
  pattern?, context?, maxMatches?
}
```

- 仅对所有者为本人的文件可用，并要求账号具备 `files` 功能；响应为 `{ operation, file?, draft?, fileId?, filename?, text?, truncated?, files? }`，`file` 复用 `file_out`。
- 读类操作（list/read/grep/help/inspect）每账号 60 次/分钟，写类（create/edit/save/delete）20 次/分钟；每账号最多 2 个在途文档操作。
- 操作级校验在请求模型中完成：`create` 不能带 `fileId`，`edit` 必须提供与格式匹配的 `commands` 或 `pdfChanges`，`save` 只接受草稿，`read`/`grep`/`delete` 必须有 `fileId`。PDF 拒绝 `commands`，Office 拒绝 `pdfChanges`。`delete` 接受资料库文件 UUID 或 `draft:<uuid>`：删除已保存文件时先删对象再删行，历史消息保留文件名和引用。
- Office 属性白名单、文档路径（必须以 `/` 开头，禁止 `..`/NUL/CRLF，≤500 字符）、命令与 PDF 变更均限最多 100 条；不接收 raw XML、任意 CLI 参数、图片导入或外部资源。`add` 允许 `markdown`（DOCX 展开标题/列表/GFM 表格）与 `textbox`（DOCX/PPTX 浮动文本框）元素，`markdown` 属性只接受内联文本，不接受 `src` 文件路径。
- Office 操作经 vendored OfficeCLI 子进程执行，不使用 shell，环境变量白名单，超时杀进程组，stdout/stderr 累计超限即终止。PDF 使用 pypdf + reportlab，在 `asyncio.to_thread` 中运行。
- 单次结果约 30,000 字符并标记 `truncated`；文档内容按不可信资料返回。
- Office 批量命令失败返回命令序号、引擎错误码及修复建议，不回显命令正文；例如新建 Excel 已有 `Sheet1`，再次添加同名表会提示先检查已有表。文件工具参数校验失败把字段位置和校验原因返回给客户端 Agent，以便修正下一次调用。
- 草稿：元数据在进程内，二进制在 `DATA_DIR/drafts/{userId}/{draftId}/`；TTL 默认 30 分钟，每用户最多 10 个、总计 60 MiB，跨用户 404。保存成功后删除草稿。
- 保存编辑结果时检查 `StoredFile.revision == base_revision`，不一致返回 409；先写新对象再更新行，提交后 best-effort 删除旧对象。旧版 Office 编辑后的保存会新建文件，不改原件。
- 兼容保留 `POST /api/tools/files/read|grep`：按行读取（单次最多 50,000 字符）与正则匹配（最多 200 条）。

## 限流

| 端点 | 限制 |
| --- | --- |
| 登录 | IP 10/分钟；用户名 5/分钟；连续失败 15 次锁定 15 分钟 |
| 会话/消息/账号写操作 | 用户 120/分钟 |
| 会话/消息/账号读取 | 用户 240/分钟 |
| 文件上传 | 用户 20/分钟，并发解析 2 |
| 搜索/网页读取 | 用户 30/分钟，并发 4 |
| 文档工具读（list/read/grep/help/inspect） | 用户 60/分钟，并发 2 |
| 文档工具写（create/edit/save/delete） | 用户 20/分钟，并发 2 |

计数保存在 API 进程内，重启后清零；只影响频率限制，不影响账号与数据隔离。

## 健康检查与日志

- `GET /api/health`：数据库探活；成功 `{"service":"matrius","status":"ok"}`。远程发布与容器健康检查使用此接口。
- `GET /api/health/ready`：并行检查 `database`、`schema`（数据库 revision 与镜像 head 一致）、`cache`、`storage`；任一失败返回 503 与 `checks`。另在 `documents` 中报告 OfficeCLI/LibreOffice 的路径与哈希状态；缺失只记 warning，不改变 HTTP 状态，聊天、上传和文本文件仍可用。
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

认证返回的 `UserOut` 增加 `features: string[]`，登录响应与 `/api/auth/me` 动态计算。清单位于 `app/features/registry.py`，登记的功能对所有已认证且完成首次改密、未停用的用户开放，部署成功后立即生效；没有预览名单。`require_feature(id)` 必须用于新增受控接口，账号停用或会话撤销后不能继续调用。

- `GET /api/features`：返回当前账号可用的功能元数据；匿名 401。
- 认证与功能响应禁止缓存；权限不接受客户端 username、header 或 query 覆盖。

功能登记不修改用户数据或表结构；数据库迁移另行审查与执行。
