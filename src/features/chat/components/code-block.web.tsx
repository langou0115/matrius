import { memo, useEffect, useId, useRef, useState } from 'react';

import { Icon } from '@/components/web/icon';
import { copyText } from '@/core/platform/clipboard.web';
import { highlightCode } from '../markdown/highlight-code.web';

type Props = { code: string; language: string };

export const CodeBlock = memo(function CodeBlock({ code, language }: Props) {
  const [collapsed, setCollapsed] = useState(false);
  const [highlighted, setHighlighted] = useState<{ code: string; language: string; html: string } | null>(null);
  const [copyStatus, setCopyStatus] = useState('');
  const resetCopy = useRef<ReturnType<typeof setTimeout> | null>(null);
  const codeId = useId();

  useEffect(() => {
    if (collapsed) return;
    let active = true;
    highlightCode(code, language).then((html) => {
      if (active && html !== null) setHighlighted({ code, language, html });
    }).catch(() => { /* Plain text remains available if a grammar fails to load. */ });
    return () => { active = false; };
  }, [code, language, collapsed]);
  useEffect(() => () => { if (resetCopy.current) clearTimeout(resetCopy.current); }, []);

  async function copy() {
    if (resetCopy.current) clearTimeout(resetCopy.current);
    try { await copyText(code); setCopyStatus('已复制'); }
    catch { setCopyStatus('复制失败，请手动选择代码'); }
    resetCopy.current = setTimeout(() => setCopyStatus(''), 2500);
  }
  const html = highlighted?.code === code && highlighted.language === language ? highlighted.html : null;

  return <div className="message-code">
    <div className="message-code-header">
      <span className="message-code-language">{language || 'text'}</span>
      <div className="message-code-actions">
        <span className="sr-only" role="status">{copyStatus}</span>
        <button type="button" onClick={copy} aria-label="复制代码"><Icon name={copyStatus === '已复制' ? 'check' : 'copy'} size={16} /></button>
        <button type="button" onClick={() => setCollapsed((value) => !value)} aria-expanded={!collapsed} aria-controls={codeId} aria-label={collapsed ? '展开代码' : '收起代码'}><Icon name={collapsed ? 'expand' : 'collapse'} size={16} /></button>
      </div>
    </div>
    <pre id={codeId} hidden={collapsed}>{html === null
      ? <code>{code}</code>
      // Only highlight.js output enters this sink; it escapes the original code.
      : <code dangerouslySetInnerHTML={{ __html: html }} />}</pre>
  </div>;
});
