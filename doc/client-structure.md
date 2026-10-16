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
│   └── icon.tsx                        统一线框 SVG 图标
├── features/
│   ├── chat/
│   │   ├── chat-state.tsx              会话状态、选择与管理动作
│   │   ├── draft-state.tsx             独立草稿状态，跨设置导航保留
│   │   ├── chat-screen.web.tsx         欢迎页、消息区、按会话保存的输入草稿
│   │   ├── markdown/                   公式/货币规范化与高亮语言按需加载
│   │   └── components/
│   │       ├── sidebar.web.tsx         侧栏、会话管理与设置入口
│   │       ├── conversation-title.web.tsx  顶栏标题单击重命名
│   │       ├── conversation-select.web.tsx  长标题悬停/焦点滚动与动效偏好
│   │       ├── conversation-menu.web.tsx  三点按钮旁的三项操作卡片
│   │       ├── message-actions.web.tsx  消息复制、赞/踩与创建分支入口
│   │       ├── message-content.web.tsx  用户与助手 Markdown/GFM、KaTeX 渲染
│   │       ├── reasoning-block.web.tsx  等待与思考共用的状态行及折叠正文
│   │       ├── code-block.web.tsx       代码高亮、复制与折叠
│   │       ├── composer.web.tsx        输入法、Enter/Shift+Enter、模型提示
│   │       └── search-dialog.web.tsx   标题与正文搜索、结果片段
│   ├── workspace/workspace-repository.web.ts  工作区存储结构校验
│   ├── settings/settings-screen.web.tsx  独立全页设置
│   └── mock/
│       ├── mock-items.ts               预览项清单与按路径反查
│       └── mock-index-screen.web.tsx   独立全页预览索引
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
- Web 会话与外观通过 IndexedDB 持久化，挂载 Provider 前先恢复数据。新建空白对话不创建历史记录，首次发送时创建；配置模型后通过本地 Runtime 生成真实回复。
- 发送、置顶、重命名和删除会写回浏览器数据库；读取或保存失败有提示。当前会话、侧栏和外观状态也会恢复，草稿仅在本次页面会话中保留。
- `/settings` 在根布局中使用独立全页，不包在聊天 Workspace 内；Provider 保持挂载，返回时会话与草稿不丢失。

## 后续入口

| 功能 | 目标位置 |
| --- | --- |
| 手机本地数据库、实体仓储与后续迁移 | `src/core/database/` |
| 本地 Agent Runtime、上下文与云端工具调度 | `src/core/agent/` |
| 模型直连 / 代理传输、SSE、解码器 | `src/core/llm/` |
| 安全存储、文件、剪贴板等平台适配 | `src/core/platform/` |
| 增量同步与重试 | `src/core/sync/` |
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

## 模型与 Runtime 入口

- `features/models/model-settings-screen.web.tsx`：Provider 折叠卡片、当前模型选择，以及获取模型列表、编辑 Provider、编辑模型、删除确认四类对话框；`model-state.tsx`：工作区独立状态和按 Provider 隔离的凭据；`model-repository.web.ts`：无密钥元数据读写及旧配置迁移；`model-credential-store.web.ts`：密钥的独立 IndexedDB 记录，Mock 不读写。
- `core/llm/model-config.ts`：Provider 配置校验、运行时模型映射与三协议适配；`core/llm/provider-catalog.web.ts`：从 Provider 获取模型目录；`core/platform/model-credentials.ts`：凭据接口与内存实现；`core/agent/runner.ts`：pi Agent 流式运行与取消。
- `features/chat/chat-runtime.tsx`：共享运行生命周期，挂在根工作区中，不随设置导航卸载。
