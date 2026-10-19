# Matrius

轻量、多用户、可自行部署的 AI 对话应用。当前工程由 `../matrius-old` 迁移，客户端改用 **React Native + Expo + TypeScript**，目标支持 Android、iOS 和 Web，当前先完成 Web 界面。

## 当前状态

当前优先开发 Web 端，已替换 Expo 示例页面和标签导航，完成聊天界面、侧栏、新建/搜索/置顶/重命名/删除对话，以及外观设置。旧版 10 套配色和本地字体已迁移。Web 消息已支持 Markdown/GFM、KaTeX 公式、多语言代码高亮，以及代码块复制和折叠。消息下方提供原文复制、赞/踩交互及创建分支对话。移动端暂留说明页，后续单独适配。

Web 对话、消息、置顶状态、每个会话的 Thinking Effort 和最近选择，以及外观设置保存在当前浏览器的 IndexedDB 中，刷新后恢复；新会话沿用最近选择的强度，未发送草稿仍只保留在当前页面会话中。设置页为独立全页，返回后保留会话和草稿。Web 已接入本地 pi-agent-core Runtime，可按 Provider 分组选择模型并进行多轮流式对话，支持每会话默认/低/中/高思考强度、停止和错误重试，不生成模拟 AI 回复。App 手机本地存储、个人记忆、认证与同步尚未实现；后端技术栈待定。

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

新对话使用 `/`，已创建的对话使用 `/c/<conversation-id>`；侧栏、搜索、分支与设置返回均保留对应地址，刷新后按 URL 恢复对话。本地模式链接只定位当前浏览器的数据，不会公开或上传对话。聊天错误通过对话区顶部的横向小卡片提示，与输入区同宽，不显示遮罩、不打断输入；回形针入口始终可添加附件，发送时统一校验，目前仅可向支持图片的模型发送图片。附件卡片显示文件类型、名称与大小，以分割线隔开输入区；悬停可查看完整文件名，图片支持点击全屏预览。

Web 使用单页输出（`web.output: single`），部署时将页面请求回退至 `index.html`，保留静态资源的正常路径，以支持动态对话链接直接访问和刷新。

选中助手回复正文后可点击「引用」，在输入框中带上选中片段继续提问；引用可预览、移除，发送后随消息保存，并在重新生成和分支中保留。累计 4 次提问后显示对话导航：宽屏悬停右侧短线展开提问目录，窄屏点击顶栏导航按钮，点击条目跳转对应提问；跳转会暂停生成时的自动跟随，可点击回到最新消息恢复。

Agent 共享核心独立位于 [`src/core/agent/`](src/core/agent/)：`runtime.ts` 提供启动、取消和状态订阅，`runner.ts` 接入 pi-agent，`context.ts` 组装引用、图片与历史消息。核心不依赖 React 或浏览器；聊天界面通过 `features/chat/chat-runtime.tsx` 适配。Web 已接入，移动端复用核心，页面、存储及传输环境后续适配。接口与边界见 [Agent 文档](doc/agent.md)。

助手回复的赞/踩会随消息保存，并在后续提问或重新生成时通过 pi-agent 传给所选模型；再次点击可取消。单独评分不发起模型请求。

附件的 Word、Excel、PowerPoint、PDF、Markdown 等专用图标使用本地 Material Icon Theme SVG；来源版本与许可证见 [文件图标资源](public/vendor/file-icons/README.md)。

设置 → 个性化支持自定义指令、称呼、职业与更多个人信息，自动保存在当前浏览器，对所有模型的后续发送和重新生成生效。填写内容会随请求发送给当前模型服务商；Mock 仅保留在预览内存中。记忆功能尚未实现。

新对话发送首条消息后会由 AI 生成简短标题，与回复并行请求，不占用回复运行状态。可在设置 → 个性化选择标题生成模型；默认跟随当前对话使用的模型。生成失败或缺少 key 时先保留消息开头的临时标题，并在之后回复成功时重试；手动重命名不会被覆盖。

## 快速开始

准备与 [Expo SDK 57](https://docs.expo.dev/versions/v57.0.0/) 匹配的 Node.js 环境及 npm，当前仓库使用 `package-lock.json`。

```bash
npm ci  # 自动准备 KaTeX CSS 与字体
npx expo start
```

通过终端提示选择 Android、iOS 或 Web；也可以使用：

```bash
npm run android
npm run ios
npm run web
```

`npm run web` 打开当前 Web 界面。开发时访问 `/mock` 会看到预览索引页，可进入 `/mock/chat`：包含 100 个八轮对话及 Markdown、公式、代码、50 轮长会话等 9 个专项样例，共 109 个会话、1730 条消息，复用完整聊天界面，保留设置入口，并增加右下角 Mock 工具卡片。无需测试账号，示例变更不写入真实记录，release 模式由 `/mock` 目录统一守卫，访问预览地址会跳回首页。Web 发布使用 `npx expo export --platform web` 的生产产物；不要把 Metro 开发服务用于发布。生产环境可运行 `npm run export:web && npm run serve`，由内置 Node 服务同时提供静态页面和同源模型中继（默认 `0.0.0.0:8081`，可用 `PORT`、`HOST` 覆盖）。Android / iOS 当前仅为后续适配的说明页。Android 模拟器需要 Android SDK；本机 iOS 模拟器需要 macOS 与 Xcode，Windows/WSL 可用支持当前 SDK 的真机客户端调试，或通过 EAS 构建开发客户端。Expo Go 仅支持其内置的原生模块。

```bash
npx expo lint
npx tsc --noEmit
npm run test:rendering
npx expo install <package>
```

侧栏使用平面主导航（新对话），搜索按钮位于顶部与可折叠的「置顶 / 最近」分组；输入框在模型名前显示 theSVG 彩色品牌图标（展开与收起共用），未选模型时隐藏思考强度；设置页保持独立整页，通过描边的左箭头返回上一页、Home 图标直达主界面。模型选择保持在圆形发送按钮左侧，整体靠右。思考动画在思考结束时停止，正文继续生成。

Linux 若启动时报 DevTools 缺少 `libatk-1.0.so.0`，属于桌面调试器系统依赖问题，Ubuntu 22.04 的修复命令见[开发与验证](doc/development.md#linux-启动时-devtools-缺少共享库)。

构建、开发客户端和完整环境说明见[开发与验证](doc/development.md)。

## 文档

从 [doc/ 文档索引](doc/README.md) 开始阅读。[客户端结构](doc/client-structure.md) 区分当前实现与后续目录；[AGENTS.md](AGENTS.md) 保留协作约束。

开发顺序是先完成本地模式，再接入后端、认证、工具与同步。

## 许可

仓库现有许可见 [LICENSE](LICENSE)；该文件保留 Expo 模板的版权声明。

设置采用可搜索的项目目录：从侧栏进入后，可搜索外观、模型服务或应用信息，再进入对应子页调整；显示模式与配色主题放在同一个外观页。正式页面与 Chat Mock 共用这套设置流程。

模型接入：打开设置 → 模型服务，先添加服务商（名称、协议、Base URL、API key），再自动获取并添加模型，或手动填写模型 ID。支持 OpenAI Chat Completions、OpenAI Responses、Anthropic Messages 和相应兼容服务；本地无鉴权接口可取消“接口需要 API key”。API key 与模型元数据分表保存在本机浏览器（密钥未加密），刷新后仍可用，删除服务商会一并删除密钥。模型请求和目录获取均经本站同源的 `/api/model-proxy` 转发，不受服务商 CORS 预检影响，内容只发送给该服务商；本地/内网地址及原生端仍直连。`npm run web` 的开发服务和 `npm run serve` 的生产服务均已内置该中继；无法获取目录时仍可手动添加模型。

`npm run test:models` 验证协议流、取消、错误、密钥隔离及 IndexedDB v1→v2 迁移；`npm run test:rendering` 验证消息渲染。

Web 字体在大屏（≥1024px）使用更大的整数尺寸；侧栏「置顶 / 最近」使用清晰的半粗标题，展开箭头紧邻文字，不显示分组数量。
