import { ChevronDown, Pencil, Plus, Server, Trash2 } from 'lucide-react';
import { useRef, useState } from 'react';

import { Dialog } from '@/components/web/dialog';
import { SelectField } from '@/components/web/select-field.web';
import { fetchProviderCatalog, type CatalogModel } from '@/core/llm/provider-catalog.web';
import { protocols, type ProviderConfig, type ProviderModelConfig } from '@/core/llm/model-config';
import { SettingsPage } from '@/features/settings/settings-page.web';
import { useChatRuntime } from '@/features/chat/chat-runtime';
import { useModels } from './model-state';

type ProviderForm = Omit<ProviderConfig, 'models'>;
type ConfirmTarget = { name: string; id: string };

function createId(prefix: string) {
  return globalThis.crypto?.randomUUID?.() ?? `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function newProvider(): ProviderForm {
  return { id: createId('provider'), name: '', protocol: 'completion', baseUrl: protocols[0].baseUrl, requiresApiKey: true };
}

function newModel(): ProviderModelConfig {
  return { id: createId('model'), name: '', modelId: '', supportsImage: false, contextWindow: 128000, maxOutput: 4096 };
}

function errorMessage(reason: unknown) {
  return reason instanceof Error ? reason.message : '操作失败，请重试。';
}

export default function ModelSettingsScreen() {
  const models = useModels();
  const { isAnyRunning } = useChatRuntime();
  const [providerForm, setProviderForm] = useState<ProviderForm | null>(null);
  const [apiKey, setApiKey] = useState('');
  const [modelForm, setModelForm] = useState<ProviderModelConfig | null>(null);
  const [modelProviderId, setModelProviderId] = useState<string | null>(null);
  const [catalogProviderId, setCatalogProviderId] = useState<string | null>(null);
  const [availableModels, setAvailableModels] = useState<CatalogModel[]>([]);
  const [catalogFilter, setCatalogFilter] = useState('');
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [confirmTarget, setConfirmTarget] = useState<ConfirmTarget | null>(null);
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const catalogRequest = useRef(0);

  function clearMessages() { setFeedback(null); setFailure(null); }
  function setProviderExpanded(id: string, value: boolean) {
    setExpanded((previous) => (previous[id] === value ? previous : { ...previous, [id]: value }));
  }
  function editProvider(value: ProviderConfig | null) {
    clearMessages();
    if (value) setProviderExpanded(value.id, true);
    setProviderForm(value ? {
      id: value.id, name: value.name, protocol: value.protocol, baseUrl: value.baseUrl, requiresApiKey: value.requiresApiKey,
    } : newProvider());
    setApiKey(value ? models.getKey(value.id) : '');
  }
  function editModel(provider: ProviderConfig, value: ProviderModelConfig | null) {
    clearMessages();
    setProviderExpanded(provider.id, true);
    setModelProviderId(provider.id);
    setModelForm(value ? { ...value } : newModel());
  }
  function closeProviderForm() { setProviderForm(null); setApiKey(''); }
  function closeModelForm() { setModelForm(null); setModelProviderId(null); }

  async function perform(action: () => Promise<void>, message: string) {
    setSaving(true); setFailure(null); setFeedback(null);
    try { await action(); setFeedback(message); }
    catch (reason) { setFailure(errorMessage(reason)); }
    finally { setSaving(false); }
  }

  const disabled = saving || !models.ready || isAnyRunning;
  const providerFormEditing = !!providerForm && models.providers.some((item) => item.id === providerForm.id);
  const modelFormEditing = !!modelForm && !!models.providers.find((item) => item.id === modelProviderId)?.models.some((item) => item.id === modelForm.id);

  function closeCatalog() {
    catalogRequest.current += 1;
    setCatalogProviderId(null);
    setAvailableModels([]);
    setCatalogFilter('');
    setCatalogError(null);
    setCatalogLoading(false);
  }

  /** Opens the dialog first and fetches inside it, so the wait is visible where the result lands. */
  async function discover(provider: ProviderConfig) {
    clearMessages();
    const token = ++catalogRequest.current;
    setCatalogProviderId(provider.id);
    setAvailableModels([]);
    setCatalogFilter('');
    setCatalogError(null);
    setCatalogLoading(true);
    try {
      const catalog = await fetchProviderCatalog(provider, models.getKey(provider.id));
      if (catalogRequest.current !== token) return;
      setAvailableModels(catalog);
    } catch (reason) {
      if (catalogRequest.current !== token) return;
      setCatalogError(errorMessage(reason));
    } finally {
      if (catalogRequest.current === token) setCatalogLoading(false);
    }
  }

  function confirmRemoval() {
    const target = confirmTarget;
    if (!target) return;
    setConfirmTarget(null);
    if (catalogProviderId === target.id) closeCatalog();
    void perform(() => models.removeProvider(target.id), '已删除服务商及其模型配置。');
  }

  // Errors go into the dialog: the modal covers anything the page would show behind it.
  async function addCatalogModel(provider: ProviderConfig, item: CatalogModel) {
    if (provider.models.some((model) => model.modelId === item.id)) return;
    setSaving(true);
    setCatalogError(null);
    try {
      await models.saveModel(provider.id, {
        id: createId('model'), name: item.name, modelId: item.id, supportsImage: false, contextWindow: 128000, maxOutput: 4096,
      });
    } catch (reason) {
      setCatalogError(errorMessage(reason));
    } finally {
      setSaving(false);
    }
  }

  const catalogProvider = catalogProviderId ? models.providers.find((item) => item.id === catalogProviderId) ?? null : null;
  const catalogQuery = catalogFilter.trim().toLowerCase();
  const catalogMatches = catalogQuery
    ? availableModels.filter((item) => item.id.toLowerCase().includes(catalogQuery) || item.name.toLowerCase().includes(catalogQuery))
    : availableModels;

  return <SettingsPage title="模型服务" description="按服务商管理连接信息，再发现并添加要使用的模型。">
    <p className="settings-footnote">服务商、模型与 API key 仅保存在此浏览器的本地存储中，本站不会保存；清除浏览器数据或更换设备后需要重新配置。</p>
    {models.error && <p className="model-form-error" role="alert">{models.error}</p>}
    {!models.ready && !models.error && <p role="status" className="settings-footnote">正在读取模型配置…</p>}
    {isAnyRunning && <p className="settings-footnote" role="status">正在生成回复，请先停止或等待完成后再修改配置。</p>}

    <section className="settings-section" aria-labelledby="providers-heading">
      <div className="model-section-heading">
        <h2 id="providers-heading">服务商</h2>
        {models.providers.length > 0 && <button className="secondary-button" disabled={disabled} onClick={() => editProvider(null)}><Plus size={16} strokeWidth={1.75} aria-hidden="true" />添加服务商</button>}
      </div>

      {models.providers.length ? <div className="provider-list">{models.providers.map((provider) => {
        const open = expanded[provider.id] ?? false;
        const bodyId = `provider-body-${provider.id}`;
        const protocolLabel = protocols.find((item) => item.id === provider.protocol)?.label ?? provider.protocol;
        const keyStatus = provider.requiresApiKey
          ? (models.getKey(provider.id) ? '已保存 API key' : '需要 API key')
          : '无需 API key';
        return <article className="provider-card" key={provider.id}>
          <div className="provider-heading">
            {/* The row is one click target through an overlay rather than a button wrapped
                around the text: the actions cannot live inside a button, and a button that
                stops where they start leaves the hover fill and the focus ring cut in two. */}
            <button type="button" className="provider-toggle" aria-expanded={open} aria-controls={bodyId}
              aria-label={`${open ? '收起' : '展开'}${provider.name}的模型`}
              onClick={() => setProviderExpanded(provider.id, !open)} />
            <strong className="provider-name">{provider.name}</strong>
            {/* No "current model" badge here: pinned to the provider name it reads as "this
                is the current provider", and the model row already says which model it is. */}
            <span className="provider-count">{provider.models.length} 个模型</span>
            <div className="provider-heading-actions">
              <button className="secondary-button" disabled={disabled} onClick={() => void discover(provider)}>获取模型列表</button>
              <button className="secondary-button" disabled={disabled} onClick={() => editModel(provider, null)}><Plus size={15} strokeWidth={1.75} aria-hidden="true" />手动添加</button>
              <button className="icon-button" aria-label={`编辑服务商：${provider.name}`} disabled={disabled} onClick={() => editProvider(provider)}><Pencil size={17} strokeWidth={1.75} aria-hidden="true" /></button>
              <button className="icon-button danger-icon" aria-label={`删除服务商：${provider.name}`} disabled={disabled} onClick={() => setConfirmTarget({ id: provider.id, name: provider.name })}><Trash2 size={17} strokeWidth={1.75} aria-hidden="true" /></button>
            </div>
            <ChevronDown size={18} strokeWidth={1.75} className="provider-toggle-chevron" aria-hidden="true" />
            {/* Its own line across the full row: sharing a line with four buttons left it a
                column too narrow for an address, and it wrapped into three. */}
            <span className="provider-meta">{protocolLabel} · {provider.baseUrl} · {keyStatus}</span>
          </div>

          <div className="provider-body" id={bodyId} hidden={!open}>
            {provider.models.length ? <div className="provider-model-list" aria-label={`${provider.name} 的模型`}>
              {provider.models.map((model) => <div className="provider-model-item" key={model.id}>
                <div className="provider-model-info"><strong>{model.name}</strong><span>{model.modelId} · 上下文 {model.contextWindow.toLocaleString()} · 最大输出 {model.maxOutput.toLocaleString()}{model.supportsImage ? ' · 支持图片' : ''}</span></div>
                <div className="model-config-actions">
                  <button className="icon-button" aria-label={`编辑模型：${model.name}`} disabled={disabled} onClick={() => editModel(provider, model)}><Pencil size={17} strokeWidth={1.75} aria-hidden="true" /></button>
                  {/* Removing one model only drops a config row — undoable by re-adding it — so it
                      runs straight away instead of stopping at a confirmation. */}
                  <button className="icon-button danger-icon" aria-label={`删除模型：${model.name}`} disabled={disabled} onClick={() => void perform(() => models.removeModel(model.id), '已删除模型配置。')}><Trash2 size={17} strokeWidth={1.75} aria-hidden="true" /></button>
                </div>
              </div>)}
            </div> : <p className="provider-empty">还没有添加模型。</p>}
          </div>
        </article>;
      })}</div> : <div className="provider-empty-state">
        <span className="provider-empty-icon"><Server size={22} strokeWidth={1.6} aria-hidden="true" /></span>
        <strong>还没有服务商</strong>
        <p>添加服务商后，即可获取或手动添加模型。</p>
        <button className="primary-button" disabled={disabled} onClick={() => editProvider(null)}><Plus size={16} strokeWidth={1.75} aria-hidden="true" />添加服务商</button>
      </div>}
    </section>

    {failure && <p className="model-form-error" role="alert">{failure}</p>}
    {feedback && <p className="settings-footnote" role="status">{feedback}</p>}

    {providerForm && <Dialog title={providerFormEditing ? '编辑服务商' : '添加服务商'} onClose={closeProviderForm} className="model-form-dialog">
      <form className="provider-edit-form" onSubmit={(event) => {
        event.preventDefault();
        void perform(async () => {
          await models.saveProvider({ ...providerForm, models: [] }, apiKey);
          setProviderExpanded(providerForm.id, true);
          closeProviderForm();
        }, '服务商已保存。');
      }}>
        <fieldset disabled={disabled}>
          <label className="model-form-field">服务商名称<input className="text-field" value={providerForm.name} onChange={(event) => setProviderForm({ ...providerForm, name: event.target.value })} placeholder="例如：OpenAI、我的网关" required maxLength={100} /></label>
          <SelectField label="接口协议" value={providerForm.protocol} options={protocols} onChange={(id) => {
            const protocol = protocols.find((item) => item.id === id)!;
            const usingDefault = protocols.some((item) => item.baseUrl === providerForm.baseUrl);
            setProviderForm({ ...providerForm, protocol: protocol.id, baseUrl: usingDefault ? protocol.baseUrl : providerForm.baseUrl });
          }} />
          <label className="model-form-field">Base URL<input className="text-field" type="url" value={providerForm.baseUrl} onChange={(event) => setProviderForm({ ...providerForm, baseUrl: event.target.value })} placeholder="https://your-provider.example/v1" required autoCapitalize="none" spellCheck={false} /><span>填写服务商的 API 基础地址，不包含 /models、/chat/completions、/responses 或 /messages。</span></label>
          <label className="model-key-toggle"><input className="model-checkbox-input" type="checkbox" checked={providerForm.requiresApiKey} onChange={(event) => setProviderForm({ ...providerForm, requiresApiKey: event.target.checked })} /><span className="model-checkbox" aria-hidden="true" />接口需要 API key</label>
          {providerForm.requiresApiKey && <label className="model-form-field">API key<input className="text-field" type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} autoComplete="off" autoCapitalize="none" spellCheck={false} placeholder={models.getKey(providerForm.id) ? '已填写；留空保持当前 key' : '保存在此浏览器中'} /><span>与模型配置分开保存在本机浏览器，未加密；清除站点数据后需要重新填写。</span></label>}
          <div className="dialog-footer"><button type="button" className="secondary-button" onClick={closeProviderForm}>取消</button><button type="submit" className="primary-button">{saving ? '保存中…' : '保存服务商'}</button></div>
        </fieldset>
      </form>
    </Dialog>}

    {modelForm && modelProviderId && <Dialog title={modelFormEditing ? '编辑模型' : '添加模型'} onClose={closeModelForm} className="model-form-dialog">
      <form className="model-config-form" onSubmit={(event) => {
        event.preventDefault();
        void perform(async () => {
          await models.saveModel(modelProviderId, modelForm);
          closeModelForm();
        }, '模型已保存，可以返回聊天开始对话。');
      }}>
        <fieldset disabled={disabled}>
          <label className="model-form-field">显示名称<input className="text-field" value={modelForm.name} onChange={(event) => setModelForm({ ...modelForm, name: event.target.value })} placeholder="例如：日常对话" required maxLength={100} /></label>
          <label className="model-form-field">模型 ID<input className="text-field" value={modelForm.modelId} onChange={(event) => setModelForm({ ...modelForm, modelId: event.target.value })} placeholder="服务商返回的准确模型 ID" required autoCapitalize="none" spellCheck={false} /></label>
          <label className="model-key-toggle model-image-toggle"><input className="model-checkbox-input" type="checkbox" checked={modelForm.supportsImage} onChange={(event) => setModelForm({ ...modelForm, supportsImage: event.target.checked })} /><span className="model-checkbox" aria-hidden="true" /><span className="model-toggle-copy"><strong>支持图片输入</strong><small>仅在服务商和该模型本身支持视觉输入时开启。</small></span></label>
          <div className="model-form-columns">
            <label className="model-form-field">上下文窗口<input className="text-field" type="number" min={512} step={1} value={modelForm.contextWindow} onChange={(event) => setModelForm({ ...modelForm, contextWindow: Number(event.target.value) })} required /></label>
            <label className="model-form-field">最大输出 tokens<input className="text-field" type="number" min={1} step={1} value={modelForm.maxOutput} onChange={(event) => setModelForm({ ...modelForm, maxOutput: Number(event.target.value) })} required /></label>
          </div>
          <div className="dialog-footer"><button type="button" className="secondary-button" onClick={closeModelForm}>取消</button><button type="submit" className="primary-button">{saving ? '保存中…' : '保存模型'}</button></div>
        </fieldset>
      </form>
    </Dialog>}

    {catalogProvider && <Dialog title={`${catalogProvider.name} 的模型列表`} onClose={closeCatalog} className="catalog-dialog">
      <p className="dialog-description">经本站服务器向服务商获取，勾选要用的模型加进来。</p>
      {catalogError && <p className="model-form-error" role="alert">{catalogError}</p>}
      {catalogLoading ? <p className="catalog-status" role="status">正在获取模型列表…</p> : availableModels.length ? <>
        <input className="text-field catalog-filter" type="search" value={catalogFilter} aria-label="筛选模型"
          onChange={(event) => setCatalogFilter(event.target.value)} placeholder="筛选名称或模型 ID" autoComplete="off" spellCheck={false} />
        <p className="catalog-summary" role="status">
          {catalogQuery ? `匹配 ${catalogMatches.length} / ${availableModels.length} 个模型` : `共 ${availableModels.length} 个模型`}
        </p>
        {catalogMatches.length ? <div className="catalog-list">{catalogMatches.map((item) => {
          const added = catalogProvider.models.some((model) => model.modelId === item.id);
          return <div className="catalog-item" key={item.id}>
            <div><strong>{item.name}</strong>{item.name !== item.id && <span>{item.id}</span>}</div>
            <button className="secondary-button" disabled={disabled || added} onClick={() => void addCatalogModel(catalogProvider, item)}>{added ? '已添加' : '添加'}</button>
          </div>;
        })}</div> : <p className="catalog-status" role="status">没有匹配「{catalogFilter.trim()}」的模型。</p>}
      </> : !catalogError && <p className="catalog-status" role="status">服务商没有返回模型，可以手动填写模型 ID。</p>}
      <div className="dialog-footer">
        <button className="secondary-button" disabled={disabled || catalogLoading} onClick={() => void discover(catalogProvider)}>重新获取</button>
        <button className="primary-button" onClick={closeCatalog}>完成</button>
      </div>
    </Dialog>}

    {confirmTarget && <Dialog title="删除服务商？" onClose={() => setConfirmTarget(null)} className="compact-dialog">
      <p className="dialog-description">
        “{confirmTarget.name}”及其模型配置将被删除，已有对话会保留。
      </p>
      <div className="dialog-footer">
        <button className="secondary-button" onClick={() => setConfirmTarget(null)}>取消</button>
        <button className="danger-button" disabled={disabled} onClick={confirmRemoval}>删除服务商</button>
      </div>
    </Dialog>}
  </SettingsPage>;
}
