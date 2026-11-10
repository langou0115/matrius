# Matrius Agent 服务

把模型循环从浏览器挪出来的独立 Node 进程。浏览器不再直接请求模型服务商；它把本轮消息交给这里，按 SSE 消费同样的 `ReplyUpdate` 负载。

## 运行

`agent/` 是根项目的 npm workspace，所有依赖都由根目录的 `npm ci` 安装，不需要单独 install。

```bash
npm ci          # 项目根目录，一次装好 web + agent
npm run agent   # 单进程，默认 127.0.0.1:8123
```

`npm run dev` 会连同 FastAPI、Vite 一起启动它（端口 `DEV_AGENT_PORT`，默认 8123）。

## 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `AGENT_PORT` | `8123` | 监听端口 |
| `AGENT_HOST` | `127.0.0.1` | 只监听本机；对外暴露是部署阶段的事 |
| `MATRIUS_API_URL` | `http://127.0.0.1:8000` | Python API 地址，工具与持久化都走它 |
| `COPILOTKIT_TELEMETRY_DISABLED` | 未设置 | 设置后关闭 CopilotKit 遥测 |

## 端点

| 端点 | 用途 |
| --- | --- |
| `GET /health` | 健康检查 |
| `POST /api/agent/run` | 跑一轮回复，SSE 输出 `ready/update/summary/done` |
| `POST /api/agent/steer` | 补充消息（返回 `steered` / `deferred` / `false`） |
| `POST /api/agent/stop` | 中断某个会话的运行 |
| `POST /api/agent/title` | 生成会话标题 |
| `POST /api/agent/memory` | 后台整理记忆摘要 |
| `POST /api/copilotkit/*` | CopilotKit v2 runtime，自定义 AG-UI agent |

## 边界

- **不直连 SQLite。** 消息、活动、文件都通过 Python API 读写，Python 仍是唯一写入者。
- **没有持久状态。** 运行中的会话只在这个进程的内存里；进程重启即丢失，前端会显示未完成。
- **密钥不落盘。** 模型 key 由浏览器逐次放进请求（`/api/agent/run` 的 body 或 CopilotKit `properties`），只在本轮内存中使用。
- 复用 `src/core/agent/*` 与 `src/core/llm/*`，通过 `tsx` 运行时解析 `@/` 别名。

## 容器

当前是**本机独立进程**。把它并入 API 容器（`server/Dockerfile` + `entrypoint.sh` + compose healthcheck）属于后续规划，本轮没有改动容器拓扑。
