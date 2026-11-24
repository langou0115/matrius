# 客户端结构与修改入口

移动端以 767px 为断点：聊天使用顶栏、独立滚动消息区、底部输入框；不显示消息导航和上下文窗口入口。侧栏使用原生模态 dialog 覆盖页面，支持遮罩关闭、Esc 与焦点恢复。设置根路由在移动端显示分类列表，详情路由全屏显示并提供返回设置入口；桌面保留双栏。`components/web/use-mobile.ts` 统一订阅断点。应用外壳处理安全区和 Visual Viewport 高度，适配软键盘。

[文档索引](README.md) · [UI 风格规范](ui-style.md) · [迁移记录](migration.md)

资料库在移动端通过顶栏右上角「…」菜单中的「选择」进入多选模式，所有文件行以 220ms 动画向右让出 36px，在卡片外侧显示独立勾选按钮，点选可增减选择。进入选择模式后顶栏右上角的「…」变为「×」，点击后清空选择、退出模式并恢复行位置；底部浮动操作条仅显示已选数量、下载和删除。未选文件时保留选择模式，底部下载和删除禁用；更改筛选、排序或切换移动端断点会退出模式。移动端不显示逐行「…」按钮，长按文件 500ms 打开该文件的下载、重命名、删除菜单，菜单自动避让视口边缘，支持点击外部、滚动及 Esc 关闭。文件类型与排序放在同一行，不显示全选框；桌面保留全选与逐行选择逻辑及每行操作按钮。

移动端资料库的搜索与筛选栏放在文件滚动容器外，使用不透明背景固定在页面标题下方；只有文件列表滚动，隐藏滚动条但保留手势滚动与分页加载，避免吸顶晃动以及文件从工具栏缝隙透出。桌面保留滚动区内的吸顶工具栏。

当前只实现 Web 端：React 19 + TypeScript，Vite 8 构建，React Router 7 路由。入口是根目录 `index.html` 与 `ui/main.tsx`；页面、组件与导航都不再区分平台后缀。共享状态与配色不依赖 DOM。

桌面工作区顶栏的 Git 按钮打开当前项目的独立 Git 标签。左侧源代码管理栏支持拖拽调宽、列表/树状视图切换、暂存/取消暂存/放弃更改、分支切换、远程同步（Fetch/Pull/Push）以及提交已选或已暂存文件；右侧默认展示带分支轨道与筛选的提交图，点击提交在底部分栏展示提交详情与文件列表，选中工作区或提交文件时右侧显示带 Shiki 语法高亮与行内词级差异的并排/行内差异视图。

桌面工作区支持从项目文件树打开文件标签。同一个项目内重复打开同一路径会聚焦原标签，标签在本次页面加载期间保留。普通代码与文本文件使用等宽字体、行号与主题语法高亮（本机、WSL 与 SSH 项目文件均支持直接编辑与快捷键/自动保存，项目外本机文件以只读预览）；Markdown（`.md`/`.markdown`）默认以渲染视图打开，并通过顶栏按钮在「预览 / 编辑源码」之间切换；Word（`.docx`）通过 SuperDoc 原生渲染并支持项目内编辑保存（`.doc` 只读预览），Excel（`.xlsx`）通过 Univer Sheets 原生渲染并支持项目内编辑保存（`.xls` 只读预览），PowerPoint（`.pptx`/`.ppt`）通过 `pptx-preview` 只读预览，PDF（`.pdf`）内嵌只读查看。桌面端「设置 → 工作 → 编辑器」可设置字号、默认差异视图和自动保存。

桌面工作区的终端、CLI 会话、文件和 Git 标签共用右键菜单。关闭其他和全部关闭仅作用于当前项目，并保留固定标签。关闭含未保存修改的文件前会请求确认。文件和 Git 的固定状态与自定义标签名在当前工作区会话内有效。重命名文件标签只更改标签显示名称。

## 路由与文件命名

- 所有前端文件使用普通 `X.tsx` / `X.ts` 后缀，不再有 `.web.tsx` / `.web.ts`、`.native.*` 或 fallback 兄弟文件；项目只维护 Web + PWA 目标。
- 路由由 `ui/router/routes.tsx` 中的显式 `<Routes>` 定义，是唯一路由表。页面模块放在哪个目录不会自动成为路由。
- 除聊天路由外，页面都用 `React.lazy` 按需加载；`/debug` 与 `/mock/*` 统一包在 `DevOnly` 中，生产构建直接 `<Navigate to="/" replace />`；未知 URL 也重定向到 `/`。
- 导航 API 只从 `@/router` 导入：`Link`（支持 `asChild`）、`router.push/replace/back`、`Redirect`、`usePathname`、`useLocalSearchParams` 和 `Href` 类型。功能代码不要直接导入 `react-router-dom`；测试通过 `tests/stubs/router.mjs` 替换该模块。
- 新增页面时在 `ui/router/routes.tsx` 注册路径，再把页面组件放进对应的 `features/` 模块；如需开发预览，在 `/mock/*` 路由中复用该组件，并往 `features/mock/mock-items.ts` 增加一条清单记录。

## 当前结构

```text
index.html                              Vite 入口 HTML、#root、PWA/Apple 元数据
ui/
├── main.tsx                            createRoot + BrowserRouter + RouterNavigationBridge + AppRoutes
├── router/
│   ├── index.tsx                       Link、router.push/replace/back、Redirect、usePathname、useLocalSearchParams、RouterNavigationBridge、Href
│   └── routes.tsx                      唯一路由表，React.lazy、DevOnly 与未知路径重定向
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
│   │   ├── context-usage.ts            上下文窗口使用最近一次服务商报告的请求用量，拆分为未缓存输入、缓存输入和输出；新调用开始时保留上次读数，无报告时估算正文、摘要、记忆和完整工具定义
│   │   ├── chat-screen.tsx             欢迎页、消息区、按会话保存的输入草稿
│   │   ├── chat-route.tsx              URL 选择对话与不存在提示
│   │   ├── conversation-href.ts        正式与 Mock 对话地址
│   │   ├── document-title.ts           会话页使用对话名作为标签标题，其余页面回退 Matrius
│   │   ├── conversation-route-state.ts URL 对话选择与有效性状态
│   │   ├── conversation-search.ts      搜索匹配、命中片段、高亮分段与相对时间
│   │   ├── last-conversation.ts        本机记住的最近对话与地址
│   │   ├── sidebar-mode.ts             记住桌面端侧栏选中的「工作 / 对话」标签，进入设置再返回时保持原栏
│   │   ├── location-pathname.ts        监听 history 变化，把地址栏作为页面事实源
│   │   ├── message-order.ts            重新加载后还原 steering 消息顺序
│   │   ├── scroll-position.ts          按会话记住滚动位置，防抖写入 localStorage
│   │   ├── markdown/                   公式/货币与裸 LaTeX 规范化（渲染前重写，不改代码块）
│   │   ├── citations.ts                脚注来源解析、引用链接重写与已引用来源汇总
│   │   └── components/
│   │       ├── sidebar.tsx             侧栏、会话管理与设置入口
│   │       ├── conversation-title.tsx  顶栏标题单击重命名
│   │       ├── conversation-select.tsx 长标题悬停/焦点滚动与动效偏好
│   │       ├── conversation-menu.tsx   三点按钮旁的三项操作卡片
│   │       ├── message-actions.tsx     消息复制、赞/踩与创建分支入口
│   │       ├── source-badge.tsx        回复反馈栏上方的「N 个网页」来源入口
│   │       ├── citation-marker.tsx     正文上角标、来源悬浮卡片与直达链接
│   │       ├── source-card.tsx         来源站点图标与可复用来源卡片
│   │       ├── sources-panel.tsx       已引用来源侧栏，序号与正文上角标一致
│   │       ├── side-panel.tsx          来源列与窄屏底部弹层共用的面板外壳
│   │       ├── message-content.tsx     用户与助手 Markdown/GFM、KaTeX、代码高亮、Mermaid 与引用改写（Streamdown）
│   │       ├── collapsible-message-content.tsx 长用户消息按渲染高度折叠
│   │       ├── reasoning-block.tsx     等待与思考共用的状态行及折叠正文
│   │       ├── research-group.tsx      搜索/读取分组合并、行状态与来源去重
│   │       ├── research-panel.tsx      单次搜索/读取批次的来源侧栏与窄屏底部弹层
│   │       ├── reply-status.tsx        停止/失败提示及末条失败回复的重试操作
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
│   │       └── search-dialog.tsx       初始仅展示搜索框，输入后匹配标题与正文并支持高亮、键盘选择、滚动分页与结果片段
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
│   │   ├── activity-payload.ts         上传前精简工具活动与思考过程字段
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
│   │   ├── models-api.ts               `/api/models` 服务端模型与密钥状态读写接口
│   │   ├── model-credential-store.ts   旧版浏览器 IndexedDB 密钥辅助（仅历史兼容测试）
│   │   ├── model-repository.ts         旧版无密钥元数据辅助（仅历史兼容测试）
│   │   ├── model-settings-screen.tsx   Provider 与模型管理界面
│   │   └── model-state.tsx             工作区模型状态（正常模式走服务端，Mock 走内存）
│   ├── hosts/
│   │   ├── hosts-api.ts                `/api/hosts` 桌面端 SSH / WSL 主机读写与探活接口
│   │   └── host-settings-screen.tsx    设置页「工作 → 主机」管理界面（仅桌面端可用）
│   ├── work/
│   │   ├── work-api.ts                 `/api/projects`、`/api/projects/:id/cli-sessions`、`/api/hosts/:id/fs`、`/api/hosts/:id/unlock` 与 `/api/work/terminals` 桌面端项目、CLI 会话、目录与终端接口
│   │   ├── work-href.ts                桌面端工作区与项目路由地址（`/work`、`/p/<project-id>` 及 `/mock/chat/*` 预览路径）
│   │   ├── work-route.tsx              桌面端项目 URL 解析、未找到项目提示与空工作区重定向
│   │   ├── work-state.ts               共享桌面端「工作」状态（项目及排序、展开状态与分组 CLI 对话/组序/状态检测、按项目隔离且支持拖拽排序的终端标签、平台默认终端、右侧目录栏开关与拖拽宽度）
│   │   ├── work-shell-preference.ts    `/api/work/settings` 读写桌面端默认 Windows 终端、项目激活与列表/分组/终端标签排序（独立 `work_settings` 表）
│   │   ├── terminal-preset-icon.tsx    `@thesvg/react` 终端/CLI 品牌图标（PowerShell、Claude Code、Codex 与裁剪版 Antigravity）
│   │   ├── work-general-screen.tsx     设置页「工作 → 常规」界面（Windows 默认终端选择、终端历史输出快照开关，仅桌面端可用）
│   │   ├── work-sidebar-panel.tsx      桌面端侧栏「工作」面板（「创建项目」入口、可拖拽排序的项目列表与右键靠右设置菜单、按 Codex/Antigravity/Claude Code 分组且支持拖拽组序与右侧 `+` 新建单一对话的 CLI 对话区、组内「显示更多 / 收起」，仅桌面端懒加载）
│   │   ├── work-workspace.tsx          桌面端「工作」右侧容器（按项目切换且支持拖拽排序含固定标签在内的终端标签顶栏、右上角分体式 `+ | ▾` 新建系统终端与种类菜单、右侧工作目录栏折叠开关与终端画布区）
│   │   ├── work-terminal-view.tsx      基于 `@xterm/xterm` 的主题自适应 WebSocket PTY 终端画布（支持右键复制/粘贴操作卡片、Ctrl+C 复制/中断与 Ctrl+V 粘贴、IME 组合预览与光标跟随、输出批处理防花屏与滚动恢复，以及重启恢复快照、末次目录与 SSH/WSL 重连解锁）
│   │   ├── work-terminal-connection.ts  终端 WebSocket 握手超时、退避重连与同会话重新挂接。自动重试耗尽后可手动重试，断线期间的键盘输入不缓存。
│   │   ├── work-files-panel.tsx        右侧工作目录可调宽、可展开文件树边栏（支持 SSH 密码内联解锁）
│   │   ├── work-file-preview.tsx       工作目录文本预览与本机代码编辑（Shiki 语法高亮）
│   │   ├── work-file-save.ts           本机文件版本校验与自动保存
│   │   ├── work-syntax.tsx             工作区文件预览与 Git 差异共用的 Shiki 语法高亮辅助
│   │   ├── work-git-view.tsx           VS Code 风格桌面端 Git 源代码管理栏、分栏提交详情与差异工作区
│   │   ├── work-git-branch-select.tsx  共用的主题化分支选择下拉框（切换分支 / 按分支筛选提交图）
│   │   ├── work-git-graph.tsx          带泳道轨道、Ref 标签与筛选的 VS Code 风格 Git 提交图
│   │   ├── work-git-diff.tsx           支持并排/行内、语法高亮与词级行内差异的 Git Diff 编辑器
│   │   ├── work-git-model.ts           提交图泳道布局、Patch 解析、词级差异与树状目录构建纯逻辑
│   │   ├── create-project-dialog.tsx   「创建项目 / 项目设置」弹窗（创建时可选主机、目录与「AI 配置」中按工具分组、默认收起且记忆展开状态的网络代理及启动参数；创建后「项目设置」锁定名称、主机与目录，仅允许修改「AI 配置」）
│   │   ├── directory-browser-dialog.tsx 「选择项目目录」文件与目录浏览器弹窗（支持本机盘符及根目录 / WSL / SSH）
│   │   └── work-error-dialog.tsx     工作区创建项目、添加终端与目录浏览共用的错误提示弹窗
│   ├── instance/
│   │   ├── auth-unlock-screen.tsx      `AUTH_SECRET` 开屏密钥解锁界面
│   │   ├── instance-retry.ts           实例校验失败后的退避重试
│   │   ├── instance-state.tsx          Provider、useInstance、useFeature 与 FeatureGate
│   │   ├── network-tools-preference.ts 保存在实例画像字段的网络工具开关
│   │   └── network-tools-state.tsx     网络工具开关状态
│   ├── tasks/
│   │   ├── tasks-screen.tsx            定时任务管理界面与状态切换
│   │   ├── tasks-state.tsx             任务列表状态与轮询更新
│   │   ├── tasks-api.ts                `/api/tasks` REST 客户端
│   │   ├── task-modal.tsx              创建与编辑定时任务弹窗
│   │   └── mock-tasks.ts               `/mock/tasks` 预览用内存任务
│   ├── debug/
│   │   ├── debug-screen.tsx            开发调试页（Mock 预览与工具测试栏目）
│   │   └── tools-panel.tsx             Search / Fetch 等工具连通性测试面板
│   └── mock/
│       ├── mock-items.ts               预览项清单与按路径反查
│       ├── intelligent-ui-preview.tsx  交互式 UI 块预览
│       ├── process-preview.tsx         思考/工具/中断状态预览
│       └── storage-preview.tsx         保存失败提示预览
├── core/
│   ├── api/
│   │   ├── agent-aux.ts                标题与记忆摘要请求
│   │   ├── agent-runs.ts               提交 Agent 运行、消费 SSE、停止/steer
│   │   ├── debug-tools.ts              开发调试工具测试请求（Search / Fetch）
│   │   └── instance-client.ts          实例能力状态与同源 API 请求
│   ├── database/browser-store.ts       IndexedDB 事务与旧数据读取辅助（不存聊天数据）
│   ├── features/capabilities.ts        按服务端授权判断功能
│   ├── llm/
│   │   └── provider-catalog.ts         通过服务端 `/api/agent/models` 获取 Provider 模型目录
│   └── platform/
│       ├── clipboard.ts                Web 原文复制适配
│       ├── model-credentials.ts        凭据接口与内存实现
│       ├── run-protection.ts           生成期间的 beforeunload 离开确认
│       └── target.ts                   运行目标判定（`isDesktopTarget`，区分 Web 与桌面端）
├── theme/
│   ├── appearance.tsx                  共享外观状态，默认 Twitter / 跟随系统
│   ├── presets.ts                      旧版 tweakcn 原始配色变量
│   └── resolve-theme.ts                暗色表面与前景明度适配，保留原始预设
└── global.css                          Tailwind 主题/工具类导入、@font-face、样式、布局、焦点与选区
```

- 路径别名 `@/` 指向 `ui/`，`@/assets/` 指向 `assets/`，`@contract/` 指向根目录 `contract/`（`tsconfig.json` 与 `vite.config.ts` 各登记一次，测试加载器 `tests/typescript-loader.mjs` 同步支持）。字体在 `assets/fonts/`，由 `ui/global.css` 顶部的 `@font-face` 引用 `../assets/fonts/*.ttf`，Vite 负责哈希并输出到构建产物。品牌标志文件是 `public/brand/matrius-sailboat.png`，favicon 使用透明底彩色 PNG（`public/favicon.png`，由 `assets/images/favicon.png` 复制，不再提供 `/favicon.ico`），PWA/Apple 图标使用同一帆船图案（`public/icons/`）；Apple 图标使用深蓝底，可遮罩图标使用深蓝底并保留安全边距。
- `contract/` 只放前后端共用的东西，且不得 import Node/DOM/React/数据库：`agent-protocol.ts`（wire 类型）、`agent-types.ts`（共享类型）、`agent-context.ts`（上下文组装、token 估算与请求校验）、`agent-prompt.ts`（系统提示）、`agent-memory.ts`、`agent-title.ts`、`agent-compaction.ts`、`agent-provider.ts`（Provider 校验与模型映射）、`agent-thinking.ts`（思考强度与预算）、`intelligent-ui.ts`（交互 UI 块解析与规范）。UI 用 `@contract/*` 导入，server 用相对路径导入，两侧共用同一份实现。
- 模板 Explore、标签导航、启动动画组件和 reset-project 脚本已移除。
- `dev/fixtures/chat-workspace.ts` 为显式开发预览数据，通过独立 `/mock/chat` 开发路径加载，包含 100 个批量多轮对话和 13 个专项会话（Markdown 综合格式、代码、公式、裸 LaTeX、错位定界符、50 轮长对话、超长回复、多语言、边界内容、短回复、未完成内容、压测长回复等）。Markdown 综合格式会话覆盖标题到六级、行内混排、转义与 HTML 实体、软换行、多层引用、四层嵌套列表、列表内代码块与引用、宽表格与对齐、十种语言代码块、长行横向滚动与多脚注；压测会话由程序生成 20 节、140 个块，用于观察长消息首次渲染、滚动与跨块选区。预览项清单集中在 `features/mock/mock-items.ts`，`/mock` 是列出各项的独立全页索引，新增测试只需在 `ui/router/routes.tsx` 注册一个 `/mock/*` 路由并往清单加一条记录。聊天预览保留设置入口，通过 `/mock/chat/settings` 复用正式设置组件，并共享本次预览状态；所有 `/mock/*` 路由由 `routes.tsx` 的 `MockOnly` 统一保护，生产构建直接跳回首页。预览索引、工具栏与样例数据仅在开发分支动态加载。正常模式不注入、不保存示例数据。
- `/mock/process` 通过 `features/mock/process-preview.tsx` 复用思考折叠区、正文和中断提示；阶段切换保留展开状态及连续计时，包含等待、思考、搜索、读取、再次思考、回答和结束，可验证按发生顺序追加步骤及整轮完成状态。模拟数据位于 `dev/fixtures/process-preview.ts`，不调用模型或写入聊天记录。
- `/mock/library` 直接复用 `features/files/library-screen.tsx`，由 `features/files/mock-library.ts` 提供 500 个内存文件（含 SVG 缩略图）与 `/api/files` 的列表、用量、重命名、删除实现；预览模式下 `enabled` 恒为真、不请求真实接口，侧栏“资料库”入口也指向该路由。`/mock/storage` 复用 `components/web/storage-error-toast.tsx` 预览各种保存失败提示。
- Web 会话与外观通过实例 REST 持久化，挂载 Provider 前先恢复数据。新建空白对话不创建历史记录，首次发送时创建；配置模型后通过服务端 Agent Runtime 生成真实回复。
- 新建对话首条消息发送后，`chat-runtime.tsx` 在回复之外并行调用 `core/api/agent-aux.ts` 请求服务端生成标题（规范化在 `contract/agent-title.ts`）；`titleModelId` 已配置时使用该模型，否则跟随会话绑定的模型。生成失败保留首条消息截断标题，并在后续回复成功后重试；`titleSource` 防止迟到的结果覆盖手动重命名或分支标题。每个会话最多一个进行中的标题请求，删除会话或卸载工作区时取消。
- 发送、置顶、重命名和删除会写回实例后端；读取或保存失败有提示。当前会话、侧栏和外观状态也会恢复，草稿仅在本次页面会话中保留。
- `/settings` 在根布局中使用独立全页，不包在聊天 Workspace 内；Provider 保持挂载，返回时会话与草稿不丢失。
- `/` 为新对话，`/c/<conversation-id>` 为已创建对话；首次发送成功后替换为空白页对应的新地址，侧栏、搜索和分支切换通过 Router 写入历史，浏览器前进后退按 URL 选择对话。设置返回当前对话地址；无效 ID 使用弹窗提示并提供返回新对话操作。Mock 使用 `/mock/chat/c/<conversation-id>`，仍受开发守卫保护。URL 在实例仓储加载后解析，不依赖上次保存的 activeId；未知路径重定向到 `/`。
- 桌面端「工作」模式使用独立地址：`/work` 为无项目时的空工作区，`/p/<project-id>` 为指定项目（Mock 对应 `/mock/chat/work` 与 `/mock/chat/p/<project-id>`），网页端与移动端访问时重定向回对话首页。切换「工作 / 对话」标签、切换/创建/移除项目与浏览器前进后退均保持地址栏同步；从工作区进入设置时返回对应工作区/项目地址，无效项目 ID 弹窗提示并返回工作区。

## 后续入口

| 功能 | 目标位置 |
| --- | --- |
| 本地数据库、实体仓储与后续迁移 | `ui/core/database/` |
| 服务端 Agent Runtime、上下文与工具调度 | `server/agent/` |
| 前后端共用的类型与纯逻辑 | `contract/` |
| 模型配置、模型目录与同源代理地址 | `ui/core/llm/` |
| 安全存储、文件、剪贴板等平台适配 | `ui/core/platform/` |
| 实例 REST 客户端、连接状态、409 冲突与错误映射 | `ui/core/api/` |
| 更多消息格式适配 | 聊天模块内的消息渲染组件 |
| 记忆、文件、实例访问 | `ui/features/<module>/` |
| 移动 Web 响应式布局 | 已按 767px 断点实现（抽屉导航、移动资料库选择栏、软键盘与安全区适配） |

其中模型配置、模型目录与响应式核心交互均已实现，其余能力随特性迭代补充。

## 职责边界

- `ui/router/routes.tsx` 只负责路径到页面组件的映射与 Mock 守卫，具体界面和业务状态在 `features/`。
- `ui/router/index.tsx` 是导航 API 的唯一入口；功能代码只从这里取 `Link`、`router` 和 hooks，不直接依赖 React Router 的类型。
- Web 的 DOM、CSS、浏览器事件只进入 Web 组件及其依赖；不要在共享状态模块调用浏览器 API。
- 输入草稿保存在独立的 Draft Context，避免每次键入更新侧栏，同时在切换设置后保留草稿。
- 数据源接入后统一经过仓储，不在页面里自行选择本地或云端数据源。

## 消息渲染资源与回归

- `scripts/sync-katex.mjs` 从已安装的 KaTeX 生成同版本 CSS、WOFF2 字体与许可证到 `public/vendor/katex/<版本>/`，由 `vite.config.ts` 在 `index.html` 注入样式链接，不依赖 CDN；资源由 postinstall 生成并忽略，不手工编辑。
- `tests/message-content.test.mjs` 通过 Node/LinkeDOM 验证 Markdown、公式、代码块、表格、安全链接与引用改写；`tests/typescript-loader.mjs` 把 `@/router` 解析为 `tests/stubs/router.mjs`，并把 `import.meta.env.DEV` 改写为 `globalThis.__DEV__ === true`，组件测试不加载 React Router，默认按生产模式运行。TypeScript 测试加载器只服务于测试，不进入客户端。

## 网页搜索引用

- 联网工具开启且该回复实际发生 `web_search` / `web_fetch` 时，`webToolsSystemPrompt()` 要求模型用 `[^1]` 脚注标记来源，并在回答末尾用 `[^1]: [页面标题](完整 URL)` 定义；引用只允许来自 `web_search` 结果或 `web_fetch` 成功读取的页面。没有调用联网工具的回复仍按普通 Markdown 脚注处理。
- `features/chat/citations.ts` 在 Markdown 渲染前按首次出现顺序分配序号，把脚注引用改写为可拦截的上角标链接，并从正文移除脚注定义列表；定义本身只用于提取标题、URL 和描述。
- `citation-marker.tsx` 渲染上角标：点击直接在新标签页打开来源；桌面指针设备悬停或聚焦时显示站点、标题与搜索摘要卡片，触屏设备不显示卡片。只有 `http(s)` URL 会成为可点击来源。
- 回复完成后，`source-badge.tsx` 在反馈栏上方显示「N 个网页」，N 只统计回答实际引用的来源；点击打开 `sources-panel.tsx`，按上角标序号列出这些来源，未引用的搜索命中或读取页面仍留在原有 search/fetch 行中，窄屏使用底部弹层。`webActivitiesOf()` 合并 `activities` 与 `process`，保证本地运行和历史消息使用同一套来源。
- `tests/citations.test.mjs` 覆盖序号、定义移除、代码块保护、仅列引用来源与非 http(s) 链接；`tests/message-content.test.mjs` 覆盖上角标渲染、悬浮卡片和触屏直达。

## 设置模块

- `/settings` 是可搜索的设置目录，根路径跳转到 `/settings/appearance`；`/settings/appearance` 合并显示模式和配色主题，`/settings/models` 管理模型服务，`/settings/usage` 展示 Token 用量，`/settings/about` 展示应用信息；旧 `/settings/theme`、`/settings/display` 路径由 `appearance-redirect.tsx` 跳到外观页。Chat Mock 使用 `/mock/chat/settings` 下的同名子路径，继承开发守卫；实例、存储与用量是云端整页路由，不进入 Mock 分类。所有路径都在 `ui/router/routes.tsx` 注册。
- `features/settings/settings-catalog.ts` 集中管理目录、搜索词与显示模式选项；`settings-page.tsx` 渲染目录、搜索与分类导航，并管理共用页面框架与返回入口；`settings-detail-screen.tsx` 提供外观与关于等详情控件。`settings-return.ts` 记录进入设置前的页面：从会话进入返回该会话，从资料库进入返回资料库；在桌面端从「工作」栏进入设置时，返回标签显示「返回工作」，返回后侧栏仍停留在「工作」栏；只有直接打开设置且没有来源时才回退到当前会话或新对话。桌面端非移动视口下在「应用」上方新增「工作 → 常规」（`/settings/work-general`，配置 Windows 默认终端）与「工作 → 主机」（`/settings/hosts`，管理 SSH 主机与 WSL 发行版），网页端与移动端视口均隐藏并重定向。
- 标签页标题由 `features/chat/document-title.ts` 决定：`/c/<id>`（含 Mock）使用对话名，`/p/<id>`（含 Mock）使用项目名，空标题和其他页面使用 Matrius。
- 设置子页均不卸载根工作区 Provider，导航期间保留会话、草稿与外观状态。
- `/settings/personalization` 与 `/mock/chat/settings/personalization` 提供记忆、自定义指令和关于你的表单，入口与搜索集中在 `settings-catalog.ts`。`personalization.ts` 定义字段、默认值与校验，`personalization-state.tsx` 保存共享状态，`personalization-screen.tsx` 实现 Web 表单；根工作区通过已有仓储恢复和自动保存，Runtime 在每次请求开始时组装系统提示。
- 个性化页的记忆区位于“关于你”和“其他设置”之间，包含记忆助手模型、启用开关与摘要管理。`contract/agent-memory.ts` 定义摘要契约与系统提示注入，后台整理在 `server/agent/memory.ts`；`memory-state.tsx` 保存开关和摘要；`memory-dialog.tsx` 用输入指令调用 `memory` 工具直接改摘要，不显示助手回复；标题旁显示更新时间与图标删除按钮，删除需二次确认。摘要非空且启用时进入每次对话的系统提示；回复完成后由记忆助手模型在后台整理，按会话每分钟最多一次，失败静默。记忆助手模型保存在本机 `model-preferences.memoryModelId`，为空时跟随会话模型。

## 模型与 Runtime 入口

- `features/models/model-settings-screen.tsx`：Provider 折叠卡片、当前模型选择，以及获取模型列表、编辑 Provider、编辑模型三类对话框；删除 Provider 或模型直接执行，不弹确认框。`model-state.tsx`：工作区模型状态，正常模式通过 `models-api.ts` 读写服务端 `/api/models`（不写浏览器 IndexedDB，也不回传明文密钥），Mock 模式使用 `core/platform/model-credentials.ts` 内存实现。
- `contract/agent-provider.ts`：Provider 配置校验与运行时模型映射（`@contract/agent-provider`）；`core/llm/provider-catalog.ts`：经服务端 `POST /api/agent/models` 获取模型目录；`core/platform/model-credentials.ts`：凭据接口与内存实现。
- `core/api/agent-runs.ts`：浏览器侧 Agent 通信适配，提交运行、消费 SSE 并更新消息，同时发送停止/steer；Agent 循环与工具模块位于 server/agent 与 server/agent/tools。
- `features/chat/chat-runtime.tsx`：薄 React 适配层，提供模型/凭据与偏好，把核心回复分发到聊天状态，挂在根工作区中，不随设置导航卸载。后台完成时维护临时通知列表；聊天屏挂载/卸载同步 `chatVisible`，让设置页期间的完成也保持未读。凭据、存储和流式传输环境分别经适配层接入。每轮回复结束后把 `onUsage` 汇总的 token 上报到实例。

- 侧栏采用品牌、平面主导航、可折叠的置顶/最近列表与底部设置入口；搜索按钮保留在侧栏顶部，桌面端收起侧栏后保留 60px 图标窄栏（顶部对齐顶栏的展开侧栏图标与分割线、下方仅展示当前模式功能图标：对话为新对话/资料库/定时任务/搜索，工作为创建项目，底部为设置按钮，不放模式切换图标），移动端抽屉关闭后在顶栏保留展开按钮。工作（Work）相关功能在网页端没有，且移动端视口同样按 Web 端处理（`npm run dev`、`npm run dev:web`、Web 构建及移动端均只显示对话导航）；仅当通过 `npm run dev:desktop` 以桌面端目标且非移动视口运行时，才会在品牌行与「新对话」之间显示「工作 / 对话」切换栏（默认停留「对话」；切换到「工作」时，左侧工作栏展示「创建项目」与可拖拽排序的项目列表（带独立展开箭头按钮与右键靠右「项目设置 / 移除项目」菜单），展开项目展示按 Codex / Antigravity / Claude Code 分组且支持拖拽调整组序的 CLI 对话区（仅分组标题显示品牌图标，右侧提供 `+` 按钮用于发起新对话（自动展开分组并在组内新增一条名为「新对话」的临时项且每组同时最多保留一个，关闭对应「新对话」标签页后随即消失；生成真实 CLI 会话后自动绑定 `cliSessionId` 并随对话标题变化实时同步未手动改名的终端标签标题）、未安装 CLI 时直接弹窗报错；具体对话右侧显示加载中/已完成状态检测，组内提供「显示更多 / 收起」分页），点击对话可恢复或聚焦对应终端标签（仅从加载中变为已完成且尚未点击查看的 CLI 对话在右侧显示与 Web 对话一致的未读圆点，点击或切换到该终端标签后消失），点击创建可选择主机或跳转主机设置并按需展开「AI 配置」设置 Codex / Antigravity / Claude Code 的网络代理与启动参数（各工具分组默认收起并记住后续展开/收起状态，普通终端默认不继承），创建后通过「项目设置」仅支持修改各 CLI 的「AI 配置」（名称、主机与目录锁定不可更改），点击目录按钮可弹出目录与文件选择器挑选项目目录，右侧工作区展示无额外未读圆点且支持拖拽排序（含已固定标签各自组内调整顺序）的终端标签顶栏（含右上角分体式 `+ | ▾` 新建系统终端按钮与右侧工作目录栏折叠按钮）、主区域支持右键复制/粘贴操作卡片、Ctrl+C / Ctrl+V 与 IME 输入法光标跟随的 `@xterm/xterm` 终端画布以及右侧可展开目录树边栏；从「工作」栏进入设置再返回时保持停留在「工作」栏）。设置保持独立整页，各级页面保留上一页与 Home 图标，不增加分类侧栏或横向分类导航。流式回复通过临时 `reasoningActive` 区分思考与正文生成，该字段不写入持久化白名单。非当前会话在侧栏显示运行中 spinner（`runs[id]`）或完成未读圆点（`completedReadAt === null`）；后台完成卡片挂载在根布局 `AppFrame` 内，因此设置页也可见并继承主题变量。`updatedAt` 决定「最近」排序，只在追加消息或回复正文生成完成时覆盖；后续思考与正文增量不会让会话反复跳到顶部，因此并发生成的会话不会在侧栏来回抢位。

## 实例与功能开关

- `core/api/instance-client.ts`：无 DOM / React 的实例能力状态与同源 API 请求；忽略过期的能力刷新请求。
- `server/agent/diagnostics.ts`：模型回复诊断摘要，记录每次调用的输出上限、HTTP 元数据、结束原因与用量，只保留最近运行的内存记录，不保存正文、工具参数或凭据；浏览器侧不再暴露 `matriusDiagnostics`。
- `core/features/capabilities.ts`：统一判断服务端授予的功能。
- `features/instance/instance-state.tsx`：Web Provider、useInstance、useFeature 与 FeatureGate。
- `features/files/storage-screen.tsx`：设置中的“存储”分类（位于实例下方），展示已用/总量、进度条，并按文件与图像分类跳转到资料库。
- `features/usage/usage-screen.tsx`：设置中的“用量”分类（位于存储下方），仅实例具备 `usage` 功能时可见；`token-usage-section.tsx` 展示今日/近 7 天/近 30 天、输入输出占比，以及截至今天向前回溯六个月的日热力图和包含本周的最近六周柱状图，支持点击日格或周柱查看精确 token 数；`usage-api.ts` 读取统计并在每轮回复后上报 token。
- `settings-catalog.ts` / `settings-page.tsx`：分类与搜索按功能能力统一过滤。
- `ui/router/routes.tsx` 中的 `/settings/storage`、`/settings/usage`：存储与用量设置路由组装；存储与用量仅在实例具备对应功能时出现在导航中。

## 开发脚本

- `scripts/start.mjs`：单进程自部署启动器，先执行全量 `vite build` 构建 `dist/`，再启动 Node API 同时托管界面与 `/api/*` 并等待就绪后输出访问地址。
- `scripts/dev.mjs`：跨平台本机开发启动器，管理本地 SQLite、Node API 和 Vite 进程及退出清理，不连接服务器。
- `scripts/dev-api-proxy.cjs`：Vite 开发服务器的同源 `/api/*` 转发。
- `vite.config.ts`：Vite 开发与构建配置；设置 `WEB_PORT`（默认 8081，严格端口）、`@/` 与 `@/assets/` 别名、KaTeX 样式与离线外壳插件，以及 `/api/*` 开发代理中间件。

- `features/workspace/workspace-mode.ts`：按实例连接状态加载工作区或等待重连的工作区身份。
- `features/workspace/cloud-workspace-repository.ts`：唯一实例的内存 REST 仓储，加载服务端数据并按 revision 保存变化；不访问 IndexedDB，不包含模型配置或凭据。
- `components/web/instance-workspace.tsx`：生产只加载后端工作区并用 REST 保存；连接不可用时等待重连。开发预览使用内存，不加载正式业务数据。

上下文占用与计费用量分开：运行期间按会话和模型保存最近一次服务商报告的调用输入（含缓存读取/写入）与输出，不累加各轮调用；面板把输入拆成未缓存输入和缓存输入，并与输出一起展示。新调用开始时保留上一次报告的读数，等本次调用返回用量后再替换，不用估算值覆盖（避免输出短暂显示为 0）；只有会话还没有报告（新对话或刷新后）才按当前工具定义、保留正文、记忆与滚动摘要估算。运行时数据仅在内存中，不从当天累计用量反推。历史思考与工具结果只在实际请求携带时计入，不把展示用的完整过程重复加到下一轮历史。
