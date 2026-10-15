# 开发文档索引

本目录从 `../matrius-old/doc/` 迁移，保留产品、认证、数据同步、Agent、文件与记忆约定，将客户端实现说明调整为 React Native + Expo。

## 当前进度与阅读方式

- 当前优先开发 Web 界面，移动端后续适配，原生路由暂留说明页。
- Web 已完成聊天外壳、侧栏、会话管理、标题/正文搜索和外观设置；旧版 10 套配色与字体已迁入。
- Web 对话与外观偏好已通过 IndexedDB 保存在浏览器，刷新可恢复；草稿仍在页面内存中。设置为独立全页。模型、Agent Runtime、手机本地存储、认证、记忆与同步尚未接入。
- 产品与后端能力按目标设计阅读；具体实现入口见 `client-structure.md`，迁移步骤见 `migration.md`。

| 文档 | 内容 |
| --- | --- |
| [Expo 模板迁移记录](migration.md) | 当前迁移步骤、完成项与后续边界 |
| [产品与开发顺序](product.md) | 本地/云端模式、能力边界和开发路线 |
| [架构与模块边界](architecture.md) | 多用户隔离、API、依赖方向与目标目录 |
| [UI 风格与交互规范](ui-style.md) | 旧版设计目标与移动端适配要求 |
| [客户端结构与修改入口](client-structure.md) | 当前实际文件、待创建的功能目录 |
| [React Native + Expo 客户端约定](client.md) | 路由、主题、字体、平台适配与模型直连 |
| [存储与数据同步](data.md) | 浏览器存储、手机本地存储规划、PostgreSQL、Redis、RustFS、合并与冲突 |
| [认证与用户管理](auth.md) | 初始化、登录、改密和管理员操作 |
| [Agent Runtime、模型与工具](agent.md) | 客户端本地 Runtime、单次模型代理与云端工具边界 |
| [文件读取与个人记忆](files-and-memory.md) | 文档解析、记忆提炼与注入 |
| [开发、验证与交付](development.md) | 环境、启动命令、代码规则和完成检查 |

## 文档维护

- `AGENTS.md` 保留核心约束和阅读入口，具体设计放在对应文档。
- 路径或职责变化更新 `client-structure.md`；命令变化更新 `development.md` 和根 `README.md`。
- 完成一项迁移后同步更新进度，区分现状、目标和待评估选型。
