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
│   ├── mock/                          开发预览目录、对话与设置独立路由
│   ├── settings.web.tsx                设置路由
│   ├── index.tsx                       移动端待适配说明页
│   └── settings.tsx                    原生设置说明页
├── components/web/
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
│   │   └── components/
│   │       ├── sidebar.web.tsx         侧栏、会话管理与设置入口
│   │       ├── conversation-menu.web.tsx  三点按钮旁的三项操作卡片
│   │       ├── message-content.web.tsx  助手消息的基础文本与代码块展示
│   │       ├── composer.web.tsx        输入法、Enter/Shift+Enter、模型提示
│   │       └── search-dialog.web.tsx   标题与正文搜索、结果片段
│   ├── workspace/workspace-repository.web.ts  工作区存储结构校验
│   └── settings/settings-screen.web.tsx  独立全页设置
├── core/database/browser-store.web.ts  IndexedDB 事务、版本与冲突检查
├── theme/
│   ├── appearance.tsx                  共享外观状态，默认 Twitter / 跟随系统
│   ├── presets.ts                      旧版 tweakcn 原始配色变量
│   └── resolve-theme.ts                暗色表面与前景明度适配，保留原始预设
└── global.css                         Web 样式、字体、布局、焦点与选区
```

- 路径别名 `@/` 指向 `src/`；本地字体在 `assets/fonts/`，通过根布局的 expo-font 加载。
- 模板 Explore、标签导航、启动动画组件和 reset-project 脚本已移除。
- `dev/fixtures/chat-workspace.ts` 为显式开发预览数据，通过独立 `/mock/chat` 开发路径加载，正常模式不注入、不保存示例数据。
- Web 会话与外观通过 IndexedDB 持久化，挂载 Provider 前先恢复数据。新建空白对话不创建历史记录，首次发送时创建；模型尚未连接，不生成模拟回答。
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
| Markdown、代码高亮与公式 | 聊天模块内的消息渲染组件 |
| 记忆、文件、认证、管理员 | `src/features/<module>/` |
| 原生界面 | 保持共享状态与契约，后续增加 React Native 页面与组件 |

这些目录尚未实现，随功能创建。

## 职责边界

- `src/app/` 仅放路由页面和布局，具体界面和业务状态在目录外。
- Web 的 DOM、CSS、浏览器事件只进入 Web 路由及其组件依赖；不要在共享状态模块调用浏览器 API。
- 输入草稿保存在独立的 Draft Context，避免每次键入更新侧栏，同时在切换设置后保留草稿。
- 数据源接入后统一经过仓储，不在页面里自行选择本地或云端数据源。
