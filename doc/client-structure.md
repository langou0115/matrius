# 客户端结构与修改入口

[文档索引](README.md) · [UI 风格规范](ui-style.md) · [迁移记录](migration.md)

当前优先实现 Web 端，使用 Expo Router 的平台文件解析。`.web.tsx` 承载浏览器界面，普通路由文件提供原生说明页；共享状态与配色不依赖 DOM。

## 当前结构

```text
src/
├── app/
│   ├── _layout.web.tsx                 Web Provider、应用框架与路由插槽
│   ├── _layout.tsx                     原生路由插槽
│   ├── index.web.tsx                   聊天路由
│   ├── c/[conversationId].web.tsx      已有对话的独立 URL
│   ├── mock/                          开发预览路由（索引页与各项测试）
│   ├── settings.web.tsx                设置路由
│   ├── index.tsx                       移动端待适配说明页
│   └── settings.tsx                    原生设置说明页
├── components/web/
│   ├── link-anchor.tsx                 Expo Router 链接的 DOM 属性适配
│   ├── app-frame.tsx                   配色变量、系统明暗模式
│   ├── demo-toolbar.tsx                开发示例的重置、退出入口
│   ├── local-workspace.tsx             浏览器数据加载、保存队列与错误反馈
│   ├── workspace.tsx                   侧栏布局、搜索入口与 Ctrl/Cmd+K
│   ├── dialog.tsx                      原生 HTML dialog、焦点恢复与 Esc
│   ├── select-field.web.tsx            跟随主题的单选下拉框
│   └── icon.tsx                        统一线框 SVG 图标
├── features/
│   ├── chat/
│   │   ├── chat-state.tsx              会话状态、选择与管理动作
│   │   ├── draft-state.tsx             独立草稿状态，跨设置导航保留
│   │   ├── message-text.ts            用户消息与引用的完整复制文本
│   │   ├── chat-runtime.tsx           聊天状态/模型设置与共享 Agent 核心之间的 React 适配，含标题请求调度
│   │   ├── chat-screen.web.tsx         欢迎页、消息区、按会话保存的输入草稿
│   │   ├── chat-route.web.tsx          URL 选择对话与不存在提示
│   │   ├── conversation-href.ts        正式与 Mock 对话地址
│   │   ├── conversation-route-state.ts  URL 对话选择与有效性状态
│   │   ├── markdown/                   公式/货币规范化与高亮语言按需加载
│   │   └── components/
│   │       ├── sidebar.web.tsx         侧栏、会话管理与设置入口
│   │       ├── conversation-title.web.tsx  顶栏标题单击重命名
│   │       ├── conversation-select.web.tsx  长标题悬停/焦点滚动与动效偏好
│   │       ├── conversation-menu.web.tsx  三点按钮旁的三项操作卡片
│   │       ├── message-actions.web.tsx  消息复制、赞/踩与创建分支入口
│   │       ├── message-content.web.tsx  用户与助手 Markdown/GFM、KaTeX 渲染
│   │       ├── reasoning-block.web.tsx  等待与思考共用的状态行及折叠正文
│   │       ├── reply-status.web.tsx     停止/失败提示及末条失败回复的重试操作
│   │       ├── code-block.web.tsx       代码高亮、复制与折叠
│   │       ├── model-icon.web.tsx      theSVG 彩色模型品牌与通用 SVG 标记
│   │       ├── composer.web.tsx        输入法、Enter/Shift+Enter、模型提示
│   │       ├── chat-notice.web.tsx     聊天区顶部的非模态错误提示卡片
│   │       ├── background-notifications.web.tsx  后台完成回复的临时卡片与跳转
│   │       ├── selection-quote.web.tsx 助手正文选区与浮动引用操作
│   │       ├── quote-card.web.tsx      草稿与已发送引用预览、移除和全文弹窗
│   │       ├── conversation-navigator.web.tsx 提问目录、阅读位置与消息定位
│   │       ├── attachment-list.web.tsx  附件卡片、文件类型图标与全屏图片预览
│   │       ├── file-type-icon.web.tsx   后缀匹配与本地 Material 专用文件图标
│   │       ├── scroll-to-bottom.web.tsx  跟随滚动与回到最新消息按钮
│   │       └── search-dialog.web.tsx   标题与正文搜索、结果片段
│   ├── workspace/workspace-repository.web.ts  工作区存储结构校验
│   ├── settings/settings-screen.web.tsx  独立全页设置
│   └── mock/
│       ├── mock-items.ts               预览项清单与按路径反查
│       └── mock-index-screen.web.tsx   独立全页预览索引
├── core/agent/
│   ├── runtime.ts                     跨端运行入口、状态订阅、回复批处理与取消
│   ├── runner.ts                      pi-agent 实例、流式事件与超时
│   ├── context.ts                     引用、图片与历史上下文组装、请求校验
│   ├── types.ts                       共享消息、用户资料和运行状态契约
│   ├── system-prompt.ts               用户资料与自定义指令的系统提示
│   ├── title.ts                       独立会话标题请求、超时与标题规范化
│   └── thinking-effort.ts             共享思考强度
├── core/llm/direct-stream.ts           三协议流式传输
├── core/platform/clipboard.web.ts      Web 原文复制适配
├── core/database/browser-store.web.ts  IndexedDB 事务、版本与冲突检查
├── theme/
│   ├── appearance.tsx                  共享外观状态，默认 Twitter / 跟随系统
│   ├── presets.ts                      旧版 tweakcn 原始配色变量
│   └── resolve-theme.ts                暗色表面与前景明度适配，保留原始预设
└── global.css                         Web 样式、字体、布局、焦点与选区
```

- 路径别名 `@/` 指向 `src/`；本地字体在 `assets/fonts/`，通过根布局的 expo-font 加载。
- 模板 Explore、标签导航、启动动画组件和 reset-project 脚本已移除。
- `dev/fixtures/chat-workspace.ts` 为显式开发预览数据，通过独立 `/mock/chat` 开发路径加载，包含 100 个批量多轮对话和 9 个专项会话。预览项清单集中在 `features/mock/mock-items.ts`，`/mock` 是列出各项的独立全页索引，新增测试只需加一个路由文件与一条清单记录。聊天预览保留设置入口，通过 `/mock/chat/settings` 复用正式设置组件，并共享本次预览状态；`src/app/mock/_layout.tsx` 用 `__DEV__` 统一保护所有子路由，生产模式跳回首页。预览索引、工具栏与样例数据仅在开发分支动态加载。正常模式不注入、不保存示例数据。
- `/mock/process` 通过 `features/mock/process-preview.web.tsx` 复用思考折叠区、正文和中断提示；阶段切换保留展开状态及连续计时，包含等待、思考、搜索、读取、再次思考、回答和结束，可验证按发生顺序追加步骤及整轮完成状态。模拟数据位于 `dev/fixtures/process-preview.ts`，不调用模型或写入聊天记录。
- Web 会话与外观通过 IndexedDB 持久化，挂载 Provider 前先恢复数据。新建空白对话不创建历史记录，首次发送时创建；配置模型后通过本地 Runtime 生成真实回复。
- 新建对话首条消息发送后，`chat-runtime.tsx` 在回复之外并行调用 `core/agent/title.ts` 生成标题；`titleModelId` 已配置时使用该模型，否则跟随会话绑定的模型。生成失败保留首条消息截断标题，并在后续回复成功后重试；`titleSource` 防止迟到的结果覆盖手动重命名或分支标题。每个会话最多一个进行中的标题请求，删除会话或卸载工作区时取消。
- 发送、置顶、重命名和删除会写回浏览器数据库；读取或保存失败有提示。当前会话、侧栏和外观状态也会恢复，草稿仅在本次页面会话中保留。
- `/settings` 在根布局中使用独立全页，不包在聊天 Workspace 内；Provider 保持挂载，返回时会话与草稿不丢失。
- `/` 为新对话，`/c/<conversation-id>` 为已创建对话；首次发送成功后替换为空白页对应的新地址，侧栏、搜索和分支切换通过 Router 写入历史，浏览器前进后退按 URL 选择对话。设置返回当前对话地址；无效 ID 使用弹窗提示并提供返回新对话操作。Mock 使用 `/mock/chat/c/<conversation-id>`，仍受开发守卫保护。URL 在本地仓储加载后解析，不依赖上次保存的 activeId。

## 后续入口

| 功能 | 目标位置 |
| --- | --- |
| 手机本地数据库、实体仓储与后续迁移 | `src/core/database/` |
| 本地 Agent Runtime、上下文与云端工具调度 | `src/core/agent/` |
| 模型直连 / 代理传输、SSE、解码器 | `src/core/llm/` |
| 安全存储、文件、剪贴板等平台适配 | `src/core/platform/` |
| 云端模式 REST 客户端、认证、409 冲突与错误映射 | `src/core/api/` |
| 更多消息格式与原生富文本适配 | 聊天模块内的消息渲染组件 |
| 记忆、文件、认证、管理员 | `src/features/<module>/` |
| 原生界面 | 保持共享状态与契约，后续增加 React Native 页面与组件 |

其中模型直连与本地 Runtime 已有最小实现，其余目录随功能创建。

## 职责边界

- `src/app/` 仅放路由页面和布局，具体界面和业务状态在目录外。
- Web 的 DOM、CSS、浏览器事件只进入 Web 路由及其组件依赖；不要在共享状态模块调用浏览器 API。
- 输入草稿保存在独立的 Draft Context，避免每次键入更新侧栏，同时在切换设置后保留草稿。
- 数据源接入后统一经过仓储，不在页面里自行选择本地或云端数据源。

## 消息渲染资源与回归

- `scripts/sync-katex.mjs` 从已安装的 KaTeX 生成同版本 CSS、WOFF2 字体与许可证到 `public/vendor/katex/<版本>/`，由根布局加载，不依赖 CDN；资源由 postinstall 生成并忽略，不手工编辑。
- `tests/message-content.test.mjs` 通过 Node/LinkeDOM 验证 Markdown、公式、代码边界、安全链接、高亮、折叠和复制；TypeScript 测试加载器只服务于测试，不进入客户端。

## 设置模块

- `/settings` 是可搜索的设置目录；`/settings/appearance` 合并显示模式和配色主题，`/settings/models` 管理模型服务，`/settings/about` 展示应用信息；旧 display/theme 路径跳到外观页。Chat Mock 使用 `/mock/chat/settings` 下的同名子路径，继承开发守卫。
- `features/settings/settings-catalog.ts` 集中管理目录、搜索词与显示模式选项；`settings-screen.web.tsx` 渲染目录，`settings-detail-screen.web.tsx` 复用原有设置控件，`settings-page.web.tsx` 管理共用页面框架与返回入口。
- 设置子页均不卸载根工作区 Provider，导航期间保留会话、草稿与外观状态。
- `/settings/personalization` 与 `/mock/chat/settings/personalization` 提供自定义指令和关于你的表单，入口与搜索集中在 `settings-catalog.ts`。`personalization.ts` 定义字段、默认值与校验，`personalization-state.tsx` 保存共享状态，`personalization-screen.web.tsx` 实现 Web 表单；根工作区通过已有仓储恢复和自动保存，Runtime 在每次请求开始时组装系统提示。记忆入口尚未提供。

## 模型与 Runtime 入口

- `features/models/model-settings-screen.web.tsx`：Provider 折叠卡片、当前模型选择，以及获取模型列表、编辑 Provider、编辑模型、删除确认四类对话框；`model-state.tsx`：工作区独立状态和按 Provider 隔离的凭据；`model-repository.web.ts`：无密钥元数据读写及旧配置迁移；`model-credential-store.web.ts`：密钥的独立 IndexedDB 记录，Mock 不读写。
- `core/llm/model-config.ts`：Provider 配置校验与运行时模型映射；`core/llm/direct-stream.ts`：三协议流式传输；`core/llm/provider-catalog.web.ts`：从 Provider 获取模型目录；`core/platform/model-credentials.ts`：凭据接口与内存实现。
- `core/agent/runtime.ts`：无 React/DOM 依赖的共享运行入口，按会话持有一组活动请求（`runs`）、批量回复和运行状态；同一会话不可重复启动，不同会话可并发，`stop(id)` 只取消对应会话。`runner.ts`：实际创建 pi-agent；`context.ts`：上下文与引用；`types.ts`：跨端消息契约。核心不导入功能模块。
- `features/chat/chat-runtime.tsx`：薄 React 适配层，提供模型/凭据与偏好，把核心回复分发到聊天状态，挂在根工作区中，不随设置导航卸载。后台完成时维护临时通知列表；聊天屏挂载/卸载同步 `chatVisible`，让设置页期间的完成也保持未读。未来原生页面复用同一 Agent 核心，凭据、存储和流式传输环境单独适配。

- 侧栏采用品牌、平面主导航、可折叠的置顶/最近列表与底部本地用户行；搜索按钮保留在侧栏顶部。设置保持独立整页，各级页面保留上一页与 Home 图标，不增加分类侧栏或横向分类导航。流式回复通过临时 `reasoningActive` 区分思考与正文生成，该字段不写入持久化白名单。非当前会话在侧栏显示运行中 spinner（`runs[id]`）或完成未读 check（`completedReadAt === null`）；后台完成卡片挂载在根布局 `AppFrame` 内，因此设置页也可见并继承主题变量。

## 账号与功能开关

- `core/api/auth-session.ts`：无 DOM / React 的会话状态、同源 API 请求与过期处理；拒绝迟到请求覆盖新账号。
- `core/platform/auth-session.web.ts`：当前标签页 token 存储适配，不持久化账号权限。
- `core/features/capabilities.ts`：统一判断服务端授予的功能。
- `features/auth/auth-state.web.tsx`：Web Provider、useAuth、useFeature 与 FeatureGate。
- `features/auth/account-screen.web.tsx`：设置账号页、登录、改密与退出；根工作区按认证状态切换数据源。
- `features/admin/admin-screen.web.tsx`：`/admin` 管理页，管理员独立登录后按用户名创建用户，展示一次初始密码。
- `features/settings/labs-screen.web.tsx`：受控实验页，路由和数据调用均需权限。
- `settings-catalog.ts` / `settings-page.web.tsx`：分类与搜索按功能能力统一过滤。
- `src/app/settings/account.*`、`labs.*`：Web 路由组装；原生仍使用待适配说明页。

## 开发与发布脚本

- `scripts/dev.mjs`：跨平台本机开发启动器，管理本地 SQLite、uv/FastAPI 和 Expo 进程及退出清理，不连接服务器。
- `server/scripts/dev-api.py`：Windows 开发 API 热重载适配，复用 Uvicorn 监听器并定向重启工作进程，避免控制台 Ctrl+C 传播至 npm/Expo；仅监听应用代码。
- `scripts/dev-api-proxy.cjs`：Metro 同源 `/api/*` 转发，模型中继优先处理。
- `scripts/deploy.mjs`：单次上传源码和生产镜像发布；服务端协议、初始化及健康检查位于 `scripts/remote/`。
- `Dockerfile.web`、`server/Dockerfile`：生产 Web/API 镜像，直接包含代码；Compose 不挂载源码。

- `features/workspace/workspace-mode.ts`：按认证状态决定本地、账号云端或等待验证的工作区身份。
- `features/workspace/cloud-workspace-repository.ts`：账号作用域的内存 REST 仓储，加载服务端数据并按 revision 保存变化；不访问 IndexedDB，不包含模型配置或凭据。
- `components/web/local-workspace.tsx`：按工作区身份重建聊天、草稿与 Runtime；本地保存队列写 IndexedDB，云端保存队列写 REST，ModelProvider 始终位于切换边界之外。旧 AccountSyncProvider 不再挂载。
