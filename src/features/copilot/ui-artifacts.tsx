import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { readUiArtifacts, type UiArtifact } from '@agent/core/ui-contract';
import { MessageContent } from '@/features/chat/components/message-content';

const scriptText = (value: string) => value.replace(/<\/script/gi, '<\\/script');

/** Opaque-origin sandbox: no storage, host DOM, forms, popups or network access. */
export function sandboxDocument(props: Extract<UiArtifact, { name: 'generateSandboxedUi' }>['props'], preview = false) {
  const bridge = `window.matrius=Object.freeze({sendPrompt:({text})=>parent.postMessage({type:'matrius-ui-prompt',text},'*')});`;
  const resize = `new ResizeObserver(()=>parent.postMessage({type:'matrius-ui-resize',height:Math.ceil(document.body.getBoundingClientRect().height)},'*')).observe(document.body);`;
  const scripts = preview ? '' : `<script>${bridge}\n${scriptText(props.jsFunctions)}\n${scriptText(props.jsExpressions)}\n${resize}</script>`;
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src ${preview ? "'none'" : "'unsafe-inline'"}; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'"><style>body{font:14px system-ui;margin:0;color:#222}*{box-sizing:border-box}${props.css}</style></head><body>${props.html}${scripts}</body></html>`;
}

function SandboxedUi({ artifact, onPrompt }: { artifact: Extract<UiArtifact, { name: 'generateSandboxedUi' }>; onPrompt?: (text: string) => void }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const label = useId();
  const [pending, setPending] = useState('');
  const [height, setHeight] = useState<number | null>(null);
  const document = useMemo(() => sandboxDocument(artifact.props, artifact.streaming), [artifact.props, artifact.streaming]);
  const [previewDocument, setPreviewDocument] = useState(document);
  const lastPreview = useRef(0);
  useEffect(() => {
    if (!artifact.streaming) return;
    const timer = setTimeout(() => { lastPreview.current = Date.now(); setPreviewDocument(document); }, Math.max(0, 180 - (Date.now() - lastPreview.current)));
    return () => clearTimeout(timer);
  }, [document, artifact.streaming]);
  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow || event.origin !== 'null') return;
      const value = event.data;
      if (value?.type === 'matrius-ui-resize' && typeof value.height === 'number' && Number.isFinite(value.height)) setHeight(Math.max(80, Math.min(1600, value.height + 8)));
      if (value?.type === 'matrius-ui-prompt' && typeof value.text === 'string' && value.text.trim() && value.text.length <= 8000) setPending(value.text.trim());
    };
    window.addEventListener('message', receive);
    return () => window.removeEventListener('message', receive);
  }, []);
  return <section aria-label="交互内容" style={{ marginBlock: 12 }}>
    {artifact.streaming && !artifact.props.html && <p role="status">{artifact.props.placeholderMessages[0] || '正在生成交互内容…'}</p>}
    <iframe ref={frame} title="AI 生成的交互内容" sandbox={artifact.streaming ? '' : 'allow-scripts'} referrerPolicy="no-referrer" srcDoc={artifact.streaming ? previewDocument : document}
      style={{ display: artifact.streaming && !artifact.props.html ? 'none' : 'block', width: '100%', height: height ?? artifact.props.initialHeight, border: 0, borderRadius: 8, background: 'white' }} />
    {pending && onPrompt && <div style={{ padding: 12 }}>
      <p id={label} style={{ whiteSpace: 'pre-wrap' }}>{pending}</p>
      <button type="button" aria-describedby={label} onClick={() => { onPrompt(pending); setPending(''); }}>发送后续问题</button>
      <button type="button" onClick={() => setPending('')}>取消</button>
    </div>}
  </section>;
}

export function UiArtifactView({ artifact, onPrompt }: { artifact: UiArtifact; onPrompt?: (text: string) => void }) {
  if (artifact.name === 'generateSandboxedUi') return <SandboxedUi artifact={artifact} onPrompt={onPrompt} />;
  const body = artifact.name === 'comparisonTable' ? <div style={{ overflowX: 'auto' }}><table><thead><tr>{artifact.props.columns.map((column, i) => <th key={i} style={{ padding: 10, textAlign: 'left' }}>{column}</th>)}</tr></thead><tbody>{artifact.props.rows.map((row, i) => <tr key={i}>{artifact.props.columns.map((_, j) => <td key={j} style={{ padding: 10, borderTop: '1px solid var(--border)' }}>{row[j] ?? ''}</td>)}</tr>)}</tbody></table></div>
    : artifact.name === 'keyValueCard' ? <dl>{artifact.props.items.map((item, i) => <div key={i}><dt>{item.label}</dt><dd>{item.value}</dd></div>)}</dl>
      : <ol>{artifact.props.steps.map((step, i) => <li key={i}><strong>{step.title}</strong>{step.detail && <p>{step.detail}</p>}</li>)}</ol>;
  return <section style={{ marginBlock: 12, padding: 14, border: '1px solid var(--border)', borderRadius: 12 }}>
    <strong>{artifact.props.title}</strong>{body}{'note' in artifact.props && artifact.props.note && <p>{artifact.props.note}</p>}
  </section>;
}

export function UiArtifacts({ artifacts, onPrompt }: { artifacts: unknown; onPrompt?: (text: string) => void }) {
  return readUiArtifacts(artifacts)?.map(artifact => <UiArtifactView key={artifact.id} artifact={artifact} onPrompt={onPrompt} />);
}

/** Text and UI share one answer, preserving their generation order after reload. */
export function AssistantAnswer({ content, artifacts, streaming, onPrompt }: { content: string; artifacts: unknown; streaming: boolean; onPrompt?: (text: string) => void }) {
  const values = readUiArtifacts(artifacts) ?? [];
  let cursor = 0;
  const parts = [];
  for (const artifact of values) {
    const offset = Math.max(cursor, Math.min(content.length, artifact.textOffset ?? content.length));
    const text = content.slice(cursor, offset);
    cursor = offset;
    parts.push(<div key={artifact.id}>
      {text && <div data-quote-source><MessageContent content={text} /></div>}
      <UiArtifactView artifact={artifact} onPrompt={onPrompt} />
    </div>);
  }
  return <div className="assistant-answer">{parts}<div data-quote-source><MessageContent content={content.slice(cursor)} streaming={streaming} /></div></div>;
}
