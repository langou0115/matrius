This is an Expo/React Native mobile application. Prioritize mobile-first patterns, performance, and cross-platform compatibility.

## Expo has changed — do not trust your training data

Expo ships breaking changes every SDK release. APIs you remember are likely renamed, moved, or removed. Before writing any code that touches an Expo, EAS, or React Native API:

1. Read the major version of the `expo` package in `package.json`.
2. Fetch the matching versioned docs: `https://docs.expo.dev/versions/v<major>.0.0/`
3. For anything else, fetch https://docs.expo.dev/llms.txt — an index of all Expo docs with corrections to common LLM misconceptions. Follow its links to the specific page you need; never answer from memory.

## Commands

Use `bunx` instead of `npx` if the project uses bun (`bun.lock` present).

```bash
npx expo install <package>  # ALWAYS use instead of npm/yarn/pnpm/bun add — resolves SDK-compatible versions
npx expo start              # start the dev server
npx expo lint               # lint
npx tsc --noEmit            # typecheck
npx expo-doctor             # diagnose dependency and config issues
npx expo install --fix      # fix incompatible package versions
```

Run lint and typecheck before declaring any task done.

## Navigation & Routing

- Use **Expo Router** for all navigation. Routes live in `src/app/` — every file there is a screen, `_layout.tsx` files define navigators. Keep non-route code (components, hooks, utils) outside `src/app/`.
- Import `Link`, `router`, and `useLocalSearchParams` from `expo-router`.
- Docs: https://docs.expo.dev/router/introduction.md

## Building with EAS

Use EAS to build, sign, and submit the app in the cloud (`eas build`, `eas submit`) and to ship over-the-air updates (`eas update`) — no local Xcode or Android Studio required. Run EAS CLI as `bunx eas-cli <command>` in Bun projects, or `npx eas-cli@latest <command>` otherwise; substitute that for bare `eas` in docs examples.
Docs: https://docs.expo.dev/eas/index.md

## Rules

- If `ios/` and `android/` directories do not exist, they are generated (Continuous Native Generation). Never create or edit them by hand — configure native behavior in `app.json` and config plugins.
- Expo Go only includes its bundled native modules. After adding a library with native code, the app needs a development build: `npx expo run:ios|android` locally, or `eas build --profile development`.
- Prefer recommended Expo modules over third-party libraries, and check your available skills before adding dependencies. Docs: https://docs.expo.dev/versions/latest/index.md


## Matrius 项目约定与文档入口

本工程由 `../matrius-old` 迁移，使用 React Native + Expo + TypeScript。当前优先开发 Web 端，已完成聊天界面与外观设置；移动端后续适配。`doc/migration.md` 记录已完成与待实现项。

| 任务 | 修改前阅读 |
| --- | --- |
| 产品边界、模式与开发顺序 | [产品约定](doc/product.md) |
| 模块、页面与文件职责 | [架构](doc/architecture.md)、[客户端结构](doc/client-structure.md) |
| UI、主题、字体、选区与模型直连 | [UI 风格](doc/ui-style.md)、[客户端约定](doc/client.md) |
| 本地存储、离线缓存与同步 | [存储与同步](doc/data.md) |
| 认证与管理员 | [认证](doc/auth.md) |
| Runtime、协议与工具 | [Agent 与工具](doc/agent.md) |
| 文件解析与记忆 | [文件与记忆](doc/files-and-memory.md) |
| 命令、验证与交付 | [开发与验证](doc/development.md) |

- Agent Runtime 在两种模式下均运行于客户端本地，负责上下文、循环、运行状态、工具调度与取消。网络搜索、网页读取和文件处理通过云端工具 API 执行；服务端模型代理只处理单次请求，不运行 Agent Loop。
- 本地与云端共用 UI 和数据模型。未登录可用本地模式；云端专属入口整体隐藏，登录引导集中在设置页。
- 本地模型 key 通过安全存储适配层管理，不写日志、不上传同步；云端模型 key 仅服务端保管，不下发客户端。
- 云端数据按认证得到的 `userId` 隔离，服务端独立验证资源归属。
- PostgreSQL 保存云端持久数据，Redis 保存临时状态，RustFS 保存文件。所有数据库结构变更走迁移。
- 本地存储按平台实现：Web 数据保存在浏览器 IndexedDB，App 后续保存在手机本地数据库，不沿用旧版 drift。云端是事实源，本机保留离线缓存，合并和重试不得丢数据。
- 当前阶段 Web 优先，移动端后续适配；共享状态和业务契约不依赖 DOM，平台差异集中在平台文件与适配层。
- UI → 功能模块 → 仓储 → 数据源，保持单向依赖；功能可见性由统一能力集驱动。
- 保留旧版主题只改变颜色的设计；布局、圆角、字体统一管理。按钮不显示悬停文字说明，但保留无障碍名称和焦点反馈。
- 保持简单，不提前构建微服务、多 Agent 编排、工作流、RBAC、组织或租户系统。
- 新增第三方状态管理、网络或代码生成库前先与维护者确认；路由统一使用 Expo Router。
- 产品边界、持久化、目录职责或命令变化时同步更新 `doc/` 和根 `README.md`。
