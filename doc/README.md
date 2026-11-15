# 开发文档索引

本目录从 `../matrius-old/doc/` 迁移，保留产品、认证、数据存储、Agent、文件与记忆约定，客户端实现说明按 React + Vite Web 维护。

## 当前进度与阅读方式

- 当前只维护 Web 界面；移动 Web 响应式适配后续按单独要求进行。
- Web 已完成聊天外壳、侧栏、会话管理、标题/正文搜索和外观设置；Agent Runtime 位于服务端 `server/agent`，浏览器通过 SSE 提交运行并消费事件；旧版 10 套配色与字体已迁入。
- 当前为单用户实例：业务数据统一保存到后端，浏览器仅保存模型配置、密钥和设备状态。用户管理与本地/云端切换已移除，无需登录，所有访问者共享实例数据。
- 后端接口与数据契约见[后端架构](backend.md)；客户端实现入口见[客户端结构](client-structure.md)；历史迁移记录见[模板迁移记录](migration.md)。

| 文档 | 内容 |
| --- | --- |
| [模板迁移记录](migration.md) | 历史迁移记录（已完成；旧账号、浏览器 Runtime 与 Python 后端已废弃） |
| [产品与开发顺序](product.md) | 单用户实例、能力边界和开发路线 |
| [架构与模块边界](architecture.md) | 实例连接状态、API、依赖方向与目标目录 |
| [UI 风格与交互规范](ui-style.md) | 旧版设计目标与 Web 适配要求 |
| [客户端结构与修改入口](client-structure.md) | 当前实际文件、待创建的功能目录 |
| [Web 客户端约定](client.md) | 路由、主题、字体、浏览器适配与模型调用 |
| [存储与数据同步](data.md) | SQLite、文件目录、浏览器模型配置、迁移与冲突 |
| [实例访问与资源](instance.md) | 无需登录的实例、资源统计与数据迁移 |
| [Agent Runtime、模型与工具](agent.md) | 服务端 Runtime、模型代理与工具边界 |
| [文件读取与个人记忆](files-and-memory.md) | 文档解析、记忆提炼与注入 |
| [开发、验证与交付](development.md) | 环境、启动命令、代码规则和完成检查 |
| [后端架构与云端数据契约](backend.md) | Node/Fastify 边界、接口、并发、文件与工具 |
| [历史压测记录](performance.md)、[多账户压测（历史）](performance-multiaccount.md) | 旧 Python/FastAPI 后端的压测存档，不适用于当前实现 |

## 文档维护

- `AGENTS.md` 保留核心约束和阅读入口，具体设计放在对应文档。
- 路径或职责变化更新 `client-structure.md`；命令变化更新 `development.md` 和根 `README.md`。
- 完成一项迁移后同步更新进度，区分现状、目标和待评估选型。
- 部署方式待重新设计，当前不维护部署文档。
