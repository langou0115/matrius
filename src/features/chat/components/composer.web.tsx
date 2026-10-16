import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';

import type { ThinkingEffort } from '@/core/agent/thinking-effort';
import { Icon } from '@/components/web/icon';
import { useModels } from '@/features/models/model-state';
import { useChatRuntime } from '../chat-runtime';
import { useChat } from '../chat-state';

type Props = {
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  thinkingEffort: ThinkingEffort;
  onThinkingEffortChange: (value: ThinkingEffort) => void;
};

// Labels are written out rather than derived from the value: the stored identifiers stay
// English, but everything the picker prints is Chinese.
const effortOptions: { value: ThinkingEffort; label: string; description: string }[] = [
  { value: 'default', label: '默认', description: '使用模型默认设置' },
  { value: 'low', label: '低', description: '更快响应，较少推理' },
  { value: 'medium', label: '中', description: '平衡响应速度与推理深度' },
  { value: 'high', label: '高', description: '适合复杂任务的深入推理' },
];

export function Composer({ value, onChange, onSend, thinkingEffort, onThinkingEffortChange }: Props) {
  const input = useRef<HTMLTextAreaElement>(null);
  const composing = useRef(false);
  const [showModels, setShowModels] = useState(false);
  const [pickerPage, setPickerPage] = useState<'models' | 'thinking'>('models');
  const [pickerPosition, setPickerPosition] = useState<{ left: number; bottom: number; width: number; maxHeight: number } | null>(null);
  const pickerTrigger = useRef<HTMLButtonElement>(null);
  const pickerPopover = useRef<HTMLDivElement>(null);
  const selectedModelOption = useRef<HTMLButtonElement>(null);
  const selectedEffortOption = useRef<HTMLButtonElement>(null);
  const models = useModels();
  const runtime = useChatRuntime();
  const { activeId } = useChat();
  const running = runtime.runningId !== null && runtime.runningId === activeId;
  const blocked = runtime.runningId !== null;
  const effortLabel = effortOptions.find((option) => option.value === thinkingEffort)?.label ?? '';
  const [modelError, setModelError] = useState<string | null>(null);

  useEffect(() => {
    if (!showModels) return;

    function updatePosition() {
      const trigger = pickerTrigger.current;
      if (!trigger) return;
      const bounds = trigger.getBoundingClientRect();
      const viewportWidth = document.documentElement.clientWidth;
      const viewportHeight = window.visualViewport?.height ?? window.innerHeight;
      const width = Math.min(280, Math.max(0, viewportWidth - 24));
      const left = Math.max(12, Math.min(bounds.left, viewportWidth - width - 12));
      const nextPosition = {
        left,
        bottom: viewportHeight - bounds.top + 8,
        width,
        maxHeight: Math.max(120, bounds.top - 20),
      };
      setPickerPosition((current) => current && current.left === nextPosition.left && current.bottom === nextPosition.bottom && current.width === nextPosition.width && current.maxHeight === nextPosition.maxHeight
        ? current
        : nextPosition);
    }

    function dismissOnOutsidePointer(event: PointerEvent) {
      if (!(event.target instanceof Node)) return;
      if (pickerTrigger.current?.contains(event.target) || pickerPopover.current?.contains(event.target)) return;
      setShowModels(false);
      setPickerPage('models');
    }

    function dismissOnEscape(event: KeyboardEvent) {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      if (pickerPage === 'thinking') {
        setPickerPage('models');
        return;
      }
      setShowModels(false);
      setPickerPage('models');
      pickerTrigger.current?.focus();
    }

    updatePosition();
    document.addEventListener('pointerdown', dismissOnOutsidePointer);
    document.addEventListener('keydown', dismissOnEscape);
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    window.visualViewport?.addEventListener('resize', updatePosition);
    window.visualViewport?.addEventListener('scroll', updatePosition);
    return () => {
      document.removeEventListener('pointerdown', dismissOnOutsidePointer);
      document.removeEventListener('keydown', dismissOnEscape);
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
      window.visualViewport?.removeEventListener('resize', updatePosition);
      window.visualViewport?.removeEventListener('scroll', updatePosition);
    };
  }, [pickerPage, showModels]);

  useEffect(() => {
    if (!showModels || !pickerPosition) return;
    if (pickerPage === 'thinking') selectedEffortOption.current?.focus({ preventScroll: true });
    else selectedModelOption.current?.focus({ preventScroll: true });
  }, [pickerPage, pickerPosition, showModels, thinkingEffort]);

  useEffect(() => {
    const element = input.current;
    if (!element) return;
    element.style.height = 'auto';
    element.style.height = `${Math.min(192, Math.max(58, element.scrollHeight))}px`;
  }, [value]);

  function submit() {
    if (!value.trim() || blocked) return;
    onSend();
    input.current?.focus();
  }

  async function selectModel(id: string) {
    try {
      await models.select(id);
      setModelError(null);
      setShowModels(false);
      setPickerPage('models');
      pickerTrigger.current?.focus();
    } catch {
      setModelError('切换模型失败，请刷新后重试。');
    }
  }

  function handleModelMenuKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    const options = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[data-picker-option]:not(:disabled)'));
    if (!options.length) return;
    event.preventDefault();
    const currentIndex = options.findIndex((option) => option === document.activeElement);
    const nextIndex = event.key === 'Home' ? 0
      : event.key === 'End' ? options.length - 1
        : event.key === 'ArrowDown' ? (currentIndex + 1 + options.length) % options.length
          : (currentIndex - 1 + options.length) % options.length;
    options[nextIndex]?.focus();
  }

  const modelPopover = showModels && pickerPosition
    ? <div
      ref={pickerPopover}
      className="model-picker-popover"
      role="dialog"
      aria-label={pickerPage === 'models' ? '选择模型' : '思考强度'}
      style={{
        left: pickerPosition.left,
        bottom: pickerPosition.bottom,
        width: pickerPosition.width,
        maxHeight: pickerPosition.maxHeight,
      }}
    >
      {pickerPage === 'models' ? <>
        {models.models.length ? <div className="model-choice-list" role="group" aria-label="可用模型" onKeyDown={handleModelMenuKeyDown}>
          {models.providers.filter((provider) => provider.models.length > 0).map((provider) => <section className="model-provider-group" key={provider.id}>
            <h3 className="model-provider-heading">{provider.name}</h3>
            {provider.models.map((model) => <button
              key={model.id}
              type="button"
              data-picker-option
              className="model-choice"
              disabled={blocked}
              aria-pressed={models.selectedId === model.id}
              aria-label={`${model.name}，${provider.name}`}
              ref={models.selectedId === model.id || (!models.selectedId && model.id === models.models[0]?.id) ? selectedModelOption : undefined}
              onClick={() => { void selectModel(model.id); }}
            >
              <span className="model-choice-copy"><strong>{model.name}</strong></span>
              {models.selectedId === model.id && <Icon name="check" size={15} />}
            </button>)}
          </section>)}
        </div> : <div className="model-picker-empty">
          <span>还没有可用模型</span>
        </div>}
        {(modelError || models.error) && <p role="alert" className="model-form-error">{modelError ?? models.error}</p>}
        <div className="model-picker-divider" />
        <button type="button" className="model-picker-thinking-link" disabled={blocked || !models.selectedId} onClick={() => setPickerPage('thinking')}>
          <span>思考强度</span>
          <span className="model-picker-thinking-value">{effortOptions.find((option) => option.value === thinkingEffort)?.label}</span>
          <Icon name="chevron" size={16} />
        </button>
      </> : <>
        <div className="model-picker-subpage-header">
          <button type="button" aria-label="返回模型列表" onClick={() => setPickerPage('models')}><Icon name="back" size={17} /></button>
          <strong>思考强度</strong>
        </div>
        <div className="thinking-effort-list" role="group" aria-label="思考强度" onKeyDown={handleModelMenuKeyDown}>
          {effortOptions.map((option) => <button
            key={option.value}
            ref={thinkingEffort === option.value ? selectedEffortOption : undefined}
            type="button"
            data-picker-option
            className="thinking-effort-option"
            disabled={blocked}
            aria-pressed={thinkingEffort === option.value}
            onClick={() => { onThinkingEffortChange(option.value); setPickerPage('models'); }}
          >
            <span className="model-choice-copy"><strong>{option.label}</strong><small>{option.description}</small></span>
            {thinkingEffort === option.value && <Icon name="check" size={18} />}
          </button>)}
        </div>
      </>}
    </div>
    : null;

  return <>
    <form className="composer" onSubmit={(event) => { event.preventDefault(); submit(); }}>
      <textarea
        ref={input}
        aria-label="消息内容"
        placeholder="发消息，探索更多可能…"
        value={value}
        rows={2}
        onChange={(event) => onChange(event.target.value)}
        onCompositionStart={() => { composing.current = true; }}
        onCompositionEnd={() => { composing.current = false; }}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey && window.matchMedia('(pointer: fine)').matches && !composing.current && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229) {
            event.preventDefault();
            submit();
          }
        }}
      />
      <div className="composer-toolbar">
        <button
          ref={pickerTrigger}
          type="button"
          className={`model-picker${showModels ? ' is-open' : ''}`}
          onClick={() => { setShowModels((open) => !open); setPickerPage('models'); setModelError(null); }}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown' && !showModels) {
              event.preventDefault();
              setPickerPage('models');
              setShowModels(true);
            }
          }}
          aria-haspopup="dialog"
          aria-expanded={showModels}
          aria-label={models.selected ? `选择模型，当前为${models.selected.name}，思考强度${effortLabel}` : '选择模型，当前未选择模型'}
        >
          <span className="model-picker-label">{models.selected?.name ?? '选择模型'}</span>
          {/* Sits outside the label so it survives truncation: the effort applies to the next
              request regardless of how long the model name is. */}
          {models.selected && <span className="model-picker-thinking-value">{effortLabel}</span>}
          <Icon name="chevron" size={18} className="model-picker-chevron" />
        </button>
        {running ? <button type="button" className="send-button" onClick={runtime.stop} aria-label="停止生成"><span className="stop-generation-icon" /></button>
          : <button type="submit" className="send-button" disabled={!value.trim() || blocked} aria-label="发送消息"><Icon name="arrow" size={21} /></button>}
      </div>
    </form>
    {modelPopover}
  </>;
}
