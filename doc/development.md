# 开发、验证与交付

[文档索引](README.md)

## 环境与客户端命令

当前使用 npm 和 `package-lock.json`，Expo SDK 57。Node.js 版本需满足[对应 SDK 要求](https://docs.expo.dev/versions/v57.0.0/)。

```bash
npm ci                         # 根据锁文件安装依赖
npx expo start                 # Metro 开发服务
npm run android                # 打开 Android 开发目标
npm run ios                    # 打开 iOS 开发目标
npm run web                    # Web 开发
npx expo start --port 8082      # 端口占用时换端口
npx expo lint                  # 使用仓库 ESLint 配置检查
npx tsc --noEmit               # TypeScript 类型检查
npm run test:rendering         # Markdown、公式、代码高亮与折叠/复制回归
npm run assets:katex           # 按需重新生成本地公式 CSS 和字体（npm ci 后自动生成）
npx expo-doctor                # 诊断依赖与配置
npx expo install <package>     # 安装 SDK 兼容依赖
npx expo install --fix         # 按需修复不兼容版本
npx expo export --platform web # 导出 Web 静态产物到 dist/
```

- `npm run android` / `ios` 启动开发目标，不是生产构建。Android 模拟器需要 Android SDK；本机 iOS 模拟器需要 macOS 与 Xcode。
- Windows / WSL 开发时，确保真机或宿主机能访问 Metro 输出的地址；端口和网络以实际输出为准。不要沿用旧版 Flutter Web Server 命令。
- `npm ci` 的 postinstall 从安装的 KaTeX 生成同版本 CSS、WOFF2 字体和许可证到 `public/vendor/katex/<版本>/`；Expo 从 public 提供这些资源，避免 CSS 相对字体 URL 在 Metro 中失效。禁用安装脚本或升级 KaTeX 后运行 `npm run assets:katex`。
- 已提供 `eslint.config.js`、ESLint 与 Expo lint 配置，`npm ci` 后可直接执行 lint。消息渲染回归使用 Node 内置测试运行器、TypeScript 加载器和 LinkeDOM，不启动浏览器。
- 模板的 `reset-project` 脚本与命令已移除，避免重置业务页面。
- 若后续改为 Bun，提交对应锁文件后将 `npx` 换为 `bunx`，不要混用多套锁文件。

## 构建与发布

使用 [EAS Build](https://docs.expo.dev/build/introduction/) 构建和签名，EAS Submit 提交商店，EAS Update 发布兼容的 OTA 更新。

以下为后续配置流程，当前尚无 `eas.json`、EAS 项目关联或 Updates 配置，不代表现在可直接发布：

```bash
npx eas-cli@latest build:configure
npx eas-cli@latest build --platform android
npx eas-cli@latest build --platform ios
npx eas-cli@latest submit --platform android
npx eas-cli@latest submit --platform ios
```

开发客户端需先安装 `expo-dev-client` 并配置 development profile，再运行 `npx eas-cli@latest build --profile development --platform android` 或 iOS 对应命令。OTA 更新需先配置 EAS Update 与运行时兼容策略；新增原生模块或更改原生配置后需要新的二进制构建。

当前原生目录由 CNG 生成，原生行为通过 app config / config plugins 配置，不手工创建或修改 `ios/`、`android/`。

## 后端与基础设施

后端技术栈未定，以下是沿用的目标约定，相关脚本、Compose 和 `.env.example` 尚未提供：

- 应用在宿主机运行，PostgreSQL、Redis、RustFS、OpenSERP 在 Docker 中运行。
- 开发容器统一使用 `matrius-net` 网络；网络与生命周期由项目脚本封装。
- 环境模板后续提供 `DATABASE_URL`、`REDIS_URL`、`RUSTFS_ENDPOINT`、`RUSTFS_ACCESS_KEY`、`RUSTFS_SECRET_KEY`、`RUSTFS_BUCKET` 和 `OPENSERP_URL`。
- 这些服务端凭据不得放入客户端公开环境变量或提交进仓库；数据库结构变更使用迁移。

## 验证与代码规则

- 完成任务前运行 `npx expo lint` 和 `npx tsc --noEmit`，如实报告结果和环境阻塞。
- 已有测试覆盖相关行为时运行必要的测试；消息渲染相关修改运行 `npm run test:rendering`；测试覆盖格式解析、公式/货币与代码边界、安全 URL/HTML、高亮、折叠和原文复制，以及消息赞/踩切换和分支上下文隔离。文档迁移无需新增业务测试。
- 不自动启动或控制浏览器、不生成浏览器截图、不访问运行中的 Web 端口；仅在用户明确要求 Web 浏览器验证时执行。未实测的平台行为说明限制。
- TypeScript 保持 strict；不滥用 `any`、关闭 lint 或压制告警来绕过问题。
- 复用已有组件和服务，避免无关重构；不提交真实用户数据、密钥和令牌。
- 后续自动化测试应作为仓库资产提交，放在应用路由目录外。临时脚本、种子数据和测试产物应明确忽略，不能假设旧仓库的忽略规则已经迁移。

## 完成前检查

- 查看相关实现与文档，保持业务依赖方向和多用户隔离。
- 涉及功能时检查本地/云端模式边界、密钥处理、重试和数据保留。
- UI 涉及安全区、键盘、字体缩放、无障碍、长列表和 Web 适配时报告验证范围。
- 报告 lint、类型检查及相关测试的实际结果。
- 产品边界、持久化、目录职责或命令变化时同步更新对应文档与根 README。


## 开发示例对话

- 用户要求的界面调试数据位于 `dev/fixtures/chat-workspace.ts`，不放进业务组件或普通启动数据中。
- `npm run web` 后直接打开 `/mock`（例如 `http://localhost:8081/mock`，端口以实际启动输出为准）。会直接进入 `/mock/chat` 聊天渲染测试，不需要管理员后台或登录。
- Mock 仅保留聊天测试，移除设置页与设置入口；正式应用的 `/settings` 保持可用。
- 参考 `../openstudio/tests/seed-software-test.mjs` 的批量长对话与专项样例结构，提供 100 个八轮对话和 9 个专项会话，共 109 个会话、1730 条消息。
- 专项覆盖 Markdown 标题/列表/引用/表格/脚注、多语言代码块、公式与货币、50 轮长对话、40 段单条长回复、Unicode/RTL、长链接与 HTML 原文、短回复和未闭合标记；前四个专项会话置顶。
- 点击侧栏切换样例，也可通过搜索标题或正文定位内容，支持置顶、重命名、删除与输入草稿；发送仍不调用模型或自动生成回复。
- 示例模式不读取或写入浏览器真实工作区，变更仅保存在内存中。右下角提供重置和退出入口；刷新示例地址也会重置。
- 通过 `__DEV__` 守卫动态加载示例模块，release 模式不开放 Mock 预览，访问这些路径会返回正常应用，示例内容不会打入生产 JS。
- 用户与助手消息共用 Markdown/GFM 与 KaTeX 渲染，支持标题、列表、引用、表格、脚注、公式和按需代码高亮；代码块可复制与折叠。Mermaid 等未知代码语言作为原文展示，未实现实时流式模型输出。
