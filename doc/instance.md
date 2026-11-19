# 实例访问与资源

Matrius 是单用户实例；所有通过访问验证的客户端共享对话、文件、模型配置、偏好和用量。若服务端未配置 `AUTH_SECRET`，则无需登录即可使用；若在 `.env.local` 或环境变量设置了 `AUTH_SECRET`，打开网页时需先在开屏界面输入访问密钥解锁（服务端签发 `HttpOnly` Cookie），设置页「关于 Matrius」中可随时手动锁定。没有多用户账户或角色体系。侧边栏底部直接打开设置，存储和用量归入「资源」。

客户端通过 GET /api/features 初始化实例能力，断网时重连，不回退到本地业务数据。当配置了 `AUTH_SECRET` 时，受保护 `/api/*` 未解锁会返回 401，开屏页通过 `/api/auth/status`、`/api/auth/unlock` 与 `/api/auth/lock` 管理 `HttpOnly` HMAC 会话 Cookie。业务数据导入和删除标记接口位于 /api/workspace/*。

数据库以 0001_initial 为基线创建单实例 schema（instance.id=1 及指向它的业务表，画像和偏好表为 profiles、profile_fields、preferences），并在启动或执行 `npm run db:migrate` 时按顺序应用 `server/db/migrations/` 下的后续 SQL 迁移（`0002_scheduled_tasks`、`0003_ui_blocks`、`0004_model_configs`），兼容保留 `alembic_version` 表，无需 Python 或 Alembic CLI。空库初始化不会生成迁移备份或其他伴随文件。开发期的旧多账户迁移链（0001–0011）已移除。

存储接口 GET /api/files/usage 返回 disk.total、disk.used、disk.free。这里不再读取主机的文件系统，而是以 `STORAGE_LIMIT_BYTES`（默认 128 MiB）作为应用存储上限，`used` 是已保存文件的字节总和；上传和文档保存超出上限时返回 413 `storage_full`。

files、images 分类仍仅统计本应用文件，便于进入资料库清理。取消旧的 512 MiB 账户配额；上传与文档保存按 `STORAGE_LIMIT_BYTES` 检查，单文件大小及工具并发限制保留。配额检查不是空间预留，写入时仍可能因底层磁盘耗尽而失败。

启动不接收或更新账户凭据，不生成管理员密码文件。旧账户迁移的兼容代码已移除，开发阶段不做历史账户数据迁移。
