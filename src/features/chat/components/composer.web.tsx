import { useEffect, useRef, useState, type ClipboardEvent as ReactClipboardEvent, type KeyboardEvent as ReactKeyboardEvent } from 'react';

import type { ThinkingEffort } from '@/core/agent/thinking-effort';
import { Icon } from '@/components/web/icon';
import { Paperclip } from 'lucide-react';
import { useModels } from '@/features/models/model-state';
import { useChatRuntime } from '../chat-runtime';
import { useChat, type MessageImage } from '../chat-state';
import { ModelIcon } from './model-icon.web';
import { AttachmentList, type StagedAttachment } from './attachment-list.web';
import { QuoteCard } from './quote-card.web';

type Props = {
  value: string;
  onChange: (value: string) => void;
  onSend: (images: MessageImage[]) => boolean;
  thinkingEffort: ThinkingEffort;
  onThinkingEffortChange: (value: ThinkingEffort) => void;
  /** Called after the model switch is stored, so the conversation can remember it. */
  onModelChange?: (id: string) => void;
  quote?: string;
  onRemoveQuote?: () => void;
  onNotice: (message: string | null) => void;
};

// Validate only on send; selecting an attachment never depends on the current model.
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
const MAX_IMAGES = 4;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

function createId() { return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`; }

function readImageDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error('Cannot read image'));
    reader.readAsDataURL(file);
  });
}

// Labels are written out rather than derived from the value: the stored identifiers stay
// English, but everything the picker prints is Chinese.
const effortOptions: { value: ThinkingEffort; label: string; description: string }[] = [
  { value: 'default', label: '默认', description: '使用模型默认设置' },
  { value: 'low', label: '低', description: '更快响应，较少推理' },
  { value: 'medium', label: '中', description: '平衡响应速度与推理深度' },
  { value: 'high', label: '高', description: '适合复杂任务的深入推理' },
];

// Both picker pages swap inside the same anchored card. The thinking page's natural height
// (header + four effort rows) is the reference: the model list is capped to it so switching
// pages does not resize the card. The fallback below still wins on short viewports.
const PICKER_CARD_MAX_HEIGHT = 294;

export function Composer({ value, onChange, onSend, thinkingEffort, onThinkingEffortChange, onModelChange, quote, onRemoveQuote, onNotice }: Props) {
  const input = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  // Staged for the next message only. The parent keys this component by conversation, so a
  // switch remounts it and drops both the previews and any selection error.
  const [attachments, setAttachments] = useState<StagedAttachment[]>([]);
  const previewUrls = useRef(new Set<string>());
  const mounted = useRef(true);
  const preparing = useRef(false);
  const [sending, setSending] = useState(false);
  useEffect(() => {
    mounted.current = true;
    const urls = previewUrls.current;
    return () => { mounted.current = false; urls.forEach((url) => URL.revokeObjectURL(url)); urls.clear(); };
  }, []);
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
  // Only this conversation is blocked: another chat may keep generating in the background.
  const running = runtime.isRunning(activeId);
  const blocked = running;
  const effortLabel = effortOptions.find((option) => option.value === thinkingEffort)?.label ?? '';

  // The current model is what people come back for, so its provider group and its own row
  // move to the front; the remaining order is untouched.
  const selectedModel = models.selected;
  const selectedProviderIndex = selectedModel
    ? models.providers.findIndex((provider) => provider.models.some((model) => model.id === selectedModel.id))
    : -1;
  const orderedProviders = selectedProviderIndex > 0
    ? [models.providers[selectedProviderIndex], ...models.providers.slice(0, selectedProviderIndex), ...models.providers.slice(selectedProviderIndex + 1)]
    : models.providers;

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
        maxHeight: Math.min(PICKER_CARD_MAX_HEIGHT, Math.max(120, bounds.top - 20)),
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

  function addImages(files: File[]) {
    if (!files.length) return;
    onNotice(null);
    const next = files.map((file) => {
      const isImage = file.type.startsWith('image/') || /\.(png|jpe?g|webp|gif|svg|avif|bmp|ico)$/i.test(file.name);
      const preview = isImage ? URL.createObjectURL(file) : null;
      if (preview) previewUrls.current.add(preview);
      return { id: createId(), file, preview };
    });
    setAttachments((current) => [...current, ...next]);
  }

  function handlePaste(event: ReactClipboardEvent<HTMLTextAreaElement>) {
    const files = Array.from(event.clipboardData.items)
      .filter((item) => item.kind === 'file')
      .map((item) => item.getAsFile())
      .filter((file): file is File => !!file);
    if (!files.length) return;
    event.preventDefault();
    void addImages(files);
  }

  async function submit() {
    if (blocked || preparing.current || (!value.trim() && !attachments.length && !quote?.trim())) return;
    if (!models.ready || !models.selected) { onNotice(models.error ?? '请先在设置 → 模型服务中添加并选择模型。'); return; }
    const unsupported = attachments.find(({ file }) => !IMAGE_TYPES.includes(file.type));
    if (unsupported) { onNotice(`暂不支持文件「${unsupported.file.name}」，目前仅支持 PNG、JPEG、WebP 或 GIF 图片。`); return; }
    if (attachments.length > MAX_IMAGES) { onNotice(`每条消息最多发送 ${MAX_IMAGES} 张图片，请移除多余附件。`); return; }
    const oversized = attachments.find(({ file }) => file.size > MAX_IMAGE_BYTES);
    if (oversized) { onNotice(`图片「${oversized.file.name}」超过 10MB，请移除或压缩后重试。`); return; }
    if (attachments.length && !models.selected.supportsImage) { onNotice('当前模型未开启图片输入，请切换支持图片的模型，或在模型设置中确认图片输入能力。'); return; }
    preparing.current = true;
    setSending(true);
    try {
      const images = await Promise.all(attachments.map(async ({ id, file }) => ({ id, name: file.name, mimeType: file.type, dataUrl: await readImageDataUrl(file), size: file.size })));
      if (!mounted.current) return;
      if (!onSend(images)) return;
      const sentIds = new Set(attachments.map(({ id }) => id));
      setAttachments((current) => current.filter(({ id }) => !sentIds.has(id)));
      attachments.forEach(({ preview }) => { if (preview) { URL.revokeObjectURL(preview); previewUrls.current.delete(preview); } });
      onNotice(null);
      input.current?.focus();
    } catch {
      if (mounted.current) onNotice('读取附件失败，请重试。');
    } finally {
      preparing.current = false;
      if (mounted.current) setSending(false);
    }
  }

  async function selectModel(id: string) {
    try {
      await models.select(id);
      // The conversation may have been switched while the preference was saving.
      if (!mounted.current) return;
      onModelChange?.(id);
      onNotice(null);
      setShowModels(false);
      setPickerPage('models');
      pickerTrigger.current?.focus();
    } catch {
      onNotice('切换模型失败，请刷新后重试。');
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
          {orderedProviders.filter((provider) => provider.models.length > 0).map((provider) => {
            const selectedIndex = selectedModel ? provider.models.findIndex((model) => model.id === selectedModel.id) : -1;
            const orderedModels = selectedIndex > 0
              ? [provider.models[selectedIndex], ...provider.models.slice(0, selectedIndex), ...provider.models.slice(selectedIndex + 1)]
              : provider.models;
            return <section className="model-provider-group" key={provider.id}>
              <h3 className="model-provider-heading">{provider.name}</h3>
              {orderedModels.map((model) => <button
                key={model.id}
                type="button"
                data-picker-option
                className="model-choice"
                disabled={blocked || sending}
                aria-pressed={models.selectedId === model.id}
                aria-label={`${model.name}，${provider.name}`}
                ref={models.selectedId === model.id || (!models.selectedId && model.id === models.models[0]?.id) ? selectedModelOption : undefined}
                onClick={() => { void selectModel(model.id); }}
              >
                <ModelIcon modelId={model.modelId} name={model.name} providerName={provider.name} />
                <span className="model-choice-copy"><strong>{model.name}</strong></span>
                {models.selectedId === model.id && <Icon name="check" size={15} />}
              </button>)}
            </section>;
          })}
        </div> : <div className="model-picker-empty">
          <span>还没有可用模型</span>
        </div>}
        {models.selected && <>
        <div className="model-picker-divider" />
        <button type="button" className="model-picker-thinking-link" disabled={blocked || sending || !models.selectedId} onClick={() => setPickerPage('thinking')}>
          <span>思考强度</span>
          <span className="model-picker-thinking-value">{effortOptions.find((option) => option.value === thinkingEffort)?.label}</span>
          <Icon name="chevron" size={16} />
        </button>
        </>}
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
            disabled={blocked || sending}
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
    <form className="composer" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
      {quote && <QuoteCard content={quote} onRemove={sending ? undefined : onRemoveQuote} />}
      <input ref={fileInput} className="composer-file-input" type="file" multiple
        onChange={(event) => { const files = Array.from(event.target.files ?? []); event.target.value = ''; void addImages(files); }} />
      {attachments.length > 0 && <AttachmentList attachments={attachments} removingDisabled={sending} onRemove={(attachment) => {
        onNotice(null);
        if (attachment.preview) { URL.revokeObjectURL(attachment.preview); previewUrls.current.delete(attachment.preview); }
        setAttachments((current) => current.filter((item) => item.id !== attachment.id));
      }} />}
      <textarea
        ref={input}
        aria-label="消息内容"
        placeholder={attachments.length ? '' : '发消息，探索更多可能…'}
        value={value}
        readOnly={sending}
        rows={2}
        onPaste={handlePaste}
        onChange={(event) => onChange(event.target.value)}
        onCompositionStart={() => { composing.current = true; }}
        onCompositionEnd={() => { composing.current = false; }}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey && window.matchMedia('(pointer: fine)').matches && !composing.current && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229) {
            event.preventDefault();
            void submit();
          }
        }}
      />
      <div className="composer-toolbar">
        <button type="button" className="composer-attach" onClick={() => { onNotice(null); fileInput.current?.click(); }}
          aria-label="添加附件">
          <Paperclip size={22} strokeWidth={1.75} aria-hidden="true" />
        </button>
        <button
          ref={pickerTrigger}
          type="button"
          className={`model-picker${showModels ? ' is-open' : ''}`}
          onClick={() => { setShowModels((open) => !open); setPickerPage('models'); onNotice(models.error); }}
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
          <ModelIcon modelId={models.selected?.modelId} name={models.selected?.name} providerName={models.selected?.providerName} />
          <span className="model-picker-label">{models.selected?.name ?? '选择模型'}</span>
          {/* Sits outside the label so it survives truncation: the effort applies to the next
              request regardless of how long the model name is. */}
          {models.selected && <span className="model-picker-thinking-value">{effortLabel}</span>}
          <Icon name="chevron" size={18} className="model-picker-chevron" />
        </button>
        {running ? <button type="button" className="send-button" onClick={() => runtime.stop(activeId ?? undefined)} aria-label="停止生成"><span className="stop-generation-icon" /></button>
          : <button type="submit" className="send-button" disabled={(!value.trim() && !attachments.length && !quote?.trim()) || blocked || sending} aria-label="发送消息"><Icon name="arrow" size={21} /></button>}
      </div>
    </form>
    {modelPopover}
  </>;
}
