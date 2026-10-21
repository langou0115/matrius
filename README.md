# Matrius

轻量、多用户、可自行部署的 AI 对话应用。当前以 Web 为主，移动端后续适配。

## 特性

- **多轮对话**：流式回复、停止、重试、引用、分支、搜索与置顶
- **本地优先**：未登录即可使用，对话保存在浏览器 IndexedDB
- **自带模型**：支持 OpenAI Chat Completions、Responses、Anthropic Messages 及兼容服务，密钥只保存在本机
- **完整渲染**：Markdown / GFM、KaTeX 公式、代码高亮、复制与折叠
- **账号与灰度**：管理员建号、首次改密；新功能先在测试账号验证，再按账号发布
- **自部署后端**：FastAPI、PostgreSQL、Redis、RustFS、OpenSERP，Caddy 统一入口
- **远程发布**：本机一条命令，服务器构建并运行生产镜像

> 登录当前只用于功能权限，对话仍保存在本机；云端数据同步尚未接入。

## 技术栈

| 部分 | 选型 |
| --- | --- |
| 客户端 | Expo SDK 57、React Native、React、TypeScript |
| 路由 | Expo Router（`src/app/`） |
| 后端 | Python 3.12、FastAPI、SQLAlchemy、Alembic |
| 基础设施 | PostgreSQL、Redis、RustFS、OpenSERP、Caddy |
| 部署 | Docker Compose、SSH、`npm run remote` |

## 本地开发

要求 Node.js 24 和 npm。

```bash
npm ci
npm run web
```

打开 `http://localhost:8081`，在「设置 → 模型服务」添加服务商和模型后即可对话。

`npm run web` 是开发模式，可访问 `/mock` 查看聊天界面样例；部署产物不包含 Mock。

```bash
npm run export:web && npm run serve   # 本地验证生产构建
```

## 部署

服务器只需 Docker、SSH 和常用命令行工具，本机不需要 Python、Docker 或数据库。

```bash
cp .env.local.example .env.local   # 填 SSH 目标和网页地址
npm run remote -- --check          # 本地校验，不连接服务器
npm run remote                      # 首次自动初始化，之后日常部署
```

首次运行会在服务器生成随机服务密钥、初始化数据库并创建管理员。管理员账号密码可在 `.env.local` 中通过 `INITIAL_ADMIN_USERNAME` / `INITIAL_ADMIN_PASSWORD` 指定；不填则随机生成并在首次输出中打印。

默认端口：`16666` 为网页 + API，`16667` 仅 API（可选）；在 `.env.local` 用 `APP_PORT` / `API_PORT` 覆盖，详见[修改端口](doc/deployment.md#修改端口)。每次命令完成同步、构建、健康检查后退出；默认部署不更新功能清单，`--publish` 才把 stable 功能开放给其他账号。

服务器初始化、账号、HTTPS、备份与 CD 见[服务器部署](doc/deployment.md)。

## 文档

| 文档 | 内容 |
| --- | --- |
| [文档索引](doc/README.md) | 全部文档入口 |
| [产品](doc/product.md) | 产品边界与本地/云端模式 |
| [后端](doc/backend.md) | API、数据模型与实现 |
| [认证](doc/auth.md) | 登录、管理员与功能开关 |
| [开发与验证](doc/development.md) | 命令、构建、测试与 Mock |
| [服务器部署](doc/deployment.md) | 初始化、发布、备份与运维 |

## 验证

```bash
npx expo lint
npx tsc --noEmit
npm run test:rendering
npm run test:models
npm run test:auth
npm run test:remote
```

后端测试见[后端 README](server/README.md)。

## 许可

见 [LICENSE](LICENSE)。
