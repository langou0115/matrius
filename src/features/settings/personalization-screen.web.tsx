import { AlertCircle, Globe2, LoaderCircle } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState, type ComponentProps } from 'react';

import { Icon } from '@/components/web/icon';
import { SelectField } from '@/components/web/select-field.web';
import { useNetworkTools } from '@/features/auth/network-tools-state.web';
import { ModelIcon } from '@/features/chat/components/model-icon.web';
import { useModels } from '@/features/models/model-state';
import { personalizationLimits } from './personalization';
import { usePersonalization } from './personalization-state';
import { SettingsPage } from './settings-page.web';

function fitTextarea(element: HTMLTextAreaElement) {
  element.style.height = 'auto';
  element.style.height = `${element.scrollHeight + element.offsetHeight - element.clientHeight}px`;
}

function AutoSizeTextarea(props: ComponentProps<'textarea'>) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => { if (ref.current) fitTextarea(ref.current); }, [props.value]);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    let width = element.getBoundingClientRect().width;
    const observer = new ResizeObserver(() => {
      const nextWidth = element.getBoundingClientRect().width;
      if (nextWidth === width) return;
      width = nextWidth;
      fitTextarea(element);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return <span className={`${props.className ?? ''} personalization-textarea-frame`}>
    <textarea {...props} className="personalization-textarea" ref={ref} />
  </span>;
}

function WebToolsSection() {
  const { enabled, ready, saving, error, setEnabled } = useNetworkTools();
  const busy = !ready || saving;
  return <section className="settings-section" aria-labelledby="other-settings-heading">
    <h2 id="other-settings-heading">其他设置</h2>
    <div className="account-list">
      <label className="account-row account-toggle-row">
        <span className="account-row-icon"><Globe2 size={19} strokeWidth={1.75} aria-hidden="true" /></span>
        <span className="account-row-copy">
          <strong>网页搜索</strong>
          <span className="account-row-description">允许助手搜索网页并读取正文，回答时附上来源。关闭后只使用模型已有知识。</span>
        </span>
        {busy && <LoaderCircle className="login-spinner account-row-spinner" size={16} strokeWidth={2} aria-hidden="true" />}
        <input className="model-checkbox-input" type="checkbox" checked={enabled} disabled={busy}
          onChange={(event) => void setEnabled(event.target.checked)} />
        <span className="account-switch" aria-hidden="true" />
      </label>
    </div>
    {error && <p className="account-message is-error" role="alert">
      <AlertCircle size={16} strokeWidth={1.75} aria-hidden="true" />
      <span>{error}</span>
    </p>}
  </section>;
}

export default function PersonalizationSettingsScreen() {
  const { preferences, update } = usePersonalization();
  const models = useModels();
  const [modelError, setModelError] = useState<string | null>(null);
  return <SettingsPage title="个性化" description="告诉模型你希望它如何回答，以及需要了解的个人信息。">
    <section className="settings-section" aria-labelledby="title-model-heading">
      <h2 id="title-model-heading">对话标题</h2>
      <div className="personalization-fields">
        <SelectField
          label="标题生成模型"
          value={models.titleModelId ?? ''}
          disabled={!models.ready}
          options={[
            { id: '', label: '跟随当前对话模型', icon: <Icon name="model" size={16} /> },
            ...models.models.map((model) => ({
              id: model.id,
              label: `${model.name} · ${model.providerName}`,
              icon: <ModelIcon modelId={model.modelId} name={model.name} providerName={model.providerName} size={16} />,
            })),
          ]}
          onChange={(id) => {
            setModelError(null);
            void models.setTitleModelId(id || null).catch(() => setModelError('标题模型设置未能保存，请重试。'));
          }}
        />
      </div>
      {modelError && <p className="settings-footnote" role="alert">{modelError}</p>}
    </section>
    <section className="settings-section" aria-labelledby="instructions-heading">
      <h2 id="instructions-heading">自定义指令</h2>
      <div className="personalization-fields">
        <label className="personalization-field" htmlFor="custom-instructions"><span>你希望模型如何回复？</span>
          <AutoSizeTextarea id="custom-instructions" className="text-field" rows={1} maxLength={personalizationLimits.customInstructions} value={preferences.customInstructions}
            placeholder="例如：优先用中文回答，先给结论再解释；提供代码时附上简短注释。" onChange={(event) => update({ customInstructions: event.target.value })} />
          <small>{preferences.customInstructions.length.toLocaleString()} / {personalizationLimits.customInstructions.toLocaleString()}</small>
        </label>
      </div>
    </section>
    <section className="settings-section" aria-labelledby="profile-heading">
      <h2 id="profile-heading">关于你</h2>
      <div className="personalization-fields">
        <label className="personalization-field" htmlFor="about-name"><span>如何称呼你</span><input id="about-name" className="text-field" maxLength={personalizationLimits.aboutName} value={preferences.aboutName} placeholder="你希望模型使用的称呼" onChange={(event) => update({ aboutName: event.target.value })} /></label>
        <label className="personalization-field" htmlFor="occupation"><span>职业</span><input id="occupation" className="text-field" maxLength={personalizationLimits.occupation} value={preferences.occupation} placeholder="例如：软件工程师、设计师、学生" onChange={(event) => update({ occupation: event.target.value })} /></label>
        <label className="personalization-field" htmlFor="about-more"><span>更多关于你</span><AutoSizeTextarea id="about-more" className="text-field" rows={1} maxLength={personalizationLimits.aboutMore} value={preferences.aboutMore} placeholder="可填写你的兴趣、背景或需要模型考虑的其他信息。" onChange={(event) => update({ aboutMore: event.target.value })} /><small>{preferences.aboutMore.length.toLocaleString()} / {personalizationLimits.aboutMore.toLocaleString()}</small></label>
      </div>
    </section>
    <WebToolsSection />
  </SettingsPage>;
}
