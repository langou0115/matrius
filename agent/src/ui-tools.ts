import type { AgentTool } from '@mariozechner/pi-agent-core';
import { Type } from 'typebox';
import { uiSchemas, type UiName } from './core/ui-contract';

const text = Type.String({ maxLength: 2000 });
const title = Type.String({ maxLength: 300 });
export const uiParameters = {
  comparisonTable: Type.Object({ title, columns: Type.Array(title, { minItems: 1, maxItems: 8 }), rows: Type.Array(Type.Array(text, { maxItems: 8 }), { maxItems: 50 }), note: Type.Optional(text) }),
  keyValueCard: Type.Object({ title, items: Type.Array(Type.Object({ label: title, value: text }), { minItems: 1, maxItems: 12 }), note: Type.Optional(text) }),
  stepsList: Type.Object({ title, steps: Type.Array(Type.Object({ title, detail: Type.Optional(text) }), { minItems: 1, maxItems: 12 }) }),
  generateSandboxedUi: Type.Object({ initialHeight: Type.Integer({ minimum: 160, maximum: 1200 }), placeholderMessages: Type.Array(title, { maxItems: 5 }), css: Type.String({ maxLength: 50000 }), html: Type.String({ maxLength: 100000 }), jsFunctions: Type.String({ maxLength: 50000 }), jsExpressions: Type.String({ maxLength: 50000 }) }),
};
export const uiPrompt = '当可视化更有帮助时调用 UI 工具：comparisonTable 对比表格，keyValueCard 摘要卡片，stepsList 操作步骤。计算器、图表、图解或模拟器使用 generateSandboxedUi。不要只用文字描述你可以创建 UI，直接调用工具。动态 UI 必须自包含，禁止外部依赖或网络请求。按 initialHeight、placeholderMessages、css、html、jsFunctions、jsExpressions 顺序输出。脚本在隔离 iframe 内运行；按钮可调用 window.matrius.sendPrompt({text}) 提交带当前选值的后续问题。CSS 放 css，HTML 不含 script，函数放 jsFunctions，初始化放 jsExpressions；不要使用顶层 await。产物为独立快照，后续调用不能修改之前的 UI。';

export function createUiTools(): AgentTool[] {
  return (Object.keys(uiParameters) as UiName[]).map(name => ({
    name, label: name, description: name === 'generateSandboxedUi' ? '生成自包含的交互 UI：图表、计算器、图解、模拟器。' : `显示 ${name} 原生组件。`,
    parameters: uiParameters[name],
    async execute(_id, args) {
      const parsed = uiSchemas[name].safeParse(args);
      return parsed.success
        ? { content: [{ type: 'text' as const, text: 'UI 已显示。' }], details: {} }
        : { content: [{ type: 'text' as const, text: '参数无效，请按工具 schema 修正后重新调用。' }], details: {} };
    },
  }));
}
