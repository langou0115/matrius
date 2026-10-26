# AGENTS.md

Matrius 是 Expo + React Native（Web 优先）前端与 FastAPI 后端的自部署 AI 对话应用。

## 开始前

- Expo 每个 SDK 都有破坏性变更，不要凭记忆写 API。先看 `package.json` 中的 `expo` 版本，再查 `https://docs.expo.dev/versions/v<major>.0.0/`。
- 按任务阅读对应文档：

| 任务 | 文档 |
| --- | --- |
| 产品边界与开发顺序 | [产品](doc/product.md) |
| 页面、模块与文件职责 | [客户端结构](doc/client-structure.md) |
| 存储与数据访问 | [存储与数据](doc/data.md) |
| 认证与功能开关 | [认证](doc/auth.md) |
| 后端接口与数据模型 | [后端架构](doc/backend.md)、[server/README.md](server/README.md) |
| 命令、测试与交付 | [开发与验证](doc/development.md) |
| 服务器与运维 | [服务器部署](doc/deployment.md) |

## 常用命令

```bash
npm ci
npm run dev                 # 本机 Expo + FastAPI 热更新，SQLite 与文件都在 server/.data
npm run web                 # Web 开发（Metro，可访问 /mock）
npx expo start              # Metro 开发服务
npx expo lint
npx tsc --noEmit
npm run test:rendering
npm run test:models
npm run test:auth
npm run test:deploy
npm run test:dev
npx expo install <package>  # 安装 SDK 兼容版本，不要用 npm install 装 Expo 相关包
```

后端检查：

```bash
cd server
bash scripts/install-python-deps.sh --dev
uv run --no-sync ruff check .
uv run --no-sync pytest
```

## Expo 约定

- 路由只用 Expo Router，页面在 `src/app/`，组件和 hooks 放在路由目录外。
- 不手改 `ios/`、`android/`；原生配置写在 app config 或 config plugin。
- 新增原生库后需要 development build；Expo Go 不包含第三方原生模块。

## 架构与边界

- 依赖方向：UI → features → storage → data source。
- Agent Runtime 在客户端运行；服务端只提供工具 API 和单次模型代理。
- 本地模式数据在 IndexedDB；云端模式服务端是唯一事实源，不做本地缓存或增量同步。
- 模型密钥只存客户端，不写日志、不上传。
- 云端资源按认证得到的 `userId` 隔离，写操作使用 `baseRevision` 乐观并发。
- SQLite 存持久数据（单服务器、单实例、单 uvicorn worker），文件落在 `DATA_DIR/files`，限流与短期缓存只存在于 API 进程内存；结构变更走 Alembic，并确保能在空库执行。
- 保持简单：不引入微服务、多 Agent 编排、RBAC、组织或租户。
- 新增状态管理、网络或代码生成库前先与维护者确认。

## 功能开关

- 新功能先在 `server/app/features/registry.py` 登记，默认 `preview`。
- `preview` 仅认证后的 `admin_test` 可用，与 `isAdmin` 无关。
- 前端统一用 `useFeature` / `FeatureGate`，后端用 `require_feature`，禁止按客户端用户名授权。
- 验证通过后改为 `stable`；下次 `npm run deploy` 健康检查通过后即对所有账号开放。

## 部署

- 唯一入口是 `npm run deploy`：同步源码、服务器构建生产镜像、健康检查后退出。不运行 Metro 或 Uvicorn 热重载。
- `npm run dev` 完全在本机常驻运行 Expo 与 FastAPI，数据在 `server/.data/dev.db` 和 `server/.data/files`，不访问服务器；Ctrl+C 仅停止本机进程。启动时自动迁移开发库并运行 `alembic check`。
- 部署成功后，代码中 stage=stable 的功能立即对所有账号开放。
- 生产只运行 Caddy / Web / API 三个容器，持久化只有 `matrius_prod_api_data` 卷（SQLite + 上传文件）。`npm run deploy` 没有子命令：首次执行自动初始化，之后每次都会备份数据库、应用迁移、刷新管理员密码、更新 Web/API 与 Caddy；`--remove-orphans` 会清理旧拓扑遗留容器。
- `.env.local` 管本地开发与通用应用设置：`DEV_WEB_PORT` / `DEV_API_PORT`、`INITIAL_ADMIN_*`、`AUTH_SESSION_TTL_SECONDS` 等。服务器相关内容放在 `docker-compose/.env.production`（SSH 目标、`APP_PORT` / `API_PORT` / `APP_HTTPS_PORT`、`REMOTE_WORKSPACE`），`npm run deploy` 从该文件读取；`.env.local` 只作覆盖。`.env.local` 中的通用应用项（`AUTH_SESSION_TTL_SECONDS`、限额、`LOG_LEVEL` 等）会在部署时写入服务器 `production.env`。本机代理写 `WEBTOOL_PROXY_URL`，只在开发时使用、不会上传；生产代理写 `WEBTOOL_PROXY_URL_PRODUCTION`，部署时映射为服务器的 `WEBTOOL_PROXY_URL`，且必须是容器可达地址（`host.docker.internal` 等，loopback 会被拒绝）。`INITIAL_ADMIN_*` 同时用于开发库和正式服务器；示例密码 `change-me` 会被 `npm run dev` 和 `npm run deploy` 拒绝，必须先改成真实密码。正式库的管理员密码以最近一次部署为准：每次部署都会把 `INITIAL_ADMIN_*` 应用到该账号；两个值留空则不改动现有密码。`dev` 不连接服务器，也不读取 `docker-compose/.env.production`；开发模式下后端直接读取 `.env.local`，代理、搜索/抓取预算等运行时设置保存后自动生效，端口、数据库路径和管理员初始化仍需重启。
- 不在本机对服务器执行迁移；`docker compose down` 永远不加 `-v`。
- 不配置自动 CI；CD 手动触发并复用 `npm run deploy`。

## 完成前

- 运行 `npx expo lint`、`npx tsc --noEmit` 和受影响测试，如实报告结果。
- 未实测的平台行为要说明范围，不把推断写成已验证。
- 产品边界、持久化、目录职责或命令变化时同步更新 `doc/` 和 README。
- 不提交密钥、令牌或真实用户数据。
