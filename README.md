# Matrius

轻量、多用户、可自行部署的 AI 对话应用。当前工程由 `../matrius-old` 迁移，客户端改用 **React Native + Expo + TypeScript**，目标支持 Android、iOS 和 Web，当前先完成 Web 界面。

## 当前状态

当前优先开发 Web 端，已替换 Expo 示例页面和标签导航，完成聊天界面、侧栏、新建/搜索/置顶/重命名/删除对话，以及外观设置。旧版 10 套配色和本地字体已迁移。Web 消息已支持 Markdown/GFM、KaTeX 公式、多语言代码高亮，以及代码块复制和折叠。消息下方提供原文复制、赞/踩交互及创建分支对话。移动端暂留说明页，后续单独适配。

Web 对话、消息、置顶状态与外观设置保存在当前浏览器的 IndexedDB 中，刷新后恢复；未发送草稿仍只保留在当前页面会话中。设置页为独立全页，返回后保留会话和草稿。发送消息可以验证界面交互，但模型服务和 Agent Runtime 尚未接入，不会产生模拟 AI 回复。App 手机本地存储、个人记忆、认证与同步尚未实现；后端技术栈待定。

产品文档仍包含待实现的目标设计；已完成与后续步骤见[迁移记录](doc/migration.md)。

## 产品目标

| 能力 | 本地模式（未登录） | 云端模式（已登录） |
| --- | --- | --- |
| Agent Runtime | 客户端本地运行 | 客户端本地运行，调度云端工具 |
| 模型调用 | 用户自带 API key，客户端直连 | 本地 Runtime 发起请求，服务端单次代理并保管 key |
| 对话、流式回复、个人记忆 | 支持 | 支持 |
| 数据 | 仅本机 | 云端为事实源，本地保留离线缓存 |
| 资料库、文件上传与读取、联网搜索 | 入口整体隐藏 | 支持 |
| 多用户管理、跨设备同步 | 入口整体隐藏 | 支持 |

首次打开无需登录。登录后本地对话和记忆合并上传，保留本地副本；登出保留缓存。完整边界见[产品与开发顺序](doc/product.md)。

## 技术栈

| 部分 | 当前选型 |
| --- | --- |
| 客户端 | Expo SDK 57、React Native 0.86、React 19、TypeScript |
| 路由 | Expo Router，路由位于 `src/app/` |
| 本地存储 | Web 使用浏览器 IndexedDB；App 后续接手机本地数据库 |
| 主题与字体 | Web 已迁移 10 套配色与 Inter / Noto Sans SC / JetBrains Mono |
| 后端 | 待定 |
| 云端基础设施 | PostgreSQL、Redis、OpenSERP、RustFS；尚未接入 |

依赖的精确版本以 [package.json](package.json) 和锁文件为准。

Web 的 Expo Router 链接通过共享 `LinkAnchor` 适配原生锚点，组件入口见[客户端结构](doc/client-structure.md)。

## 快速开始

准备与 [Expo SDK 57](https://docs.expo.dev/versions/v57.0.0/) 匹配的 Node.js 环境及 npm，当前仓库使用 `package-lock.json`。

```bash
npm ci  # 自动准备本地 KaTeX CSS 和字体
npx expo start
```

通过终端提示选择 Android、iOS 或 Web；也可以使用：

```bash
npm run android
npm run ios
npm run web
```

`npm run web` 打开当前 Web 界面。开发时访问 `/mock` 会直接进入 `/mock/chat`：包含 100 个八轮对话及 Markdown、公式、代码、50 轮长会话等 9 个专项样例，共 109 个会话、1730 条消息，仅用于聊天回复渲染测试，不提供 Mock 设置页。无需测试账号，示例变更不写入真实记录，release 模式不开放预览。Android / iOS 当前仅为后续适配的说明页。Android 模拟器需要 Android SDK；本机 iOS 模拟器需要 macOS 与 Xcode，Windows/WSL 可用支持当前 SDK 的真机客户端调试，或通过 EAS 构建开发客户端。Expo Go 仅支持其内置的原生模块。

```bash
npx expo lint
npx tsc --noEmit
npm run test:rendering
npx expo install <package>
```

构建、开发客户端和完整环境说明见[开发与验证](doc/development.md)。

## 文档

从 [doc/ 文档索引](doc/README.md) 开始阅读。[客户端结构](doc/client-structure.md) 区分当前实现与后续目录；[AGENTS.md](AGENTS.md) 保留协作约束。

开发顺序是先完成本地模式，再接入后端、认证、工具与同步。

## 许可

仓库现有许可见 [LICENSE](LICENSE)；该文件保留 Expo 模板的版权声明。
