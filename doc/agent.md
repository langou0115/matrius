# Agent、模型与工具

Agent Runtime 位于 server/agent。客户端 ui/core/api/agent-runs.ts 提交请求、消费 SSE、更新界面并发送 stop 和 steer；标题与记忆的后台请求在 ui/core/api/agent-aux.ts。共享协议与两端共用的纯逻辑在 contract/agent-*.ts：wire 类型在 agent-protocol.ts，上下文组装与 token 估算在 agent-context.ts，系统提示在 agent-prompt.ts，记忆、标题、压缩的纯逻辑分别在 agent-memory.ts、agent-title.ts、agent-compaction.ts，Provider 校验与模型映射在 agent-provider.ts。

服务端负责上下文组装、模型流式传输、工具执行、压缩、标题与记忆。工具模块位于 server/agent/tools，由 Agent 注册并直接调用 server/services，旧工具 HTTP API 不再恢复。记忆编辑通过服务端 memory 接口更新或清空摘要。UI 工坊通过 `ui_component` 工具调用：工坊运行（`scope: 'workshop'`）可写组件版本，普通对话只渲染已发布组件；组件目录与当前编辑目标由工具的 `dynamicPrompt` 注入。

模型配置与 key 仅在客户端保存，每次请求临时发送，凭据不进入业务持久化或日志。会话与消息通过业务 API 持久化。同一会话只允许一个活动运行，运行状态在进程内，刷新或重启不保证恢复。

浏览器仅保留远程通信和共享显示工具。上下文用量优先使用服务端回报，首次运行前用 `contract/agent-context.ts` 的同一套估算函数计算，不创建浏览器工具。

详见 [服务端 Agent](../server/agent/README.md) 与 [工具规范](../server/agent/tools/README.md)。真实模型、浏览器流式行为、取消与刷新持久化仍需浏览器验收。
