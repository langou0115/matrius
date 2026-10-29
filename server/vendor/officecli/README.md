# OfficeCLI

文档创建/编辑引擎，来自 [iOfficeAI/OfficeCLI](https://github.com/iOfficeAI/OfficeCLI)，
使用 [Apache-2.0](https://github.com/iOfficeAI/OfficeCLI/blob/main/LICENSE) 许可。

| 项目 | 值 |
| --- | --- |
| 版本 | `1.0.153`（见 `VERSION`） |
| 来源 | `https://github.com/iOfficeAI/OfficeCLI/releases/tag/v1.0.153` |
| Linux x64 | `linux-x64/officecli`，35,416,933 B |
| Windows x64 | `win-x64/officecli.exe`，33,480,616 B |
| Node.js | 自包含发布产物，不需要额外安装 .NET/Node |

## 校验

`SHA256SUMS` 记录相对本目录的路径，服务端 `app/documents/binaries.py` 在启动后首次调用时校验。
手工校验：

```bash
cd server/vendor/officecli
sha256sum -c SHA256SUMS
```

## 平台

- Linux x64：生产 Docker 镜像与 Linux 本机开发使用；Docker 构建会 `chmod +x` 兜底（Windows 检出可能丢失执行位）。
- Windows x64：仅本机开发使用。`binaries.py` 在 `win32` 上自动选择该文件。
- macOS：不内置，需设置 `OFFICECLI_PATH` 指向官方 macOS 构建，否则文档工具返回 503。
- 生产镜像不包含 Windows 二进制（`server/.dockerignore` 排除 `win-x64`），避免镜像无谓增大。

## 升级

替换对应平台的二进制后，同步更新 `VERSION`、`SHA256SUMS` 和上表大小，并运行：

```bash
cd server && uv run --no-sync pytest tests/test_officecli.py
```

Windows 上传的二进制在 Git 中必须是 LF 原样，不能经过换行转换；本目录的 `.gitattributes` 已将其标记为 `binary`。
