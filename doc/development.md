# 开发与验证

项目使用 React 19、TypeScript、Vite 8 与单 Node/Fastify 后端，无需 Python、uv 或 Alembic CLI。

## 本机开发

npm ci 安装依赖；npm run dev 常驻启动 Node API 与 Vite，启动时自动迁移开发库。默认 Web 8081、API 8000，通过 .env.local 的 DEV_WEB_PORT / DEV_API_PORT 配置。Vite 将 /api 请求代理到本机 API。开发不连接生产服务器。

Node API 在启动时读取服务端代码与 .env.local，npm run dev 不会热重载 API；修改服务端代码、代理或搜索/抓取限额后需要重启 npm run dev。只改后端时也可以使用 `npm run dev:server`（tsx watch，自动重启）。

npm run dev 支持 --check、--reset-db 与 --clear。重置数据库会删除当前数据目录中的开发数据。数据默认在 `~/.matrius`，可在 `.env.local` 用 `DATA_DIR` 指定其他位置；`npm run db:migrate` 单独迁移同一个开发库；`npm run dev:server` 只启动后端。`STORAGE_LIMIT_BYTES` 控制上传文件总量上限，默认 128 MiB。

## 验证

- npx tsc --noEmit：前端类型检查。
- npm run typecheck:server：后端类型检查。
- npm run test：UI 与共享测试，按文件串行。
- npm run test:server：后端测试。
- npm run build：生产构建到 dist。
- npx eslint .：可选风格检查。

共享逻辑、协议、持久化或跨模块修改运行全量测试。模拟模型测试不能代替真实浏览器验收。真实模型需验证流式回复、stop/steer、文件上传读取、标题、记忆与刷新持久化。

## 调试与交付

Agent 在服务端运行，结合 Node API 日志与浏览器 Network 的 SSE 排查错误。本机 `/debug` 提供接口查询与健康检查，不记录 key、正文或原始模型请求。

/mock/* 仅开发可用，由 ui/router/routes.tsx 的 MockOnly 保护，生产重定向首页。

部署方式待重新设计，当前不发布到服务器；本文只覆盖本机开发。

提交前同步文档，如实报告实际检查与未实测范围，不提交密钥或真实用户数据。
