# 原生 iOS/Android UI 第一版 TODO

> 完成后删除本文件。实现原则：视图原生重写，状态与 Agent 核心复用；Web 现有实现不变。

## Context

仓库目前是 Web 优先：真实界面全部在 `*.web.tsx`（DOM + `src/global.css`），原生路由（`src/app/*.tsx`）只是“待适配”占位页。本次从零建立一套 **iOS/Android 共用的 React Native UI**。

iOS 与 Android 使用同一份原生代码、同一套页面与交互，不存在 iOS 专用实现或 `Platform.OS` 布局分叉：设置单页栈、无 jump-to-bottom、无消息导航/提问索引、侧栏长按菜单在两端一致。第一版以 iPhone + Expo Go 验收，Android 直接复用。

用户明确要求：
- [ ] 对话区不显示 jump to bottom 按钮（iOS/Android 统一）。
- [ ] 不显示侧边栏“消息导航 / 提问索引”。
- [ ] 侧边栏长按会话弹出操作菜单（置顶 / 重命名 / 删除）。
- [ ] 设置改为单页栈（分类列表 → 详情），不做 Web 左右双栏；Android 同样如此。
- [ ] `npm run dev:ios` 必须同时启动后端与 Expo iOS 目标；`npm run dev` 与 `npm run dev:web` 等价。
- [ ] 数据范围：本地 + 账号登录 + 云同步；模型配置提供基础表单。

---

## 阶段 0：基线确认

- [ ] 记录 Web 基线：`npx tsc --noEmit`
- [ ] `npx expo lint`
- [ ] `npx expo export --platform web`
- [ ] `npm run test:dev`

全部通过后再进入阶段 1。

---

## 阶段 1：依赖与平台基础

### 1.1 新增依赖

```bash
npx expo install expo-sqlite expo-secure-store expo-image-picker expo-clipboard @expo/vector-icons
```

- [ ] `expo-sqlite`：本地键值存储 + revision 乐观并发。
- [ ] `expo-secure-store`：登录 token 与模型 API key。
- [ ] `expo-image-picker`：相册/相机附件。
- [ ] `expo-clipboard`：复制消息/代码。
- [ ] `@expo/vector-icons`：替代 `lucide-react`。
- [ ] 不使用 `@expo/ui`、`expo-glass-effect`（Expo Go 不支持）。
- [ ] 流式使用已内置的 `expo/fetch`，不新增依赖。

### 1.2 本地存储抽象

- [ ] 保留 `src/core/database/browser-store.web.ts` 原路径（现有测试直接导入）。
- [ ] 新增 `src/core/database/local-store.web.ts`：纯 re-export 别名。
- [ ] 新增 `src/core/database/local-store.ts`：`expo-sqlite` 单表 `kv(key TEXT PRIMARY KEY, revision INTEGER, value TEXT)`。
- [ ] 事务内完成“读 revision → 比较 → 写入”，保持与 Web 相同的冲突语义。
- [ ] 共享模块（`model-state.tsx`、`chat-runtime.tsx` 等）改为导入 `@/core/database/local-store`。
- [ ] 原生第一版把整个 `WorkspaceData` 存为一条记录；消息分表优化留待后续。

### 1.3 共享 schema

- [ ] 从 `workspace-repository.web.ts` 抽出 `WorkspaceData`、`LoadedWorkspace`、`parseWorkspace`、`stripMessageImages`、`readActivities` 到 `src/features/workspace/workspace-schema.ts`。
- [ ] Web 与原生 `workspace-repository.ts` 都从 schema 导入。
- [ ] `cloud-workspace-repository.ts` 的 `.web` 类型导入改为 schema / 共享类型。

### 1.4 主题颜色

- [ ] 新增 `src/theme/color.ts`：oklch → sRGB hex 纯函数。
- [ ] 新增 `src/theme/native-theme.ts`：`resolveTheme` + 转换，提供 `useNativeTheme()`（跟随 `useAppearance` + `useColorScheme`）。
- [ ] Web 继续使用 oklch CSS 变量。

### 1.5 平台模块（去掉显式 `.web` 依赖）

- [ ] `src/core/platform/auth-session.ts`：原生 `SessionStore`（内存缓存 + SecureStore 异步持久化，导出 `load()`）。
- [ ] `src/core/platform/api-base.ts`：`EXPO_PUBLIC_API_BASE_URL` 优先，其次 `expo-constants` 的 `hostUri`，默认 `http://127.0.0.1:8000`。
- [ ] `src/core/platform/run-protection.ts`：原生 no-op；`chat-runtime.tsx` 改为无后缀导入。
- [ ] `src/features/auth/auth-state.tsx`：原生 `AuthProvider`（Bearer + SecureStore + `AppState` 刷新）。
- [ ] `src/features/auth/network-tools-state.tsx`：原生版本。
- [ ] `src/features/auth/network-tools-preference.ts`：原生版本，改用 local-store。
- [ ] `src/features/auth/sync-preferences.ts`：原生版本。
- [ ] `src/features/auth/account-sync.ts`：抽出 `account-sync-core.ts` 共享合并逻辑；`TextEncoder` 缺失时提供回退。
- [ ] `src/features/models/model-repository.ts`：原生版本，抽出 `model-preferences-core.ts` 共享 normalize/validate。
- [ ] `src/features/models/model-credential-store.ts`：每个服务商的 key 单独存 SecureStore。
- [ ] `src/features/workspace/workspace-repository.ts`：原生 `loadWorkspace`。
- [ ] 现有 `.web.ts` 文件全部保留；共享模块导入改无后缀，由 Metro 选择平台实现。

认证实现：`createAuthSession` 已支持注入 `fetcher`，原生传入 `${baseUrl}${path}` 包装函数，`cookieAuth: false`，token 写入 SecureStore；**不修改 `auth-session.ts` 核心**。

### 1.6 流式与 Metro

- [ ] 原生根布局启动时用 `expo/fetch` 覆盖全局 fetch（仅原生）。
- [ ] `metro.config.js` 的 `@mariozechner/pi-ai` / `env-api-keys.js` resolver 去掉 `platform === 'web'` 限制。
- [ ] `web-tools.ts` 的 `Intl.Segmenter`、`DOMException` 增加存在性守卫与降级。
- [ ] `cloud-workspace-repository.ts` 的 `structuredClone` 增加回退 helper。
- [ ] 确认 `model-proxy.ts` 在原生无 `location` 时返回 null，模型直连服务商。

### 1.7 阶段 1 门禁

- [ ] `npx tsc --noEmit`
- [ ] `npx expo lint`
- [ ] `npx expo export --platform ios`（**关键止损点**：验证 pi-ai / provider SDK 可打包）
- [ ] `npx expo export --platform web`
- [ ] `npm run test:auth`
- [ ] `npm run test:models`

若原生打包失败，本阶段止损，不继续 UI。

---

## 阶段 2：原生主题、Provider 与导航壳

### 2.1 Provider 装配

- [ ] 新增 `src/features/workspace/native-workspace.tsx`，顺序对齐 Web：

```text
AuthProvider
  ModelProvider
    ScopedWorkspace (local / cloud:<userId>)
      AppearanceProvider
        PersonalizationProvider
          ChatProvider
            DraftProvider
              NetworkToolsProvider
                ChatRuntimeProvider
                  WorkspacePersistence
```

- [ ] `ScopedWorkspace` 复用 `workspaceScope`、`createCloudWorkspaceRepository`、`ChatProvider`。
- [ ] 加载/错误态用 RN View 呈现，失败提供重试与“登出回本地”。
- [ ] 云同步沿用 `baseRevision` 乐观并发；登录切 `cloud:<userId>`，退出回本地。
- [ ] `WorkspacePersistence` 沿用 Web debounce 策略（流式 1500ms 云 / 300ms 本地，非流式 0ms），串行保存；`AppState` 进入后台时 flush。
- [ ] 保存失败显示可重试的红色横幅。

### 2.2 根布局

- [ ] `src/app/_layout.tsx` 首行导入 `install-fetch`。
- [ ] 使用 `GestureHandlerRootView` + `SafeAreaProvider` + `NativeWorkspace` + `Stack`（`headerShown: false`）。
- [ ] 注册路由：`index`、`c/[conversationId]`、`settings`、`settings/{appearance,personalization,models,account,labs,about}`、`settings/models/[providerId]`、`settings/models/[providerId]/[modelId]`。
- [ ] `StatusBar` 跟随 `resolvedMode`。
- [ ] 旧路径 `settings/display`、`settings/theme` 重定向到 `/settings/appearance`。

### 2.3 阶段 2 门禁

- [ ] `npx tsc --noEmit`
- [ ] `npx expo lint`
- [ ] `npx expo export --platform ios`
- [ ] `npx expo start --lan`（应用可启动、深浅色切换、设置页可进入、无红屏）

---

## 阶段 3：原生聊天 UI

### 3.1 路由与页面

- [ ] `src/app/index.tsx` → `native-chat-screen`。
- [ ] `src/app/c/[conversationId].tsx` → `native-chat-screen`。
- [ ] 新增 `src/features/chat/native/chat-screen.tsx`：读取 `conversationId`；`useFocusEffect` 维护 visible；发送首条消息后 `router.replace`。
- [ ] 顶栏：打开侧栏、标题、新建对话。
- [ ] 消息列表：`ScrollView`/`FlatList` + `onContentSizeChange` 自动跟随；上滑后停止跟随，发送新消息时回到底部。
- [ ] **不渲染 jump-to-bottom 按钮**（不引入 `ScrollToBottomButton`），iOS/Android 统一。
- [ ] **不渲染 conversation-navigator / 提问索引**。

### 3.2 消息渲染

- [ ] 新增 `native/message.tsx`：用户消息（引用、文本、图片缩略图）；助手消息（推理/过程折叠、正文、状态、复制、重试）。
- [ ] 新增 `native/message-content.tsx` 轻量 Markdown：
  - 段落、标题、列表、引用、粗体/斜体、行内代码、链接、围栏代码块（等宽 + 复制）。
  - 公式/表格先降级为等宽文本；KaTeX 与语法高亮留到下一阶段。
  - 流式期间用纯文本，结束后再解析 Markdown。
- [ ] 选区引用第一版不做。

### 3.3 Composer

- [ ] 多行 `TextInput`，最大高度约 180。
- [ ] 附件：`expo-image-picker`，`base64: true`；最多 4 张、每张 10MB、仅 PNG/JPEG/WebP/GIF；模型不支持图片时禁止发送并提示。
- [ ] 模型选择：Modal 列表，按 provider 分组；选择后 `models.select` + `dispatch({ type: 'bind-model' })`。
- [ ] 思考强度：Modal 选择默认/低/中/高。
- [ ] 发送/停止：运行中显示停止；非运行中显示发送；沿用 steer → send 策略。
- [ ] 无模型时提示去 `/settings/models`。
- [ ] `KeyboardAvoidingView` + safe-area bottom inset。

### 3.4 侧边栏与长按菜单

- [ ] 新增 `native/sidebar.tsx`：RN `Modal` + 左侧面板实现抽屉。
- [ ] 内容：置顶/最近分组、新对话、搜索、底部账号/设置入口。
- [ ] 会话行 `Pressable`：`onPress` 进入会话，`onLongPress`（≈450ms）打开菜单。
- [ ] 长按后抑制 `onPress`（ref 时间戳），避免误跳转。
- [ ] 保留显式“更多”按钮作为无障碍入口。
- [ ] 新增 `native/conversation-menu.tsx`：底部动作菜单（置顶/取消置顶、重命名、删除）。
  - 状态 `{ conversation }`，不依赖 DOM anchor。
  - 重命名 Modal + TextInput（≤120 字）；删除二次确认。
  - 删除当前会话后 `router.replace('/')`。
- [ ] 新增 `native/search-dialog.tsx`：搜索会话标题与消息文本。

### 3.5 阶段 3 门禁

- [ ] `npx tsc --noEmit`
- [ ] `npx expo lint`
- [ ] `npx expo export --platform ios`
- [ ] 真机检查：流式输出、停止、自动跟随（无 jump-to-bottom）、侧栏无提问索引、长按菜单、删除当前会话、搜索。

---

## 阶段 4：原生设置栈与模型配置

### 4.1 设置单页栈（iOS/Android 共用）

- [ ] `src/app/settings.tsx` → `settings-list-screen.tsx`：共享 `settingsItems` + `visibleSettings`，按 group 分组，顶部搜索。
- [ ] 新增 `src/features/settings/native/settings-page.tsx`：SafeArea + ScrollView + 返回按钮 + `KeyboardAvoidingView`。
- [ ] 外观页：显示模式三选一 + 主题列表（hex 色块预览）。
- [ ] 个性化页：自定义指令、如何称呼你、职业、更多关于你、标题模型选择。
- [ ] 关于页：版本、运行模式。
- [ ] Labs 页：`useFeature('labs')` + `/api/features/labs`，403 时 `auth.refresh()`。
- [ ] 旧路径 `settings/display`、`settings/theme` → Redirect。

### 4.2 模型服务：provider → model 两级

- [ ] `settings/models` → `native/models-screen.tsx`：服务商列表、添加/编辑、删除确认。
- [ ] 服务商表单：名称、协议、Base URL、API key、是否需要 API key。
- [ ] `settings/models/[providerId]` → `native/provider-screen.tsx`：模型列表、获取模型目录、手动添加、删除。
- [ ] `settings/models/[providerId]/[modelId]` → `native/model-screen.tsx`：显示名称、模型 ID、上下文窗口、最大输出、支持图片。
- [ ] 新增 Web 保护路由 `.web.tsx` → Redirect 到 `/settings/models`，避免 Web 误入原生页。
- [ ] 运行中禁止修改（沿用 `isAnyRunning` 提示）。

### 4.3 阶段 4 门禁

- [ ] `npx tsc --noEmit`
- [ ] `npx expo lint`
- [ ] `npx expo export --platform ios`
- [ ] `npm run test:models`
- [ ] 真机检查：列表 → 详情单栈返回；新增服务商；拉取模型；手填模型 ID；主题切换全页面生效；个性化返回聊天生效。

---

## 阶段 5：账号、云同步与网络工具

- [ ] `native/account-screen.tsx`：账号状态、登录、改密、退出、网络工具开关、云同步说明。
- [ ] `native/login-dialog.tsx`：用户名/密码，调用 `auth.login`，成功后自动切云端工作区。
- [ ] `native/change-password-dialog.tsx`：当前密码/新密码/确认。
- [ ] `mustChangePassword` 时提示改密，未改密前仍使用本地工作区。
- [ ] `network-tools-preference.ts` + `network-tools-state.tsx`：与 Web 相同的数据结构与回滚逻辑。
- [ ] 登录后 `workspaceScope` 切 `cloud:<userId>`，自动拉取 preferences/profile/conversations；退出回本地，本地数据保留。
- [ ] 首版不做手动同步按钮，也不做本地 → 云端自动导入（保留导入入口，`TextEncoder` 不兼容时隐藏）。
- [ ] 阶段门禁：`npx tsc --noEmit`、`npx expo lint`、`npx expo export --platform ios`、`npm run test:auth`、真机登录/同步/退出检查。

---

## 阶段 6：dev 脚本

### 6.1 package.json

```json
"dev": "node scripts/dev.mjs --web",
"dev:web": "node scripts/dev.mjs --web",
"dev:ios": "node scripts/dev.mjs --ios"
```

- [ ] `npm run dev` 与 `npm run dev:web` 等价。
- [ ] 保留现有 `web` / `ios`（纯 Expo）命令。

### 6.2 `scripts/dev.mjs`

**`--ios` 与 `--web` 走完全相同的后端启动流程，只是 Expo 子进程参数不同。** 执行 `npm run dev:ios` 时依次：

1. `uv sync --frozen --extra dev`
2. `alembic upgrade head` + `alembic check`
3. `app.bootstrap`（创建/同步开发管理员）
4. 启动 FastAPI uvicorn（`--reload`）
5. 等待 `/api/health/ready` 就绪
6. 启动 Expo，进入 iOS 目标（真机 Expo Go 扫码 / macOS 模拟器）

- [ ] `dev:ios` 不是“只跑 Expo”；迁移、健康检查、Ctrl+C 进程树清理与现有 `npm run dev` 一致。
- [ ] 新增参数解析：`--web`（默认）/ `--ios`，保留 `--check` / `--reset-db`；更新 `--help`。
- [ ] 新增 `devExpoArgs`：
  - web：`start --web --port <port>`
  - ios + darwin：`start --ios --port <port>`
  - ios + Windows/Linux/WSL：`start --lan`，输出 QR；`DEV_EXPO_HOST=tunnel` → `--tunnel`；`localhost` → `--localhost`。
- [ ] 新增 `DEV_API_HOST`（默认 `127.0.0.1`；`--ios` 默认 `0.0.0.0`），传给 `devApiArgs`；就绪探测在 `0.0.0.0`/`::` 时仍用回环地址。
- [ ] `MATRIUS_DEV_API_URL` 保持 `http://127.0.0.1:<port>`，不破坏 `scripts/dev-api-proxy.cjs`。
- [ ] `--ios` 时设置 `EXPO_PUBLIC_API_BASE_URL`：`.env.local` 显式配置优先；否则从 `os.networkInterfaces()` 选非回环 IPv4；启动日志打印实际地址和真机可达性提示。
- [ ] 复用 `supervise()`、SIGINT、Windows `taskkill`，不重写进程管理。
- [ ] `--check` 对两种目标校验后端工具、端口、路径与 API 地址，但不启动服务。

### 6.3 测试与文档

- [ ] `tests/dev.test.mjs` 增加：`devApiHost` 默认/覆盖、`devExpoArgs` 各分支、CLI 参数解析、探测地址归一化。
- [ ] 同步文档：`doc/development.md`、`README.md`、`AGENTS.md`、`.env.local.example`（`DEV_API_HOST`、`DEV_EXPO_HOST`、`EXPO_PUBLIC_API_BASE_URL`）。
- [ ] 门禁：`npm run test:dev`、`node scripts/dev.mjs --check`、`node scripts/dev.mjs --ios --check`。

---

## 阶段 7：完整验证

```bash
npm run test:dev
node scripts/dev.mjs --check
node scripts/dev.mjs --ios --check
npx tsc --noEmit
npx expo lint
npx expo export --platform web
npx expo export --platform ios
npx expo-doctor
npm run test:auth
npm run test:models
npm run test:rendering
```

### iPhone + Expo Go + `npm run dev:ios` 手动清单

- [ ] 登录/退出；本地 ↔ 云端工作区切换。
- [ ] 添加服务商/模型，发送消息，流式回复、停止、重试。
- [ ] 侧栏长按 → 置顶/重命名/删除；点击行正常进入会话。
- [ ] 对话区确认没有 jump-to-bottom、没有提问索引。
- [ ] 设置：列表 → 外观/个性化/模型/账号/关于，返回栈正常（Android 共用同一实现）。
- [ ] 附件：相册选图、发送、刷新后行为。
- [ ] 断网/401 的错误提示。

### 本机无法验证（交付时注明）

- [ ] iOS Simulator（需 macOS/Xcode）。
- [ ] 真机网络可达性。
- [ ] SecureStore / SQLite 的实际运行时行为。
- [ ] pi-ai 在 Hermes 上的流式兼容性。

Android 不单独实现、不单独验收：与 iOS 共用页面和交互，后续用 `npm run dev` 后端 + `npm run android` 直接验证。

---

## 风险与取舍

- **Markdown/KaTeX**：第一版轻量渲染，公式与语法高亮降级；若必须对齐 Web，需要 WebView/KaTeX 原生方案，范围明显扩大。
- **Hermes 兼容**：`Intl.Segmenter`、`DOMException`、`structuredClone`、`TextEncoder` 需守卫或回退；流式若与 `expo/fetch` 不兼容，则改为自定义 `StreamFn`。
- **WSL2 真机网络**：`0.0.0.0` 只暴露 WSL 虚拟网卡；需要 Windows 端口转发/镜像网络，或把后端跑在 Windows 侧。脚本打印提示，但不自动解决。
- **Expo Go 边界**：`@expo/ui`、`expo-glass-effect`、任何第三方原生模块都会踢出 Expo Go；第一版不使用。
- **pi-ai 原生打包失败**：阶段 1 立即 `expo export --platform ios`；失败则检查 exports / react-native 条件 / Node-only 导入，最后手段是原生仅保留 OpenAI-compatible 手写 fetch 流。
- **长按触发 onPress**：用时间戳抑制，真机重点验证。
- **Web 回归**：共享文件改动保持向后兼容，每阶段跑 `expo export --platform web` + 相关测试。

---

## 建议实施顺序

1. 依赖安装 + 基线。
2. 平台基础层（local-store、schema、auth-session、模型仓库、Hermes 守卫、Metro、`expo/fetch`）。
3. 立即 `expo export --platform ios` 止损。
4. 原生 Provider / 主题 / 导航壳。
5. 聊天 UI + 侧栏 + 长按菜单 + 搜索。
6. 设置单页栈 + 模型两级表单。
7. 账号 / 云同步 / 网络工具。
8. `dev:ios` 脚本与测试。
9. 真机验收。
