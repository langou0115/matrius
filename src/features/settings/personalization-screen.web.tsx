import { useEffect, useLayoutEffect, useRef, type ComponentProps } from 'react';

import { personalizationLimits } from './personalization';
import { usePersonalization } from './personalization-state';
import { SettingsPage } from './settings-page.web';
import { useIsPreview } from '@/features/workspace/preview-context';

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

export default function PersonalizationSettingsScreen() {
  const { preferences, update } = usePersonalization();
  const preview = useIsPreview();
  return <SettingsPage title="个性化" description="告诉模型你希望它如何回答，以及需要了解的个人信息。">
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
    <p className="settings-footnote">{preview ? '修改仅在本次预览中生效，刷新后重置。' : '修改会自动保存在当前浏览器中。'}填写的内容会随对话请求发送给你选择的模型服务商。</p>
  </SettingsPage>;
}
