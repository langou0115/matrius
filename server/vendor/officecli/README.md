# OfficeCLI

文档创建/编辑引擎，来自 [iOfficeAI/OfficeCLI](https://github.com/iOfficeAI/OfficeCLI)，
使用 [Apache-2.0](https://github.com/iOfficeAI/OfficeCLI/blob/main/LICENSE) 许可。

| 项目 | 值 |
| --- | --- |
| 版本 | `1.0.159`（见 `VERSION`） |
| 来源 | `https://github.com/iOfficeAI/OfficeCLI/releases/tag/v1.0.159` |
| Linux x64 | `linux-x64/officecli`，35,502,949 B |
| Windows x64 | `win-x64/officecli.exe`，33,533,864 B |
| Node.js | 自包含发布产物，不需要额外安装 .NET/Node |

## 校验

`SHA256SUMS` 记录相对本目录的路径，服务端 `server/services/documents/binaries.ts` 在启动后首次调用时校验。
服务端调用时固定传入 `OFFICECLI_SKIP_UPDATE=1`、`OFFICECLI_NO_AUTO_INSTALL=1` 与 `OFFICECLI_NO_AUTO_RESIDENT=1`，禁止自动替换内置引擎、自行安装及启动常驻进程；升级必须按下方流程同步版本与校验值。
手工校验：

```bash
cd server/vendor/officecli
sha256sum -c SHA256SUMS
```

## 平台

- Linux x64：Linux 本机开发使用；在 Linux 上检出时通常保留执行位，若丢失需 `chmod +x`。
- Windows x64：仅本机开发使用。`binaries.ts` 在 `win32` 上自动选择该文件。
- macOS：不内置，需设置 `OFFICECLI_PATH` 指向官方 macOS 构建，否则文档工具返回 503。

## 升级

替换对应平台的二进制后，同步更新 `VERSION`、`SHA256SUMS` 和上表大小，并运行：

在仓库根目录运行 `npm run test:server`（包含 `server/tests/officecli.test.ts`）。

Windows 上传的二进制在 Git 中必须是 LF 原样，不能经过换行转换；本目录的 `.gitattributes` 已将其标记为 `binary`。
