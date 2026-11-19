# Expo 模板迁移记录

[文档索引](README.md)

> 历史记录：本文记录从 `../matrius-old`（Flutter/Expo 模板）迁移到 React Web 的过程。文中提到的账号登录、浏览器 Agent Runtime、Python 后端和部署方式均已废弃，现状见 [AGENTS.md](../AGENTS.md) 与各专题文档。

## 当前范围

旧工程位于 `../matrius-old`，Flutter/Dart 界面需用 React 组件重写。项目使用 Vite + React Router，前端迁移（含桌面与移动 Web 响应式适配）已完成，无需重新初始化工程。

## 已完成

1. 迁移产品与开发文档。
2. 替换模板导航：移除 Explore 与 Home/Explore 标签栏，使用 `/` 聊天和 `/settings` 设置路由。
3. 迁移初期 Web 页面使用 `X.web.tsx` 与 `X.tsx` fallback；后续切换 Vite 后已统一为普通 `X.tsx` / `X.ts`，见[客户端结构](client-structure.md)。
4. 迁移字体资源和 10 套 tweakcn 配色，保留 Twitter 默认配色，支持浅色、深色与跟随系统。主题切换只改变配色。
5. 重建聊天外壳：侧栏、收起/展开、新对话、欢迎页、输入框与消息区。
6. 实现会话的新建、切换、搜索标题与正文、置顶、重命名及确认删除。
7. 实现独立全页外观设置；清理模板组件与 reset-project 脚本。
8. 用户与助手消息接入 Markdown/GFM 与 KaTeX 公式渲染，代码语言按需高亮，支持代码块原文复制和折叠，提供 Node/DOM 回归检查。
9. 接入 Agent Runtime、BYOK 模型配置、同源模型中继、流式回复、停止/重试、引用、反馈、分支与 AI 标题生成。
10. 后端最终迁移到单 Node/TypeScript 进程（Fastify + node:sqlite）；旧 Python/FastAPI 后端与账号体系已移除，见[后端架构](backend.md)。

## 交互与边界

- 输入框支持中文输入法、Enter 发送、Shift+Enter 换行；建议按钮将提示词填入输入框，不自动发送。
- 搜索支持 Ctrl/Cmd+K 打开，Esc 关闭；弹窗使用浏览器原生 dialog 处理模态焦点。
- 正常模式没有种子会话或模拟 AI 回答；开发地址 `/mock` 是预览索引页，可进入 `/mock/chat` 查看聊天渲染样例；预览修改不写入正式数据。
- Web 刷新从服务端恢复对话、消息、置顶与外观偏好；未发送草稿仅保留在页面会话。（后续模型配置与 API key 也已迁入服务端 SQLite，清除浏览器站点数据不会丢失服务端模型配置。）

静态检查与交付方式见[开发与验证](development.md)。
