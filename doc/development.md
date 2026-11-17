# 开发与验证

项目使用 React 19、TypeScript、Vite 8 与单 Node/Fastify 后端，无需 Python、uv 或 Alembic CLI。

## 本机开发

npm ci 安装依赖；npm run dev 常驻启动 Node API 与 Vite，启动时自动迁移开发库。默认 Web 8081、API 8000，通过 .env.local 的 DEV_WEB_PORT / DEV_API_PORT 配置。Vite 将 /api 请求代理到本机 API。开发不连接生产服务器。

Node API 在启动时读取服务端代码与 .env.local，npm run dev 不会热重载 API；修改服务端代码、代理或搜索/抓取限额后需要重启 npm run dev。只改后端时也可以使用 `npm run dev:server`（tsx watch，自动重启）。

npm run dev 支持 --check、--reset-db 与 --clear。重置数据库会删除当前数据目录中的开发数据。数据默认在 `~/.matrius`，可在 `.env.local` 用 `DATA_DIR` 指定其他位置；`npm run db:migrate` 单独迁移同一个开发库；`npm run dev:server` 只启动后端。`STORAGE_LIMIT_BYTES` 控制上传文件总量上限，默认 128 MiB。

开发启动时 API 与 Vite 并行启动，终端分别显示两者就绪耗时，两者通过本机 HTTP 检查后显示 Development 地址。Vite 就绪不代表浏览器全部模块已加载。文档工具服务和标题/记忆使用的模型运行器按需加载；文件文本提取按格式加载 Word、Excel 或 PDF 解析库，首次使用相应功能仍需支付加载成本。

`npm run dev` 的后端通过现有 Vite 构建到 `node_modules/.cache/matrius-server`，把项目代码与 zod/typebox 的大量小模块合并，减少 Windows 闲置后首次启动的零碎文件读取。再次启动检查源码文件元数据、锁文件、Node 版本与构建脚本，未变化则直接运行缓存，不加载 tsx 或构建器。修改 server/contract 源码、增删文件、安装依赖或缓存缺失后自动重建；资源路径仍指向源码目录，迁移与 OfficeCLI 不复制到缓存。`npm run dev:server` 仍使用 tsx watch。`--clear` 只清 Vite 前端预构建，后端缓存自动失效。

Windows 偶发慢启动可先根据就绪耗时区分 API 和 Vite。首次安装依赖、锁文件或 Vite 配置变化会触发前端依赖预构建，TypeScript 转译缓存未命中也会增加后端耗时；磁盘负载与实时扫描可能放大这些文件读取的耗时。日常启动保留缓存，`--clear` 仅在需要重建 Vite 依赖缓存时使用，不要把清缓存作为常规加速手段。

Vite 的依赖扫描固定从 `index.html` 开始，不再通过全仓库 HTML glob 发现入口；前端文件监听忽略 `server/`，避免扫描或监听 OfficeCLI 二进制与后端测试资源。共享前端逻辑 `contract/` 仍被监听。

前端样式由 `ui/global.css` 直接导入 Tailwind v4（`@tailwindcss/vite`）：只加载 `theme` 与 `utilities` 两层，不加载 preflight，`@source` 指向 `node_modules/streamdown` 与各 `@streamdown/*` 插件，`@theme inline` 把 shadcn 语义色映射到应用主题变量。改动 Streamdown 版本后要确认这几个 `@source` 路径仍然匹配 `dist/*.js`，否则插件新增的工具类不会进入构建。

## 验证

- npx tsc --noEmit：前端类型检查。
- npm run typecheck:server：后端类型检查。
- npm run test：UI 与共享测试，按文件并发执行。
- npm run test:server：后端测试，按文件并发执行。
- npm run build：生产构建到 dist。
- npx eslint .：可选风格检查。

共享逻辑、协议、持久化或跨模块修改运行全量测试。模拟模型测试不能代替真实浏览器验收。真实模型需验证流式回复、stop/steer、文件上传读取、标题、记忆与刷新持久化。

## 新增测试规范

为保证全量测试在数秒级完成、避免单测膨胀拖慢开发节奏，新增测试需遵守以下约定：

1. **保持文件级并发安全**：`npm run test` 与 `npm run test:server` 按文件并发执行。每个测试文件必须使用独立的临时目录（`mkdtempSync`）、内存数据库或 `app.inject()`，禁止使用固定端口、固定本地文件路径或跨文件共享可变状态。
2. **禁止真实长睡眠**：涉及超时、重试、防抖、节流或定时器的测试，优先使用 `t.mock.timers` 或注入毫秒级短超时参数，禁止 `setTimeout` 等待秒级时间。
3. **重型依赖与外部进程隔离**：单元测试默认使用内存 stub / fake（如假 HTTP 客户端、假 SSE 响应），不发真实外网请求；OfficeCLI、LibreOffice 等重型子进程只保留在对应集成测试文件中，不在无关测试里重复创建文档或启动子进程。
4. **控制单测构造开销**：需要批量数据时优先构造最小可用数据集，避免在每个用例里重复生成数百条富文本或全量渲染。
5. **按范围运行单测**：日常开发优先运行受影响的单个测试文件（`npx tsx --test server/tests/<name>.test.ts` 或 `node --import ./tests/register.mjs --test tests/<name>.test.mjs`），跨模块或底层改动再跑全量。

## 调试与交付

Agent 在服务端运行，结合 Node API 日志与浏览器 Network 的 SSE 排查错误。本机 `/debug` 提供接口查询与健康检查，不记录 key、正文或原始模型请求。

/mock/* 仅开发可用，由 ui/router/routes.tsx 的 MockOnly 保护，生产重定向首页。

部署方式待重新设计，当前不发布到服务器；本文只覆盖本机开发。

提交前同步文档，如实报告实际检查与未实测范围，不提交密钥或真实用户数据。
