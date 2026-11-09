# 架构与模块边界

[文档索引](README.md)

## 单用户实例

```text
React 19 + Vite + React Router 7
├── 实例登录保护：未登录时只有登录入口
├── Agent Runtime：上下文、循环、流式事件、工具调度与取消
├── REST /api/* → FastAPI → SQLite / 文件系统
├── /api/model-proxy/* → Web 中继 → 模型服务商
└── IndexedDB：模型配置、密钥与设备状态
```

服务端是业务数据的唯一事实源，不提供匿名本地工作区、双向同步或本地/云端模式切换。
Agent Runtime 始终在浏览器运行；后端只执行单次工具请求，模型中继只转发单次模型调用。
模型服务配置与密钥只持久化在当前浏览器，中继请求期间向服务商传递凭据，不保存或记录密钥。

## 唯一所有者与访问保护

每个部署只有一个工作区，`instance` 单例表绑定唯一 `owner_id`。
没有用户创建、角色、用户停用、`/admin` 或 `/api/admin/*`。
历史 `users` 行和 `user_id` 外键为数据兼容保留，所有认证必须匹配实例所有者；旧账号令牌不可用。
跨设备与多标签页仍使用 `baseRevision` 防止静默覆盖。
`/api/account/import` 保留作旧数据导入兼容，不能用来访问或混入其他历史账号的数据。

外部多用户、域名分配、容器编排与实例管理属于另一个项目，本工程短期不做。

## 存储

- 开发：`server/.data/matrius.db`、`server/.data/files/<fileId>/<文件名>`。
- Docker：`/data/matrius.db`、`/data/files/<fileId>/<文件名>`。
- 临时草稿在 `DATA_DIR/drafts/<draftId>/`，元数据仅在 API 内存，重启失效。
- 搜索结果缓存、限流、登录失败和并发计数在进程内，API 保持单 worker。
- 数据迁移走 Alembic，旧库选择与旧文件迁移见[存储与数据](data.md)。

## 依赖与职责

UI → features → repository → API / storage。
路由事实源为 `src/router/routes.tsx`，页面外壳为 `components/web/app-shell.tsx`。
`instance-workspace.tsx` 负责登录边界、后端工作区加载、保存队列与错误反馈。
模型、聊天、记忆、文件、设置分别位于 `src/features/`，无 DOM 的 Agent 与协议适配位于 `src/core/`。
后端 `auth/` 验证所有者，`conversations/` 管理聊天，`account/` 管理偏好/画像/记忆，`files/` 与 `documents/` 管理文件和文档工具。
开发预览只在 `/mock/*`，使用内存数据，生产构建关闭。

不增加微服务、RBAC、组织、租户或多 Agent 编排。接口细节见[后端架构](backend.md)。
