# Agent、模型与工具

Agent Runtime 位于 server/agent。客户端 ui/core/agent/remote-runtime.ts 提交请求、消费 SSE、更新界面并发送 stop 和 steer。共享协议在 contract/agent-protocol.ts。

服务端负责上下文组装、模型流式传输、工具执行、压缩、标题与记忆。工具模块位于 server/agent/tools，由 Agent 注册并直接调用 server/services，旧工具 HTTP API 不再恢复。记忆编辑通过服务端 memory 接口更新或清空摘要。

模型配置与 key 仅在客户端保存，每次请求临时发送，凭据不进入业务持久化或日志。会话与消息通过业务 API 持久化。同一会话只允许一个活动运行，运行状态在进程内，刷新或重启不保证恢复。

浏览器仅保留远程通信和共享显示工具。上下文用量优先使用服务端回报，首次运行前按消息与提示词估算，不创建浏览器工具。

详见 [服务端 Agent](../server/agent/README.md) 与 [工具规范](../server/agent/tools/README.md)。真实模型、浏览器流式行为、取消与刷新持久化仍需浏览器验收。
