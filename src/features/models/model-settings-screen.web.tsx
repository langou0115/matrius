import { useState } from 'react';

import { Icon } from '@/components/web/icon';
import { fetchProviderCatalog, type CatalogModel } from '@/core/llm/provider-catalog.web';
import { protocols, type ProviderConfig, type ProviderModelConfig } from '@/core/llm/model-config';
import { SettingsPage } from '@/features/settings/settings-page.web';
import { useChatRuntime } from '@/features/chat/chat-runtime';
import { useModels } from './model-state';

type ProviderForm = Omit<ProviderConfig, 'models'>;

function createId(prefix: string) {
  return globalThis.crypto?.randomUUID?.() ?? `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function newProvider(): ProviderForm {
  return { id: createId('provider'), name: '', protocol: 'completion', baseUrl: protocols[0].baseUrl, requiresApiKey: true };
}

function newModel(): ProviderModelConfig {
  return { id: createId('model'), name: '', modelId: '', contextWindow: 128000, maxOutput: 4096 };
}

function errorMessage(reason: unknown) {
  return reason instanceof Error ? reason.message : '操作失败，请重试。';
}

export default function ModelSettingsScreen() {
  const models = useModels();
  const { runningId } = useChatRuntime();
  const [providerForm, setProviderForm] = useState<ProviderForm | null>(null);
  const [apiKey, setApiKey] = useState('');
  const [modelForm, setModelForm] = useState<ProviderModelConfig | null>(null);
  const [modelProviderId, setModelProviderId] = useState<string | null>(null);
  const [catalogProviderId, setCatalogProviderId] = useState<string | null>(null);
  const [availableModels, setAvailableModels] = useState<CatalogModel[]>([]);
  const [discoveringProviderId, setDiscoveringProviderId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  function clearMessages() { setFeedback(null); setFailure(null); }
  function editProvider(value: ProviderConfig | null) {
    clearMessages();
    setProviderForm(value ? {
      id: value.id, name: value.name, protocol: value.protocol, baseUrl: value.baseUrl, requiresApiKey: value.requiresApiKey,
    } : newProvider());
    setApiKey(value ? models.getKey(value.id) : '');
  }
  function editModel(provider: ProviderConfig, value: ProviderModelConfig | null) {
    clearMessages();
    setModelProviderId(provider.id);
    setModelForm(value ? { ...value } : newModel());
  }
  async function perform(action: () => Promise<void>, message: string) {
    setSaving(true); setFailure(null); setFeedback(null);
    try { await action(); setFeedback(message); }
    catch (reason) { setFailure(errorMessage(reason)); }
    finally { setSaving(false); }
  }

  const disabled = saving || !models.ready || !!runningId;

  async function discover(provider: ProviderConfig) {
    clearMessages();
    setCatalogProviderId(provider.id);
    setAvailableModels([]);
    setDiscoveringProviderId(provider.id);
    try {
      const catalog = await fetchProviderCatalog(provider, models.getKey(provider.id));
      setAvailableModels(catalog);
      setFeedback(`已获取 ${catalog.length} 个模型，可从列表添加。`);
    } catch (reason) {
      setFailure(errorMessage(reason));
    } finally {
      setDiscoveringProviderId(null);
    }
  }

  async function addCatalogModel(provider: ProviderConfig, item: CatalogModel) {
    const existing = provider.models.find((model) => model.modelId === item.id);
    if (existing) { setFeedback(`模型 ${item.id} 已添加。`); return; }
    await perform(() => models.saveModel(provider.id, {
      id: createId('model'), name: item.name, modelId: item.id, contextWindow: 128000, maxOutput: 4096,
    }), `已添加模型 ${item.id}。`);
  }

  return <SettingsPage title="模型服务" description="按服务商管理连接信息，再发现并添加要使用的模型。">
    {models.error && <p className="model-form-error" role="alert">{models.error}</p>}
    {!models.ready && !models.error && <p role="status" className="settings-footnote">正在读取模型配置…</p>}
    {runningId && <p className="settings-footnote" role="status">正在生成回复，请先停止或等待完成后再修改配置。</p>}

    <section className="settings-section" aria-labelledby="providers-heading">
      <div className="model-section-heading">
        <div><h2 id="providers-heading">服务商</h2><p className="settings-footnote">一个服务商配置可以包含多个模型。</p></div>
        <button className="secondary-button" disabled={disabled} onClick={() => editProvider(null)}><Icon name="plus" size={16} />添加服务商</button>
      </div>

      {models.providers.length ? <div className="provider-list">{models.providers.map((provider) => {
        const isDiscovering = discoveringProviderId === provider.id;
        const catalogVisible = catalogProviderId === provider.id;
        return <article className="provider-card" key={provider.id}>
          <div className="provider-heading">
            <div className="provider-info">
              <strong>{provider.name}</strong>
              <span>{protocols.find((item) => item.id === provider.protocol)?.label} · {provider.baseUrl}</span>
              <span>{provider.requiresApiKey ? (models.getKey(provider.id) ? '本次会话已填写 API key' : '需要 API key；刷新后需重新填写') : '无需 API key'}</span>
            </div>
            <div className="provider-actions">
              <button className="secondary-button" disabled={disabled || isDiscovering} onClick={() => void discover(provider)}>
                {isDiscovering ? '获取中…' : '获取模型列表'}
              </button>
              <button className="secondary-button" disabled={disabled} onClick={() => editModel(provider, null)}><Icon name="plus" size={15} />手动添加</button>
              <button className="icon-button" aria-label={`编辑服务商：${provider.name}`} disabled={disabled} onClick={() => editProvider(provider)}><Icon name="pen" size={17} /></button>
              <button className="icon-button" aria-label={`删除服务商：${provider.name}`} disabled={disabled} onClick={() => {
                if (window.confirm(`删除服务商“${provider.name}”及其模型配置？已有对话会保留。`)) {
                  void perform(() => models.removeProvider(provider.id), '已删除服务商及其模型配置。');
                }
              }}><Icon name="trash" size={17} /></button>
            </div>
          </div>

          {provider.models.length ? <div className="provider-model-list" aria-label={`${provider.name} 的模型`}>
            {provider.models.map((model) => <div className="provider-model-item" key={model.id}>
              <div className="provider-model-info"><strong>{model.name}</strong><span>{model.modelId} · 上下文 {model.contextWindow.toLocaleString()} · 最大输出 {model.maxOutput.toLocaleString()}</span></div>
              <div className="model-config-actions">
                <button className="secondary-button" disabled={disabled || models.selectedId === model.id} onClick={() => void perform(() => models.select(model.id), '已切换当前模型。')}>
                  {models.selectedId === model.id ? '当前模型' : '使用'}
                </button>
                <button className="icon-button" aria-label={`编辑模型：${model.name}`} disabled={disabled} onClick={() => editModel(provider, model)}><Icon name="pen" size={17} /></button>
                <button className="icon-button" aria-label={`删除模型：${model.name}`} disabled={disabled} onClick={() => {
                  if (window.confirm(`删除模型配置“${model.name}”？已有对话会保留。`)) void perform(() => models.removeModel(model.id), '已删除模型配置。');
                }}><Icon name="trash" size={17} /></button>
              </div>
            </div>)}
          </div> : <p className="provider-empty">还没有添加模型。获取模型列表，或手动填写模型 ID。</p>}

          {catalogVisible && <div className="provider-catalog">
            <div className="provider-catalog-heading"><strong>服务商模型目录</strong><span>{availableModels.length ? `${availableModels.length} 个模型` : isDiscovering ? '正在获取…' : '未获取到模型'}</span></div>
            {availableModels.length > 0 && <div className="provider-catalog-list">{availableModels.map((item) => {
              const added = provider.models.some((model) => model.modelId === item.id);
              return <div className="provider-catalog-item" key={item.id}>
                <div><strong>{item.name}</strong>{item.name !== item.id && <span>{item.id}</span>}</div>
                <button className="secondary-button" disabled={disabled || added} onClick={() => void addCatalogModel(provider, item)}>{added ? '已添加' : '添加'}</button>
              </div>;
            })}</div>}
          </div>}
        </article>;
      })}</div> : <p className="settings-footnote">还没有配置服务商。添加服务商后即可获取或手动添加模型。</p>}
    </section>

    {providerForm && <form className="provider-edit-form settings-section" onSubmit={(event) => {
      event.preventDefault();
      void perform(async () => {
        await models.saveProvider({ ...providerForm, models: [] }, apiKey);
        setProviderForm(null); setApiKey('');
      }, '服务商已保存。');
    }}>
      <h2>{models.providers.some((item) => item.id === providerForm.id) ? '编辑服务商' : '添加服务商'}</h2>
      <fieldset disabled={disabled}>
        <label className="model-form-field">服务商名称<input className="text-field" value={providerForm.name} onChange={(event) => setProviderForm({ ...providerForm, name: event.target.value })} placeholder="例如：OpenAI、我的网关" required maxLength={100} /></label>
        <label className="model-form-field">接口协议<select className="text-field" value={providerForm.protocol} onChange={(event) => {
          const protocol = protocols.find((item) => item.id === event.target.value)!;
          const usingDefault = protocols.some((item) => item.baseUrl === providerForm.baseUrl);
          setProviderForm({ ...providerForm, protocol: protocol.id, baseUrl: usingDefault ? protocol.baseUrl : providerForm.baseUrl });
        }}>{protocols.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
        <label className="model-form-field">Base URL<input className="text-field" type="url" value={providerForm.baseUrl} onChange={(event) => setProviderForm({ ...providerForm, baseUrl: event.target.value })} placeholder="https://your-provider.example/v1" required autoCapitalize="none" spellCheck={false} /><span>填写服务商的 API 基础地址，不包含 /models、/chat/completions、/responses 或 /messages。</span></label>
        <label className="model-key-toggle"><input type="checkbox" checked={providerForm.requiresApiKey} onChange={(event) => setProviderForm({ ...providerForm, requiresApiKey: event.target.checked })} />接口需要 API key</label>
        {providerForm.requiresApiKey && <label className="model-form-field">API key<input className="text-field" type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} autoComplete="off" autoCapitalize="none" spellCheck={false} placeholder={models.getKey(providerForm.id) ? '已填写；留空保持当前 key' : '仅保留在当前页面会话中'} /><span>仅保存在内存中，不写入浏览器数据库；刷新或关闭页面后需重新填写。</span></label>}
        <div className="dialog-footer"><button type="button" className="secondary-button" onClick={() => { setProviderForm(null); setApiKey(''); }}>取消</button><button type="submit" className="primary-button">{saving ? '保存中…' : '保存服务商'}</button></div>
      </fieldset>
    </form>}

    {modelForm && modelProviderId && <form className="model-config-form settings-section" onSubmit={(event) => {
      event.preventDefault();
      void perform(async () => {
        await models.saveModel(modelProviderId, modelForm);
        setModelForm(null); setModelProviderId(null);
      }, '模型已保存，可以返回聊天开始对话。');
    }}>
      <h2>{models.providers.find((item) => item.id === modelProviderId)?.models.some((item) => item.id === modelForm.id) ? '编辑模型' : '添加模型'}</h2>
      <fieldset disabled={disabled}>
        <label className="model-form-field">显示名称<input className="text-field" value={modelForm.name} onChange={(event) => setModelForm({ ...modelForm, name: event.target.value })} placeholder="例如：日常对话" required maxLength={100} /></label>
        <label className="model-form-field">模型 ID<input className="text-field" value={modelForm.modelId} onChange={(event) => setModelForm({ ...modelForm, modelId: event.target.value })} placeholder="服务商返回的准确模型 ID" required autoCapitalize="none" spellCheck={false} /></label>
        <div className="model-form-columns">
          <label className="model-form-field">上下文窗口<input className="text-field" type="number" min={512} step={1} value={modelForm.contextWindow} onChange={(event) => setModelForm({ ...modelForm, contextWindow: Number(event.target.value) })} required /></label>
          <label className="model-form-field">最大输出 tokens<input className="text-field" type="number" min={1} step={1} value={modelForm.maxOutput} onChange={(event) => setModelForm({ ...modelForm, maxOutput: Number(event.target.value) })} required /></label>
        </div>
        <div className="dialog-footer"><button type="button" className="secondary-button" onClick={() => { setModelForm(null); setModelProviderId(null); }}>取消</button><button type="submit" className="primary-button">{saving ? '保存中…' : '保存模型'}</button></div>
      </fieldset>
    </form>}

    {failure && <p className="model-form-error" role="alert">{failure}</p>}
    {feedback && <p className="settings-footnote" role="status">{feedback}</p>}
    <p className="settings-footnote">模型请求及目录获取会直接发送至你填写的服务商地址。部分服务商不允许浏览器跨域请求；这种情况下可以手动添加模型 ID。</p>
  </SettingsPage>;
}
