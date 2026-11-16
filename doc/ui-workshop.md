# UI 工坊

[文档索引](README.md) · [客户端结构](client-structure.md) · [后端架构](backend.md)

UI 工坊让用户用自然语言生成真正可交互的 UI 组件，发布后在普通 AI 对话中由模型调用渲染。它不需要改前端源码或重新部署：组件代码由模型写入实例数据库，前端只负责隔离运行和展示。

## 数据模型

迁移 `server/db/migrations/0002_ui_workshop.sql`：

| 表 | 作用 |
| --- | --- |
| `ui_components` | 组件元数据、草稿/发布状态、`current_version`、`published_version`、设计模式（`stateful`）、所属工坊会话 |
| `ui_component_versions` | 不可变版本快照：`html`、`input_schema`、`state_schema`、`commands`、`events`、`protocol_version` |
| `ui_component_bindings` | 有状态组件的会话实例：`conversation_id` + 锁定的 `version` + `state` + 校验用 `state_schema` |
| `ui_binding_commands` | 模型下达的命令 outbox：`pending` → `applied` / `failed` |

`messages` 新增 `ui_components JSON`，`conversations` 新增 `kind`（`chat` / `workshop`）。

不变量：

1. **版本不可变**：每次修改都新增 `version N+1`（draft），旧行永不改写。
2. **只有 published 版本能被引用**：消息和无状态/有状态渲染都钉住版本号。
3. **发布只移动指针**：`published_version` 指向哪版，新调用默认用哪版；历史消息不受影响。
4. **绑定锁旧版**：`ui_component_bindings.version` 创建时写死，发布新版本不会改变已有绑定，`state_schema` 也随版本快照固定。
5. **草稿可清理，发布版永不自动删除**：版本上限 `UI_COMPONENT_MAX_VERSIONS`（100），超出时只清理最旧的未发布草稿，草稿永远不会被消息或绑定引用。

组件代码只存一份；对话消息只存引用（`componentId` + `version`，有状态时再加 `bindingId`），所以对话数量不会放大代码存储。

## 设计模式

创建组件时用户只选择两件事：名称和是否「与对话绑定（有状态）」。这个选择写入 `ui_components.stateful`（迁移 `0003_ui_component_mode`），并约束之后的版本：

- **有状态**：版本必须声明 `stateSchema`；组件状态按对话保存在绑定里，AI 只能通过声明的命令操作。
- **展示型**：版本不能声明 `stateSchema`，数据通过 `props` 传入，每次渲染都是只读快照。

`saveVersion` 会拒绝不符合模式的定义，避免 AI 在生成时静默改变组件的绑定语义。迁移会把已有组件按其版本是否声明过 `stateSchema` 回填模式。

## 组件契约

组件是 HTML 片段，不含 doctype / html / head / body。宿主提供 `<div id="root">`，并在片段之后注入固定 bridge。

```html
<style>/* 组件样式，使用主题变量 */</style>
<script>
  function render(root, ctx) {
    // ctx.props：按 inputSchema 校验后的数据
    // ctx.state：有状态组件的持久状态
    // ctx.theme：主题色
  }
  function onCommand(name, payload, ctx) {
    // 有状态组件声明 commands 后实现
    return { ok: true, state: nextState };
  }
</script>
```

bridge 暴露 `window.MatriusUI`：

| API | 作用 |
| --- | --- |
| `setState(state)` | 上报完整新状态；宿主校验后写入绑定 |
| `emit(name, payload)` | 上报交互事件；声明的 `toAgent` 事件可在对话中「交给 AI」 |
| `commandResult(id, result)` | bridge 自动调用，组件通常不需要直接使用 |
| `resize()` | 上报高度；`ResizeObserver` 已自动处理 |

规则：不能访问网络/CDN/外部字体、不能用 `localStorage`/cookie、不能用 `eval`/`new Function`、不要写死页面高度。样式使用 `--matrius-background`、`--matrius-foreground`、`--matrius-card`、`--matrius-muted`、`--matrius-muted-foreground`、`--matrius-border`、`--matrius-primary`。

## 运行时隔离

`contract/ui-component.ts` 的 `composeUiComponentDocument` 负责拼装文档：

- iframe `sandbox="allow-scripts"`，**没有** `allow-same-origin`：不透明源，组件拿不到父页面 DOM、cookie、storage 或 token。
- 文档内 meta CSP：`default-src 'none'`、`connect-src 'none'`、`frame-src 'none'`、`form-action 'none'`、只允许内联样式/脚本与 `data:`/`blob:` 图片。`script-src` 不含 `'unsafe-eval'`，所以即使代码里出现 `eval` 也会被浏览器拒绝。
- 通信只走 `postMessage`：宿主校验 `event.source === iframe.contentWindow`，只接受白名单消息类型；组件状态由服务端按版本快照里的 `stateSchema` 校验（TypeBox `Value.Check`）、限体积、限归属。
- 组件异常、加载超时、脚本错误都由卡片降级成错误提示；iframe 崩溃不会影响聊天页其余部分。

已知残余风险：iframe 内的死循环仍可能占满同一渲染进程，sandbox 隔离不了 CPU。服务端会拒绝明显的 `while(true)` / `for(;;)` 与外部资源标签，但这不是完整保证；组件卡住时移除卡片或重新生成。

## 数据流

### 工坊生成与修改

```
工坊页 → POST /api/agent/runs { scope:'workshop', uiComponentId, tools:{ui:true} }
服务端 → 系统提示 = 工具规范 + 当前组件摘要（名称/版本/schema/已声明命令）
模型 → ui_component { action:'update', html, inputSchema, stateSchema?, commands?, events? }
服务端 → 事务写入新 draft 版本（版本上限内），更新 current_version
SSE   → ReplyUpdate.uiComponentChange
工坊页 → 刷新详情与最新版本 → iframe 重绘预览
```

每次 `update` 提交完整 `html`，不做增量补丁。

### 发布

`POST /api/ui/components/:id/publish { version, baseRevision }` 把该版本标为 published 并移动 `published_version`。已有消息和绑定继续使用原版本。

### 普通对话调用

```
聊天 → tools:{ui:true}（功能开启且存在已发布组件时才注册该工具）
服务端 → 系统提示附加已发布组件目录（id/名称/说明/版本/props 字段/是否有状态）
模型 → ui_component { action:'render', componentId, props }（展示型）
       ui_component { action:'open', componentId, props }（有状态，创建绑定）
       ui_component { action:'command', bindingId, commandName, payload }
       ui_component { action:'read_state', bindingId }
服务端 → 校验已发布、版本、props Schema、绑定归属与命令声明
SSE   → ReplyUpdate.uiComponents（artifact）/ commandIds
聊天页 → 卡片加载版本或绑定 → iframe 渲染；状态回写走 PATCH 接口
```

有状态组件的历史消息显示**当前状态**（不是当时的快照）；AI 只能发命令，由组件自己裁决合法性并上报新状态，避免模型直接写出非法状态。

### 历史恢复与降级

消息里的 `ui_components` 随消息持久化。刷新后：无状态组件按 `componentId@version` 取版本内容；有状态组件按 `bindingId` 取绑定当前状态与待执行命令。组件被归档、版本缺失、功能关闭、iframe 超时都会显示降级卡片，不影响其他消息。

## 接口

```text
GET    /api/ui/components?q=
POST   /api/ui/components
GET    /api/ui/components/:id
PATCH  /api/ui/components/:id
DELETE /api/ui/components/:id?baseRevision=
POST   /api/ui/components/:id/publish
GET    /api/ui/components/:id/latest
GET    /api/ui/components/:id/versions/:version
GET    /api/ui/bindings/:id
POST   /api/ui/bindings/:id/state
POST   /api/ui/bindings/:id/commands/:commandId/result
```

所有接口在 `ui_workshop` 功能开启时可用，未开启返回 `403 feature_unavailable`。

## 页面

- `/ui` 是组件库：进入页面直接看到组件卡片（名称、描述、状态、版本、更新时间），顶部只有搜索与「新建组件」，没有欢迎页、品牌大标题或分割线。
- `/ui/:componentId` 是构建工作台：左侧 AI 对话、右侧实时预览；顶部返回组件库，并集中放重命名、删除、发布。移动端改为「对话 / 预览」两个标签页。
- 新建组件只弹一个表单：填写名称并选择是否「与对话绑定（有状态）」，创建后进入工作台；需求在对话里描述，创建过程不会自动发送消息。
- 工坊对话的输入框直接复用主对话的 `Composer`：附件上传、模型与思考强度、停止生成、生成中追加（steer）都与普通对话一致。
- 工坊会话复用 `conversations`（`kind='workshop'`）与 `messages` 表，不出现在聊天侧栏；对话记录用于多轮修改的上下文。
- 预览与对话共用 `UiComponentFrame`；预览中的状态只存在页面内存，不写绑定。

## 模块

| 位置 | 职责 |
| --- | --- |
| `contract/ui-component.ts` | 类型、协议常量、文档拼装、bootstrap、目录文本 |
| `server/db/repositories/ui-components.ts` | 组件/版本/绑定/命令的数据访问 |
| `server/services/ui-components.ts` | 校验、发布、渲染解析、目录与命令规则 |
| `server/routes/ui-components.ts` | REST 接口 |
| `server/agent/tools/ui/*` | `ui_component` 工具与提示词 |
| `ui/core/api/ui-components.ts` | 客户端接口 |
| `ui/features/chat/components/ui-component-frame.tsx` | 沙箱宿主与 postMessage 桥 |
| `ui/features/chat/components/ui-component-card.tsx` | 对话内卡片、状态持久化、事件回传 |
| `ui/features/ui-workshop/*` | 工坊页面、对话运行时与组件会话 |

## 已知限制

- 有状态绑定不自动升级到新版本；需要后续提供显式升级和状态迁移。
- 命令是异步的：模型发出命令后要等组件回传结果，下一轮才能看到新局面。
- 无状态组件的 `props` 存在消息里，同一条数据在多个回复中会各存一份（单条上限 64KB）。
- AI 首次生成的组件可能需要 1–2 轮修复；预览错误可直接「让 AI 修复」。
- 真实模型行为、iframe 在目标浏览器的表现与刷新恢复需要在 `npm run dev` 下人工验收。

## 验证

```bash
npm run typecheck:server
npx tsc --noEmit
npx tsx --test --test-concurrency=1 server/tests/ui-workshop.test.ts
npm run test
npm run test:server
```

`server/tests/ui-workshop.test.ts` 覆盖版本/发布/目录、绑定状态校验、命令生命周期、消息 artifact 持久化与归档；`tests/ui-component.test.mjs` 覆盖 CSP/文档拼装、artifact 校验与目录文本。
