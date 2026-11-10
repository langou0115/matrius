import { useMemo } from 'react';
import { z } from 'zod';

import { CopilotChat, CopilotKit, useComponent } from '@copilotkit/react-core/v2';
import '@copilotkit/react-core/v2/styles.css';

import { useModels } from '@/features/models/model-state';
import { Link } from '@/router';

/**
 * CopilotKit surface. The model loop runs in the agent service; this screen only sends
 * the current model selection and the user's key once per run through CopilotKit
 * `properties` (forwarded to the agent as AG-UI `forwardedProps`).
 */

const tableSchema = z.object({
  title: z.string().describe('表格标题'),
  columns: z.array(z.string()).min(1).max(8).describe('列标题'),
  rows: z.array(z.array(z.string())).min(1).max(50).describe('数据行，每行长度必须与列数一致'),
  note: z.string().optional().describe('来源、假设或说明'),
});

function ComparisonTable({ title, columns, rows, note }: z.infer<typeof tableSchema>) {
  return (
    <div style={{ margin: '12px 0', border: '1px solid var(--border)', borderRadius: 14, overflow: 'hidden' }}>
      <div style={{ padding: '12px 14px', fontWeight: 600, borderBottom: '1px solid var(--border)' }}>{title}</div>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
          <thead>
            <tr>
              {columns.map((column) => (
                <th key={column} style={{ textAlign: 'left', padding: '10px 14px', background: 'var(--soft)', fontWeight: 600 }}>
                  {column}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => (
              <tr key={index} style={{ borderTop: '1px solid var(--border)' }}>
                {columns.map((column, columnIndex) => (
                  <td key={column} style={{ padding: '10px 14px', verticalAlign: 'top' }}>{row[columnIndex] ?? ''}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {note ? <div style={{ padding: '10px 14px', fontSize: 12, color: 'var(--muted-text)' }}>{note}</div> : null}
    </div>
  );
}

const cardSchema = z.object({
  title: z.string().describe('卡片标题'),
  items: z.array(z.object({ label: z.string(), value: z.string() })).min(1).max(12).describe('键值对'),
  note: z.string().optional(),
});

function KeyValueCard({ title, items, note }: z.infer<typeof cardSchema>) {
  return (
    <div style={{ margin: '12px 0', border: '1px solid var(--border)', borderRadius: 14, padding: '14px' }}>
      <div style={{ fontWeight: 600, marginBottom: 8 }}>{title}</div>
      <dl style={{ display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: '6px 16px', margin: 0, fontSize: 14 }}>
        {items.map((item) => (
          <div key={item.label} style={{ display: 'contents' }}>
            <dt style={{ color: 'var(--muted-text)' }}>{item.label}</dt>
            <dd style={{ margin: 0 }}>{item.value}</dd>
          </div>
        ))}
      </dl>
      {note ? <div style={{ marginTop: 8, fontSize: 12, color: 'var(--muted-text)' }}>{note}</div> : null}
    </div>
  );
}

const stepsSchema = z.object({
  title: z.string(),
  steps: z.array(z.object({ title: z.string(), detail: z.string().optional() })).min(1).max(12),
});

function StepsList({ title, steps }: z.infer<typeof stepsSchema>) {
  return (
    <div style={{ margin: '12px 0', border: '1px solid var(--border)', borderRadius: 14, padding: '14px' }}>
      <div style={{ fontWeight: 600, marginBottom: 10 }}>{title}</div>
      <ol style={{ margin: 0, paddingLeft: 20, display: 'grid', gap: 8, fontSize: 14 }}>
        {steps.map((step) => (
          <li key={step.title}>
            <div style={{ fontWeight: 500 }}>{step.title}</div>
            {step.detail ? <div style={{ color: 'var(--muted-text)' }}>{step.detail}</div> : null}
          </li>
        ))}
      </ol>
    </div>
  );
}

/** Registers the components the agent may draw. Hooks must live inside the provider. */
function IntelligentUI() {
  useComponent({
    name: 'comparisonTable',
    description: '用表格对比两个及以上选项。当用户要求比较方案、产品或指标，且指标清晰时优先使用。',
    parameters: tableSchema,
    render: ComparisonTable,
  });
  useComponent({
    name: 'keyValueCard',
    description: '展示一组结论性的键值对，例如参数、结论摘要或事实清单。',
    parameters: cardSchema,
    render: KeyValueCard,
  });
  useComponent({
    name: 'stepsList',
    description: '展示有序的步骤、流程或操作指引。',
    parameters: stepsSchema,
    render: StepsList,
  });
  return null;
}

export default function CopilotScreen() {
  const models = useModels();
  const model = models.selected;
  const properties = useMemo(() => ({
    matrius: model ? {
      config: model,
      apiKey: model.requiresApiKey ? models.getKey(model.providerId) : '',
      thinkingEffort: model.thinkingEffort ?? 'low',
    } : undefined,
  }), [model, models]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: 'var(--background)', color: 'var(--foreground)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 16px', borderBottom: '1px solid var(--border)' }}>
        <Link href="/" style={{ color: 'var(--muted-text)', fontSize: 13 }}>← 返回对话</Link>
        <div style={{ fontSize: 13, color: 'var(--muted-text)' }}>
          {model ? `CopilotKit 实验页 · ${model.providerName} / ${model.name}` : 'CopilotKit 实验页'}
        </div>
      </div>
      {model ? (
        <CopilotKit runtimeUrl="/api/copilotkit" properties={properties}>
          <IntelligentUI />
          <div style={{ flex: 1, minHeight: 0 }}>
            <CopilotChat agentId="default" />
          </div>
        </CopilotKit>
      ) : (
        <div style={{ margin: 'auto', maxWidth: 420, textAlign: 'center', padding: 24 }}>
          <p style={{ fontSize: 15, marginBottom: 12 }}>还没有选择模型，CopilotKit 需要模型配置才能运行。</p>
          <Link href="/settings/models" style={{ color: 'var(--primary)' }}>前往模型服务设置</Link>
        </div>
      )}
    </div>
  );
}
