# 客户端结构与修改入口

移动端以 767px 为断点：聊天使用顶栏、独立滚动消息区、底部输入框；不显示消息导航和上下文窗口入口。侧栏使用原生模态 dialog 覆盖页面，支持遮罩关闭、Esc 与焦点恢复。设置根路由在移动端显示分类列表，详情路由全屏显示并提供返回设置入口；桌面保留双栏。`components/web/use-mobile.ts` 统一订阅断点。应用外壳处理安全区和 Visual Viewport 高度，适配软键盘。

[文档索引](README.md) · [UI 风格规范](ui-style.md) · [迁移记录](migration.md)

资料库在移动端通过顶栏右上角「…」菜单中的「选择」进入多选模式，所有文件行以 220ms 动画向右让出 36px，在卡片外侧显示独立勾选按钮，点选可增减选择。进入选择模式后顶栏右上角的「…」变为「×」，点击后清空选择、退出模式并恢复行位置；底部浮动操作条仅显示已选数量、下载和删除。未选文件时保留选择模式，底部下载和删除禁用；更改筛选、排序或切换移动端断点会退出模式。移动端不显示逐行「…」按钮，长按文件 500ms 打开该文件的下载、重命名、删除菜单，菜单自动避让视口边缘，支持点击外部、滚动及 Esc 关闭。文件类型与排序放在同一行，不显示全选框；桌面保留全选与逐行选择逻辑及每行操作按钮。

移动端资料库的搜索与筛选栏放在文件滚动容器外，使用不透明背景固定在说明文字下方；只有文件列表滚动，隐藏滚动条但保留手势滚动与分页加载，避免吸顶晃动以及文件从工具栏缝隙透出。桌面保留滚动区内的吸顶工具栏。

当前只实现 Web 端：React 19 + TypeScript，Vite 8 构建，React Router 7 路由。入口是根目录 `index.html` 与 `src/main.tsx`；页面、组件与导航都不再区分平台后缀。共享状态与配色不依赖 DOM。

## 路由与文件命名

- 所有前端文件使用普通 `X.tsx` / `X.ts` 后缀，不再有 `.web.tsx` / `.web.ts`、`.native.*` 或 fallback 兄弟文件；项目只维护 Web + PWA 目标。
- 路由由 `src/router/routes.tsx` 中的显式 `<Routes>` 定义，是唯一路由表。页面模块放在哪个目录不会自动成为路由。
- 除聊天路由外，页面都用 `React.lazy` 按需加载；`/mock/*` 统一包在 `MockOnly` 中，生产构建直接 `<Navigate to="/" replace />`；未知 URL 也重定向到 `/`。
- 导航 API 只从 `@/router` 导入：`Link`（支持 `asChild`）、`router.push/replace/back`、`Redirect`、`usePathname`、`useLocalSearchParams` 和 `Href` 类型。功能代码不要直接导入 `react-router-dom`；测试通过 `tests/stubs/router.mjs` 替换该模块。
- 新增页面时在 `src/router/routes.tsx` 注册路径，再把页面组件放进对应的 `features/` 模块；如需开发预览，在 `/mock/*` 路由中复用该组件，并往 `features/mock/mock-items.ts` 增加一条清单记录。

## 当前结构

```text
index.html                              Vite 入口 HTML、#root、PWA/Apple 元数据
src/
├── main.tsx                            createRoot + BrowserRouter + RouterNavigationBridge + AppRoutes
├── router/
│   ├── index.tsx                       Link、router.push/replace/back、Redirect、usePathname、useLocalSearchParams、RouterNavigationBridge、Href
│   └── routes.tsx                      唯一路由表，React.lazy、MockOnly 与未知路径重定向
├── components/web/
│   ├── app-shell.tsx                   主题/实例/工作区/通知 Provider、整页与聊天布局、Service Worker 注册
│   ├── app-frame.tsx                   配色变量、系统明暗模式与开发预览工具栏
│   ├── app-error-boundary.tsx          渲染错误兜底与重新加载入口
│   ├── link-anchor.tsx                 Link asChild 使用的原生锚点
│   ├── brand-mark.tsx                  彩色帆船标志，复用 public/brand/matrius-sailboat.png
│   ├── demo-toolbar.tsx                开发示例的重置、退出入口
│   ├── dialog.tsx                      原生 HTML dialog、焦点恢复与 Esc
│   ├── instance-workspace.tsx             实例数据加载、REST 保存队列与错误反馈
│   ├── select-field.tsx                跟随主题的单选下拉框
│   ├── storage-error-toast.tsx         保存失败提示、可选文字与重试
│   ├── workspace.tsx                   侧栏布局、搜索入口与 Ctrl/Cmd+K
│   └── icon.tsx                        统一线框 SVG 图标
├── features/
│   ├── chat/
│   │   ├── chat-state.tsx              会话状态、选择与管理动作
│   │   ├── draft-state.tsx             独立草稿状态，跨设置导航保留
│   │   ├── display-preferences.ts      思考块展示与默认展开的设备级开关
│   │   ├── message-text.ts            用户消息与引用的完整复制文本
│   │   ├── chat-runtime.tsx            聊天状态/模型设置与共享 Agent 核心之间的 React 适配，含标题请求调度
│   │   ├── context-usage.ts            上下文窗口优先使用运行中最近单次请求用量，拆分为未缓存输入、缓存输入和输出；无记录时估算正文、摘要和完整工具定义
│   │   ├── chat-screen.tsx             欢迎页、消息区、按会话保存的输入草稿
│   │   ├── chat-route.tsx              URL 选择对话与不存在提示
│   │   ├── conversation-href.ts        正式与 Mock 对话地址
│   │   ├── document-title.ts           会话页使用对话名作为标签标题，其余页面回退 Matrius
│   │   ├── conversation-route-state.ts URL 对话选择与有效性状态
│   │   ├── conversation-search.ts      搜索匹配、命中片段、高亮分段与相对时间
│   │   ├── last-conversation.ts        本机记住的最近对话与地址
│   │   ├── location-pathname.ts        监听 history 变化，把地址栏作为页面事实源
│   │   ├── message-order.ts            重新加载后还原 steering 消息顺序
│   │   ├── scroll-position.ts          按会话记住滚动位置，防抖写入 localStorage
│   │   ├── markdown/                   公式/货币规范化与高亮语言按需加载
│   │   └── components/
│   │       ├── sidebar.tsx             侧栏、会话管理与设置入口
│   │       ├── conversation-title.tsx  顶栏标题单击重命名
│   │       ├── conversation-select.tsx 长标题悬停/焦点滚动与动效偏好
│   │       ├── conversation-menu.tsx   三点按钮旁的三项操作卡片
│   │       ├── message-actions.tsx     消息复制、赞/踩与创建分支入口
│   │       ├── message-content.tsx     用户与助手 Markdown/GFM、KaTeX 渲染
│   │       ├── collapsible-message-content.tsx 长用户消息按渲染高度折叠
│   │       ├── reasoning-block.tsx     等待与思考共用的状态行及折叠正文
│   │       ├── research-group.tsx      搜索/读取分组合并、行状态与来源去重
│   │       ├── research-panel.tsx      来源结果侧栏与窄屏底部弹层
│   │       ├── reply-status.tsx        停止/失败提示及末条失败回复的重试操作
│   │       ├── code-block.tsx          代码高亮、复制与折叠
│   │       ├── model-icon.tsx          theSVG 彩色模型品牌与通用 SVG 标记
│   │       ├── composer.tsx            输入法、Enter/Shift+Enter、模型提示
│   │       ├── context-meter.tsx       已有对话输入框下方的上下文入口与容量分段弹层
│   │       ├── chat-notice.tsx         聊天区顶部的非模态错误提示卡片
│   │       ├── background-notifications.tsx 后台完成回复的临时卡片与跳转
│   │       ├── selection-quote.tsx     助手正文选区与浮动引用操作
│   │       ├── quote-card.tsx          草稿与已发送引用预览、移除和全文弹窗
│   │       ├── conversation-navigator.tsx 提问目录、阅读位置与消息定位
│   │       ├── attachment-list.tsx     附件卡片、文件类型图标与全屏图片预览
│   │       ├── message-attachments.tsx 已发送消息的附件与图片展示、折叠
│   │       ├── generated-files.tsx     回复生成文件的下载列表与折叠
│   │       ├── file-type-icon.tsx      后缀匹配与本地 Material 专用文件图标
│   │       ├── scroll-to-bottom.tsx    跟随滚动与回到最新消息按钮
│   │       └── search-dialog.tsx       标题与正文搜索、命中高亮、键盘选择、滚动分页与结果片段
│   ├── files/
│   │   ├── files-api.ts                上传、列表、用量、重命名、批量删除与内容地址
│   │   ├── use-file-library.ts         搜索防抖、筛选排序、游标分页、刷新时保留旧列表与多选状态
│   │   ├── library-screen.tsx          资料库页面、门禁与空/错误状态
│   │   ├── library-toolbar.tsx         搜索、筛选与排序
│   │   ├── library-item.tsx            文件行、多选、重命名与下载
│   │   ├── mock-library.ts             预览用 500 个文件与内存版 `/api/files`
│   │   ├── storage-screen.tsx          存储设置页：已用空间、进度条与分类入口
│   │   └── types.ts                    文件与列表响应契约
│   ├── usage/
│   │   ├── usage-api.ts                用量读取、历史估算触发与每轮回复的 token 上报
│   │   ├── usage-stats.ts              本地日期、热力图/周/累计序列与格式化
│   │   ├── token-usage-section.tsx     统计卡、输入输出占比、估算标注与三种趋势图
│   │   └── usage-screen.tsx            用量设置页、实例能力状态
│   ├── workspace/
│   │   ├── cloud-workspace-repository.ts 唯一实例的内存 REST 仓储与 revision 保存
│   │   ├── preview-context.ts          共享的 Mock 预览标记
│   │   ├── workspace-mode.ts           按实例连接状态加载工作区或等待重连
│   │   └── workspace-repository.ts     工作区存储结构校验
│   ├── settings/
│   │   ├── appearance-redirect.tsx     旧主题/显示路径跳转到外观页
│   │   ├── personalization.ts          个性化字段、默认值与校验
│   │   ├── personalization-screen.tsx  Web 个性化表单
│   │   ├── personalization-state.tsx   个性化共享状态与保存
│   │   ├── settings-catalog.ts         目录、搜索词与显示模式选项
│   │   ├── settings-detail-screen.tsx  外观、关于等设置详情
│   │   ├── settings-page.tsx           设置目录、搜索、分类导航与共用页面框架
│   │   ├── settings-return.ts          记住进入设置前的会话/资料库页并生成返回入口
│   │   └── settings-root-redirect.tsx  `/settings` 跳转到默认分类
│   ├── memory/
│   │   ├── memory-state.tsx            记忆开关、摘要与更新状态
│   │   ├── memory-model.ts             记忆助手模型的跟随/指定解析
│   │   └── memory-dialog.tsx           摘要查看、对话式修改与清空确认
│   ├── models/
│   │   ├── model-credential-store.ts   API key 的独立 IndexedDB 记录
│   │   ├── model-repository.ts         无密钥元数据读写与旧配置迁移
│   │   ├── model-settings-screen.tsx   Provider 与模型管理界面
│   │   └── model-state.tsx             工作区独立模型状态与按 Provider 隔离的凭据
│   ├── instance/
│   │   ├── instance-retry.ts               实例校验失败后的退避重试
│   │   ├── instance-state.tsx              Provider、useInstance、useFeature 与 FeatureGate
│   │   ├── change-password-dialog.tsx  首次改密与主动改密
│   │   ├── network-tools-preference.ts 保存在实例画像字段的网络工具开关
│   │   ├── network-tools-state.tsx     网络工具开关状态
│   └── mock/
│       ├── mock-items.ts               预览项清单与按路径反查
│       ├── mock-index-screen.tsx       独立全页预览索引
│       ├── process-preview.tsx         思考/工具/中断状态预览
│       └── storage-preview.tsx         保存失败提示预览
├── core/
│   ├── agent/
│   │   ├── activity-payload.ts         精简工具活动同步字段
│   │   ├── compaction.ts               上下文压缩、预算与滚动摘要
│   │   ├── context.ts                  引用、图片、附件与历史上下文组装、请求校验
│   │   ├── diagnostics.ts              模型回复诊断摘要与有界历史
│   │   ├── file-tools.ts               通用 file 工具、草稿、删除与生成文件收集
│   │   ├── history.ts                  过滤失败占位消息
│   │   ├── memory.ts                   记忆摘要契约、记忆工具与后台整理
│   │   ├── runner.ts                   pi-agent 实例、流式事件与超时
│   │   ├── runtime.ts                  跨端运行入口、状态订阅、回复批处理与取消
│   │   ├── system-prompt.ts            用户资料与自定义指令的系统提示
│   │   ├── thinking-budget.ts          思考预算与最小正文输出换算
│   │   ├── thinking-effort.ts          共享思考强度
│   │   ├── title.ts                    独立会话标题请求、超时与标题规范化
│   │   ├── types.ts                    共享消息、用户资料和运行状态契约
│   │   └── web-tools.ts                web_search / web_fetch 工具定义与活动记录
│   ├── api/instance-client.ts             实例能力状态与同源 API 请求
│   ├── database/browser-store.ts       IndexedDB 事务、版本与冲突检查
│   ├── features/capabilities.ts        按服务端授权判断功能
│   ├── llm/
│   │   ├── direct-stream.ts            三协议流式传输
│   │   ├── model-config.ts             Provider 配置校验与运行时模型映射
│   │   ├── model-proxy.ts              同源模型中继地址与请求头
│   │   ├── pi-agent-bridge.ts          pi-ai 浏览器兼容导出
│   │   ├── pi-browser-credentials.ts   浏览器环境不下发环境密钥
│   │   └── provider-catalog.ts         从 Provider 获取模型目录
│   └── platform/
│       ├── auth-session.ts             实例能力初始化
│       ├── clipboard.ts                Web 原文复制适配
│       ├── model-credentials.ts        凭据接口与内存实现
│       └── run-protection.ts           生成期间的 beforeunload 离开确认
├── theme/
│   ├── appearance.tsx                  共享外观状态，默认 Twitter / 跟随系统
│   ├── presets.ts                      旧版 tweakcn 原始配色变量
│   └── resolve-theme.ts                暗色表面与前景明度适配，保留原始预设
└── global.css                          @font-face、样式、布局、焦点与选区
```

- 路径别名 `@/` 指向 `src/`，`@/assets/` 指向 `assets/`。字体在 `assets/fonts/`，由 `src/global.css` 顶部的 `@font-face` 引用 `../assets/fonts/*.ttf`，Vite 负责哈希并输出到构建产物。品牌标志文件是 `public/brand/matrius-sailboat.png`，favicon 使用透明底彩色 PNG（`public/favicon.png`，由 `assets/images/favicon.png` 复制，不再提供 `/favicon.ico`），PWA/Apple 图标使用同一帆船图案（`public/icons/`）；Apple 图标使用深蓝底，可遮罩图标使用深蓝底并保留安全边距。
- 模板 Explore、标签导航、启动动画组件和 reset-project 脚本已移除。
- `dev/fixtures/chat-workspace.ts` 为显式开发预览数据，通过独立 `/mock/chat` 开发路径加载，包含 100 个批量多轮对话和 9 个专项会话。预览项清单集中在 `features/mock/mock-items.ts`，`/mock` 是列出各项的独立全页索引，新增测试只需在 `src/router/routes.tsx` 注册一个 `/mock/*` 路由并往清单加一条记录。聊天预览保留设置入口，通过 `/mock/chat/settings` 复用正式设置组件，并共享本次预览状态；所有 `/mock/*` 路由由 `routes.tsx` 的 `MockOnly` 统一保护，生产构建直接跳回首页。预览索引、工具栏与样例数据仅在开发分支动态加载。正常模式不注入、不保存示例数据。
- `/mock/process` 通过 `features/mock/process-preview.tsx` 复用思考折叠区、正文和中断提示；阶段切换保留展开状态及连续计时，包含等待、思考、搜索、读取、再次思考、回答和结束，可验证按发生顺序追加步骤及整轮完成状态。模拟数据位于 `dev/fixtures/process-preview.ts`，不调用模型或写入聊天记录。
- `/mock/library` 直接复用 `features/files/library-screen.tsx`，由 `features/files/mock-library.ts` 提供 500 个内存文件（含 SVG 缩略图）与 `/api/files` 的列表、用量、重命名、删除实现；预览模式下 `enabled` 恒为真、不请求真实接口，侧栏“资料库”入口也指向该路由。`/mock/storage` 复用 `components/web/storage-error-toast.tsx` 预览各种保存失败提示。
- Web 会话与外观通过实例 REST 持久化，挂载 Provider 前先恢复数据。新建空白对话不创建历史记录，首次发送时创建；配置模型后通过本地 Runtime 生成真实回复。
- 新建对话首条消息发送后，`chat-runtime.tsx` 在回复之外并行调用 `core/agent/title.ts` 生成标题；`titleModelId` 已配置时使用该模型，否则跟随会话绑定的模型。生成失败保留首条消息截断标题，并在后续回复成功后重试；`titleSource` 防止迟到的结果覆盖手动重命名或分支标题。每个会话最多一个进行中的标题请求，删除会话或卸载工作区时取消。
- 发送、置顶、重命名和删除会写回浏览器数据库；读取或保存失败有提示。当前会话、侧栏和外观状态也会恢复，草稿仅在本次页面会话中保留。
- `/settings` 在根布局中使用独立全页，不包在聊天 Workspace 内；Provider 保持挂载，返回时会话与草稿不丢失。
- `/` 为新对话，`/c/<conversation-id>` 为已创建对话；首次发送成功后替换为空白页对应的新地址，侧栏、搜索和分支切换通过 Router 写入历史，浏览器前进后退按 URL 选择对话。设置返回当前对话地址；无效 ID 使用弹窗提示并提供返回新对话操作。Mock 使用 `/mock/chat/c/<conversation-id>`，仍受开发守卫保护。URL 在实例仓储加载后解析，不依赖上次保存的 activeId；未知路径重定向到 `/`。

## 后续入口

| 功能 | 目标位置 |
| --- | --- |
| 本地数据库、实体仓储与后续迁移 | `src/core/database/` |
| 本地 Agent Runtime、上下文与云端工具调度 | `src/core/agent/` |
| 模型直连 / 代理传输、SSE、解码器 | `src/core/llm/` |
| 安全存储、文件、剪贴板等平台适配 | `src/core/platform/` |
| 实例 REST 客户端、连接状态、409 冲突与错误映射 | `src/core/api/` |
| 更多消息格式适配 | 聊天模块内的消息渲染组件 |
| 记忆、文件、实例访问 | `src/features/<module>/` |
| 移动 Web 响应式布局 | 保持共享状态与契约，后续按窄屏、软键盘与安全区适配 |

其中模型直连与本地 Runtime 已有最小实现，其余目录随功能创建。

## 职责边界

- `src/router/routes.tsx` 只负责路径到页面组件的映射与 Mock 守卫，具体界面和业务状态在 `features/`。
- `src/router/index.tsx` 是导航 API 的唯一入口；功能代码只从这里取 `Link`、`router` 和 hooks，不直接依赖 React Router 的类型。
- Web 的 DOM、CSS、浏览器事件只进入 Web 组件及其依赖；不要在共享状态模块调用浏览器 API。
- 输入草稿保存在独立的 Draft Context，避免每次键入更新侧栏，同时在切换设置后保留草稿。
- 数据源接入后统一经过仓储，不在页面里自行选择本地或云端数据源。

## 消息渲染资源与回归

- `scripts/sync-katex.mjs` 从已安装的 KaTeX 生成同版本 CSS、WOFF2 字体与许可证到 `public/vendor/katex/<版本>/`，由 `vite.config.ts` 在 `index.html` 注入样式链接，不依赖 CDN；资源由 postinstall 生成并忽略，不手工编辑。
- `tests/message-content.test.mjs` 通过 Node/LinkeDOM 验证 Markdown、公式、代码边界、安全链接、高亮、折叠和复制；`tests/typescript-loader.mjs` 把 `@/router` 解析为 `tests/stubs/router.mjs`，并把 `import.meta.env.DEV` 改写为 `globalThis.__DEV__ === true`，组件测试不加载 React Router，默认按生产模式运行。TypeScript 测试加载器只服务于测试，不进入客户端。

## 设置模块

- `/settings` 是可搜索的设置目录，根路径跳转到 `/settings/appearance`；`/settings/appearance` 合并显示模式和配色主题，`/settings/models` 管理模型服务，`/settings/usage` 展示 Token 用量，`/settings/about` 展示应用信息；旧 `/settings/theme`、`/settings/display` 路径由 `appearance-redirect.tsx` 跳到外观页。Chat Mock 使用 `/mock/chat/settings` 下的同名子路径，继承开发守卫；实例、存储与用量是云端整页路由，不进入 Mock 分类。所有路径都在 `src/router/routes.tsx` 注册。
- `features/settings/settings-catalog.ts` 集中管理目录、搜索词与显示模式选项；`settings-page.tsx` 渲染目录、搜索与分类导航，并管理共用页面框架与返回入口；`settings-detail-screen.tsx` 提供外观与关于等详情控件。`settings-return.ts` 记录进入设置前的页面：从会话进入返回该会话，从资料库进入返回资料库；只有直接打开设置且没有来源时才回退到当前会话或新对话。
- 标签页标题由 `features/chat/document-title.ts` 决定：`/c/<id>`（含 Mock）使用对话名，空标题和其他页面使用 Matrius。
- 设置子页均不卸载根工作区 Provider，导航期间保留会话、草稿与外观状态。
- `/settings/personalization` 与 `/mock/chat/settings/personalization` 提供记忆、自定义指令和关于你的表单，入口与搜索集中在 `settings-catalog.ts`。`personalization.ts` 定义字段、默认值与校验，`personalization-state.tsx` 保存共享状态，`personalization-screen.tsx` 实现 Web 表单；根工作区通过已有仓储恢复和自动保存，Runtime 在每次请求开始时组装系统提示。
- 个性化页的记忆区位于“关于你”和“其他设置”之间，包含记忆助手模型、启用开关与摘要管理。`core/agent/memory.ts` 定义摘要契约、记忆工具、后台整理请求与系统提示注入；`memory-state.tsx` 保存开关和摘要；`memory-dialog.tsx` 用输入指令调用 `memory` 工具直接改摘要，不显示助手回复；标题旁显示更新时间与图标删除按钮，删除需二次确认。摘要非空且启用时进入每次对话的系统提示；回复完成后由记忆助手模型在后台整理，按会话每分钟最多一次，失败静默。记忆助手模型保存在本机 `model-preferences.memoryModelId`，为空时跟随会话模型。

## 模型与 Runtime 入口

- `features/models/model-settings-screen.tsx`：Provider 折叠卡片、当前模型选择，以及获取模型列表、编辑 Provider、编辑模型三类对话框；删除 Provider 或模型直接执行，不弹确认框。`model-state.tsx`：工作区独立状态和按 Provider 隔离的凭据；`model-repository.ts`：无密钥元数据读写及旧配置迁移；`model-credential-store.ts`：密钥的独立 IndexedDB 记录，Mock 不读写。
- `core/llm/model-config.ts`：Provider 配置校验与运行时模型映射；`core/llm/direct-stream.ts`：三协议流式传输；`core/llm/provider-catalog.ts`：从 Provider 获取模型目录；`core/platform/model-credentials.ts`：凭据接口与内存实现；`core/llm/model-proxy.ts`：同源模型中继地址。
- `core/agent/runtime.ts`：无 React/DOM 依赖的共享运行入口，按会话持有一组活动请求（`runs`）、批量回复和运行状态；同一会话不可重复启动，不同会话可并发，`stop(id)` 只取消对应会话。`runner.ts`：实际创建 pi-agent；`context.ts`：上下文与引用；`types.ts`：跨端消息契约。核心不导入功能模块。
- `features/chat/chat-runtime.tsx`：薄 React 适配层，提供模型/凭据与偏好，把核心回复分发到聊天状态，挂在根工作区中，不随设置导航卸载。后台完成时维护临时通知列表；聊天屏挂载/卸载同步 `chatVisible`，让设置页期间的完成也保持未读。凭据、存储和流式传输环境分别经适配层接入。每轮回复结束后把 `onUsage` 汇总的 token 上报到实例。

- 侧栏采用品牌、平面主导航、可折叠的置顶/最近列表与底部实例所有者入口；搜索按钮保留在侧栏顶部。设置保持独立整页，各级页面保留上一页与 Home 图标，不增加分类侧栏或横向分类导航。流式回复通过临时 `reasoningActive` 区分思考与正文生成，该字段不写入持久化白名单。非当前会话在侧栏显示运行中 spinner（`runs[id]`）或完成未读圆点（`completedReadAt === null`）；后台完成卡片挂载在根布局 `AppFrame` 内，因此设置页也可见并继承主题变量。`updatedAt` 决定「最近」排序，只在追加消息或回复正文生成完成时覆盖；后续思考与正文增量不会让会话反复跳到顶部，因此并发生成的会话不会在侧栏来回抢位。

## 实例与功能开关

- `core/api/instance-client.ts`：无 DOM / React 的实例能力状态与同源 API 请求；忽略过期的能力刷新请求。
- `core/agent/diagnostics.ts`：模型回复诊断摘要，记录每次调用的输出上限、HTTP 元数据、结束原因与用量；通过 `matriusDiagnostics.export()` 导出有界内存记录，不保存正文、工具参数或凭据。
- `core/features/capabilities.ts`：统一判断服务端授予的功能。
- `features/instance/instance-state.tsx`：Web Provider、useInstance、useFeature 与 FeatureGate。
- `features/files/storage-screen.tsx`：设置中的“存储”分类（位于实例下方），展示已用/总量、进度条，并按文件与图像分类跳转到资料库。
- `features/usage/usage-screen.tsx`：设置中的“用量”分类（位于存储下方），仅实例具备 `usage` 功能时可见；`token-usage-section.tsx` 展示今日/近 7 天/近 30 天、输入输出占比，以及截至今天向前回溯六个月的日热力图和包含本周的最近六周柱状图，支持点击日格或周柱查看精确 token 数；`usage-api.ts` 读取统计并在每轮回复后上报 token。
- `settings-catalog.ts` / `settings-page.tsx`：分类与搜索按功能能力统一过滤。
- `src/router/routes.tsx` 中的 `/settings/storage`、`/settings/usage`：存储与用量设置路由组装；存储与用量仅在实例具备对应功能时出现在导航中。

## 开发与发布脚本

- `scripts/dev.mjs`：跨平台本机开发启动器，管理本地 SQLite、uv/FastAPI 和 Vite 进程及退出清理，不连接服务器。
- `server/scripts/dev-api.py`：Windows 开发 API 热重载适配，复用 Uvicorn 监听器并定向重启工作进程，避免控制台 Ctrl+C 传播至 npm/Vite；仅监听应用代码。
- `scripts/dev-api-proxy.cjs`：Vite 开发服务器的同源 `/api/*` 转发，模型中继优先处理。
- `vite.config.ts`：Vite 开发与构建配置；设置 `DEV_WEB_PORT`（默认 8081，严格端口）、`@/` 与 `@/assets/` 别名、pi-ai 映射、KaTeX 样式注入，以及 `/api/*` 与模型中继中间件。
- `scripts/deploy.mjs`：单次上传源码和生产镜像发布；服务端协议、初始化及健康检查位于 `scripts/remote/`。
- `Dockerfile.web`、`server/Dockerfile`：生产 Web/API 镜像，直接包含代码；Compose 不挂载源码。

- `features/workspace/workspace-mode.ts`：按实例连接状态加载工作区或等待重连的工作区身份。
- `features/workspace/cloud-workspace-repository.ts`：唯一实例的内存 REST 仓储，加载服务端数据并按 revision 保存变化；不访问 IndexedDB，不包含模型配置或凭据。
- `components/web/instance-workspace.tsx`：生产只加载后端工作区并用 REST 保存；连接不可用时等待重连。开发预览使用内存，不加载正式业务数据。

上下文占用与计费用量分开：运行期间按会话和模型保存最近一次调用的输入（含缓存读取/写入）与输出，不累加各轮调用；面板把输入拆成未缓存输入和缓存输入，并与输出一起展示。新调用开始时从实际请求内容估算，服务商返回用量后更新。运行时数据仅在内存中；刷新后按当前工具定义、保留正文与滚动摘要估算，不从当天累计用量反推。历史思考与工具结果只在实际请求携带时计入，不把展示用的完整过程重复加到下一轮历史。
