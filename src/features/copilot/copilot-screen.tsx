import { useMemo } from 'react';
import { uiSchemas } from '@agent/core/ui-contract';
import { UiArtifacts } from './ui-artifacts';

import { CopilotChat, CopilotKit, useComponent, useAgent } from '@copilotkit/react-core/v2';
import '@copilotkit/react-core/v2/styles.css';

import { FeatureGate } from '@/features/instance/instance-state';
import { useModels } from '@/features/models/model-state';
import { Link } from '@/router';

/**
 * CopilotKit surface. The model loop runs in the agent service; this screen only sends
 * the current model selection and the user's key once per run through CopilotKit
 * `properties` (forwarded to the agent as AG-UI `forwardedProps`).
 */

function IntelligentUI() {
  const { agent } = useAgent();
  const onPrompt = (text: string) => {
    agent.addMessage({ id: crypto.randomUUID(), role: 'user', content: text });
    void agent.runAgent();
  };
  useComponent({ name: 'comparisonTable', description: 'Show a comparison table.', parameters: uiSchemas.comparisonTable,
    render: props => <UiArtifacts artifacts={[{ id: 'table', name: 'comparisonTable', props }]} /> });
  useComponent({ name: 'keyValueCard', description: 'Show a summary card.', parameters: uiSchemas.keyValueCard,
    render: props => <UiArtifacts artifacts={[{ id: 'card', name: 'keyValueCard', props }]} /> });
  useComponent({ name: 'stepsList', description: 'Show ordered steps.', parameters: uiSchemas.stepsList,
    render: props => <UiArtifacts artifacts={[{ id: 'steps', name: 'stepsList', props }]} /> });
  useComponent({ name: 'generateSandboxedUi', description: 'Generate an interactive diagram, calculator or chart.', parameters: uiSchemas.generateSandboxedUi,
    render: props => <UiArtifacts artifacts={[{ id: 'sandbox', name: 'generateSandboxedUi', props }]} onPrompt={onPrompt} /> });
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
        <FeatureGate name="generative-ui"><CopilotKit runtimeUrl="/api/copilotkit" properties={properties}>
          <IntelligentUI />
          <div style={{ flex: 1, minHeight: 0 }}>
            <CopilotChat agentId="default" />
          </div>
        </CopilotKit></FeatureGate>
      ) : (
        <div style={{ margin: 'auto', maxWidth: 420, textAlign: 'center', padding: 24 }}>
          <p style={{ fontSize: 15, marginBottom: 12 }}>还没有选择模型，CopilotKit 需要模型配置才能运行。</p>
          <Link href="/settings/models" style={{ color: 'var(--primary)' }}>前往模型服务设置</Link>
        </div>
      )}
    </div>
  );
}
