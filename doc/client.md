# Expo Web 客户端约定

[文档索引](README.md) · [UI 风格规范](ui-style.md)

本文描述新客户端的实现约束。当前实现入口见[客户端结构](client-structure.md)，未完成的业务设计按迁移目标阅读。

## 平台与路由

- Expo Web（React Native Web）+ TypeScript，只维护 Web 界面；移动 Web 响应式适配后续按单独要求进行。界面使用平台组件与 CSS，共享状态和业务契约不依赖 DOM。
- 统一使用 Expo Router，`src/app/` 只放路由页面与 `_layout.web.tsx`；组件、hooks 和工具放在目录外。
- Web 中 `Link asChild` 的锚点使用共享 `LinkAnchor`，保留 Router 注入的 `onClick`，过滤不能传入 DOM 的 `onPress`。
- 浏览器差异集中在适配层，不在业务页面散落平台 API 调用。业务契约与 Web 实现分离，便于后续替换底层传输或存储。
- Agent 业务集中在 `core/agent/`，共享消息类型、上下文、引用、系统提示、运行状态与取消；核心不依赖 React、DOM 或 `features/`。聊天 React 层负责状态与模型设置的适配，模型传输放在 `core/llm/`，凭据和持久化继续按平台接入。
- 当前只保证桌面浏览器；移动 Web 的窄屏布局、软键盘、安全区与触屏交互在后续阶段单独适配。长会话避免一次挂载全部消息，流式更新避免重绘整个列表。
- 实现 Expo 或 React Native Web API 前，先查 `package.json` 中 Expo 主版本，再读取对应版本文档；其他指南先从 [Expo 文档索引](https://docs.expo.dev/llms.txt) 定位。

## 主题

- 保留 shadcn/ui 的语义变量命名：`background`、`primary`、`sidebar-*`、`ring` 等。通过统一的主题 hooks / Provider 向组件提供颜色，不硬编码业务颜色。
- 支持浅色、深色、跟随系统，以及中文、英文界面。
- 默认 Twitter 配色，目标迁移旧版 10 套配色；主题只改变颜色，布局、字体、间距和圆角统一管理。
- tweakcn 预设的原始变量随代码保存，运行时不联网取主题。主题以 CSS 变量输出，业务代码不硬编码颜色。
- 配色解析在主题切换时集中处理并复用结果，避免每条流式消息重复解析。Web 在 `resolve-theme.ts` 统一抬升暗色表面与文字的最低明度，保留预设色相和原始数据；设置中的主题缩略图跟随当前明暗模式使用相同解析结果。
- 偏好统一接入本地仓储持久化，不先写只对 Web 生效的临时存储。

## 字体

目标随包提供 Inter、Noto Sans SC 和 JetBrains Mono，避免运行时依赖在线字体。当前已迁移字体资源，Web 通过 expo-font 加载本地字体。

- 旧版中文字体采用 GB2312 两级字表子集，迁移时保留完整字表并检查缺字；字体子集不等于覆盖全部 Unicode 汉字。
- 控制字体体积与字重数量；字体回退由统一 CSS 字体栈处理。

## 消息、代码块与选区

- Web 用户与助手消息共用 `react-markdown` 渲染；`remark-gfm` 提供表格、任务列表、脚注与删除线，`remark-math` + `rehype-katex` 处理公式。解析与渲染分层。
- `normalize-markdown.ts` 在代码范围外规范化 `\(…\)` / `\[…\]` 公式并保护货币美元符号，保留代码和未闭合围栏原文。KaTeX 的渲染器、CSS 和本地字体使用同一版本；CSS 和字体通过 postinstall 生成到 Web public 目录并按版本加载，不经 Metro 的 CSS 相对资源导入；不开启受信任 HTML 命令，不重写公式内部布局。
- 代码高亮使用 `highlight.js/lib/core` 和显式语言加载表，按需加载语言，不整包引入全部语言。未知语言、加载失败或超过 50000 字符的块回退纯文本；浅色/深色语法配色固定，不随主题主色旋转。
- 代码块默认展开，提供仅图标的复制与收起/展开操作，保留无障碍名称和状态反馈；复制经 Web 平台适配读取代码原文，失败显示反馈。工具栏不参与正文选区；折叠保留代码原文与复制能力。
- Markdown 不启用原始 HTML 解析，保留默认安全 URL 过滤。高亮 HTML 仅接受 highlight.js 从代码原文生成并转义的结果。
- `message-actions.web.tsx` 负责整条消息复制与赞/踩操作，评分通过 Chat State 更新对应助手消息的 `feedback` 并沿现有仓储保存。反馈在下一次模型请求时由共享 Agent 核心传给所选服务商，点击评分本身不触发请求；再次点击取消。分支动作创建独立会话和消息 ID，保留原文与反馈，原会话及草稿保留。
- 语法颜色保持清晰可辨，不随主题主色旋转；复制使用原始消息或代码文本，不读取带工具栏的展示内容。
- 行内代码保留在文本流中，复制内容不能丢失；代码标签、复制和折叠按钮不进入正文复制结果。
- Web 目标是同一回答跨段落连续选中；跨独立组件连续选区需要单独验证，不能直接套用旧版选区实现。
- 停止或出错时保留已生成文本与模型实际返回的推理/工具活动。供应商隐藏的思考内容不展示，也不重新注入上下文。

## 本地存储与安全存储

- Web 使用 IndexedDB 在浏览器中持久化会话与外观偏好。实现与边界见[存储与同步](data.md)，页面经数据层访问。
- 密钥不得进入普通业务存储、日志、崩溃上报或同步载荷。
- 浏览器没有系统级安全存储；`core/platform/model-credentials.ts` 只定义凭据接口与工作区独立的内存实现，正式工作区由 `features/models/model-credential-store.web.ts` 把密钥单独写入 IndexedDB 的 `model-credentials` 记录，刷新后仍可用；Mock 预览继续使用内存实现，不读写这份记录。
- 该记录**未加密**，同源脚本与能访问本机浏览器配置的人都能读取，界面上必须如实说明。密钥始终不进入 `model-preferences`、工作区记录、日志、崩溃上报或同步载荷；删除服务商会一并删除对应密钥，清除站点数据会删除全部密钥。
- 云端模式不接收服务端模型 key，也不直连服务器上的 SQLite 数据库或文件目录，只通过 `/api/*` 访问。

## 本地 Agent Runtime 与模型调用

两种模式共用客户端本地 Agent Runtime。未登录时只提供纯对话与记忆注入；登录后由同一 Runtime 调度云端工具并推进模型轮次。模型直连与云端单次模型代理通过传输适配接入，传输与协议分层：

```text
本地 Agent Runtime
  ↓
统一流式事件（文本 / 推理 / 工具调用事件 / 用量 / 结束）
  ↑
每协议一个解码器
  ↑
SSE 分帧（字节流 → 事件）
  ↑
浏览器传输适配（fetch + ReadableStream）
```

Runtime 消费工具调用事件，经云端工具 API 获取结果并回填上下文，然后发起下一次模型调用。未登录时不注册云端工具，不能执行这些工具。职责与运行状态见[Agent Runtime](agent.md)。

- 解码器不得依赖网络库，只消费分帧结果。覆盖 OpenAI Chat Completions、OpenAI Responses、Anthropic Messages，允许自定义 base URL。
- 分帧处理多行 `data:`、`[DONE]`、CRLF、注释、跨块 UTF-8 字符和缺失尾换行。
- 传输适配覆盖增量读取、取消、错误和结束。
- Web 端模型请求统一经本站同源的 `/api/model-proxy` 转发，避免服务商 CORS 预检差异；中继无状态，不保存密钥或对话。

## 依赖与构建

- 保留 Expo Router，不引入第二套路由。优先复用现有依赖；新增第三方状态管理、网络或代码生成库前先与维护者确认。
- 依赖通过 `npx expo install <package>` 安装；当前使用 npm，未来如切换 Bun 并存在 `bun.lock`，统一使用 `bunx`。
- 项目只构建 Web（`app.json` 中 `platforms: ["web"]`），不包含 `ios/`、`android/` 工程或 EAS 配置。
- 生产构建执行 `npm run export:web`：导出静态 SPA 后由 `scripts/inject-pwa.mjs` 注入 manifest 与触摸图标元数据；`public/sw.js` 提供应用外壳离线缓存。
