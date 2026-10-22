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
npm run dev                 # 本机 Expo + FastAPI 热更新，通过 SSH 借用云端四项基础服务
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
- PostgreSQL 存持久数据，Redis 只做限流与缓存，RustFS 存文件；结构变更走 Alembic，并确保能在空库执行。
- 保持简单：不引入微服务、多 Agent 编排、RBAC、组织或租户。
- 新增状态管理、网络或代码生成库前先与维护者确认。

## 功能开关

- 新功能先在 `server/app/features/registry.py` 登记，默认 `preview`。
- `preview` 仅认证后的 `admin_test` 可用（`PREVIEW_USERNAME` 可配），与 `isAdmin` 无关。
- 前端统一用 `useFeature` / `FeatureGate`，后端用 `require_feature`，禁止按客户端用户名授权。
- 验证通过后改为 `stable`；只有 `--publish` 在健康检查后更新发布清单。

## 部署

- 唯一入口是 `npm run deploy`：同步源码、服务器构建生产镜像、健康检查后退出。不运行 Metro 或 Uvicorn 热重载。
- `npm run dev` 常驻运行本机 Expo、FastAPI 和 SSH 隧道，开发 API 共用云端数据；Ctrl+C 仅停止本机进程。不自动执行迁移。
- 默认部署不更新功能清单；`--publish` 才把 stable 功能开放给其他账号。
- 新服务器必须先执行 `npm run deploy -- --init`，生成配置、初始化数据库和管理员并启动全部容器；普通 `deploy` 更新 Web/API，并应用端口和 Caddy 配置变更；四项基础服务按 Compose 配置按需更新，未变化不重建；可选内部端口在服务端模板中默认注释。后续显式迁移用 `--migrate`。
- 本机 `.env.local` 只放连接信息、可选的端口覆盖（`APP_PORT` / `API_PORT` / `APP_HTTPS_PORT`、`DEV_WEB_PORT` / `DEV_API_PORT`）和 `INITIAL_ADMIN_*`；服务密钥持久化仅在服务器。`dev` 经 SSH 读取运行中容器凭据，仅在内存中传给本机 API，不写文件或日志。
- 不在本机对服务器执行迁移；`docker compose down` 永远不加 `-v`。
- 不配置自动 CI；CD 手动触发并复用 `--publish`。

## 完成前

- 运行 `npx expo lint`、`npx tsc --noEmit` 和受影响测试，如实报告结果。
- 未实测的平台行为要说明范围，不把推断写成已验证。
- 产品边界、持久化、目录职责或命令变化时同步更新 `doc/` 和 README。
- 不提交密钥、令牌或真实用户数据。
