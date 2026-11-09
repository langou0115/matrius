# 实例访问保护

[文档索引](README.md)

每个 Matrius 实例只有一个所有者。没有注册、创建用户、管理员角色、重置其他用户密码、停用用户或用户列表；`/admin` 页面和 `/api/admin/*` 已移除。

## 初始化与升级

为兼容现有部署，继续使用 `INITIAL_ADMIN_USERNAME` / `INITIAL_ADMIN_PASSWORD` 环境变量，含义改为实例所有者登录凭据。

- 空库：bootstrap 根据配置创建唯一所有者并写入 `instance` 单例记录。
- 旧库只有一个账号：迁移绑定该账号，配置应与该账号用户名一致。
- 旧库有多个账号：迁移用 `INITIAL_ADMIN_USERNAME` 匹配已有账号；未匹配时停止并提示配置，不自动选人、不合并或删除数据。
- 绑定完成后，修改环境变量不能切换所有者；用户名不匹配时 bootstrap 拒绝启动。
- 每次 bootstrap 都会应用配置中的所有者密码；配置为空时不改现有密码。密码发生变化时撤销旧会话。
- 单例表通过 `id = 1` 检查约束和主键保证只有一条绑定。旧账号及其数据保留作迁移兼容，其密码和令牌均不能访问实例。
- 升级到单用户架构会撤销全部旧会话，需要重新登录。
- 开发默认凭据仍为 `admin` / `dev-password`；示例密码 `change-me` 不允许启动或部署。

## 登录与会话

`POST /api/auth/login`、`GET /api/auth/me`、`POST /api/auth/logout`、`POST /api/auth/change-password`。
认证查询必须同时匹配 `instance.owner_id`，只接受普通 user scope，会忽略历史 admin scope。
客户端不接收或展示角色字段。
浏览器使用 `matrius_session` HttpOnly、SameSite=Lax Cookie；HTTPS 下加 Secure，`/me` 验证时滑动续期。
Bearer 令牌仅作为 API 访问方式，会话保存在 SQLite；退出或撤销后立即失效。

所有业务接口、搜索/抓取与同源模型中继都要求有效实例会话；健康检查公开。
Web 中继校验只向固定 API 服务传递实例 Cookie，不能把模型服务商的 Authorization 当作实例凭据。

保留旧账号首次改密状态的升级兼容。普通改密要求当前密码，新密码非空且不超过 256 字符，不能与当前密码相同。

## 功能能力

能力清单在 `server/app/features/registry.py`，所有者完成必要改密后获得已登记的全部能力。
前端用 `useFeature` / `FeatureGate`，后端用 `require_feature`；没有账号白名单或角色授权。
登录失败计数、限流和并发上限只保存在单 API 进程内存。
