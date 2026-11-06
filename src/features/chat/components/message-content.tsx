import { memo, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import Markdown, { type Components } from 'react-markdown';
import remarkCjkFriendly from 'remark-cjk-friendly/parseOnly';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';

import { normalizeMarkdown } from '../markdown/normalize-markdown';
import { CodeBlock } from './code-block';

const components: Components = {
  pre({ node, children }) {
    const code = node?.children[0];
    if (code?.type !== 'element' || code.tagName !== 'code') return <pre>{children}</pre>;
    const text = code.children.map((child) => child.type === 'text' ? child.value : '').join('').replace(/\n$/, '');
    const classes = Array.isArray(code.properties.className) ? code.properties.className.join(' ') : '';
    const language = /(?:^|\s)language-([^\s]+)/.exec(classes)?.[1] ?? '';
    return <CodeBlock code={text} language={language} />;
  },
  table({ children }) { return <div className="message-table-scroll" tabIndex={0} role="region" aria-label="表格，可横向滚动"><table>{children}</table></div>; },
  a({ node, children, ...props }) { return <a {...props} target={props.href?.startsWith('#') ? undefined : '_blank'} rel="noreferrer noopener">{children}</a>; },
  img({ node, alt, ...props }) { return <img {...props} alt={alt ?? ''} loading="lazy" />; },
};

type HastProperties = { className?: unknown; title?: unknown; 'data-formula-error'?: unknown };
type HastNode = { type: string; tagName?: string; properties?: HastProperties; children?: HastNode[]; value?: string };

/** Bounds the log so a reply of broken formulas cannot fill the console, one line per failure. */
const reported = new Set<string>();

function reportFormula(title: string) {
  if (reported.size >= 20 || reported.has(title)) return;
  reported.add(title);
  console.warn(`[matrius] 公式未能渲染，已按原文显示：${title}`);
}

/**
 * A formula that is still streaming is not yet valid LaTeX — `x^` has no exponent, `\frac{1}{2` no
 * closing brace — and rehype-katex renders every one of those as `.katex-error`: the raw source in
 * alarm red, with an inline `style` that outranks any stylesheet rule. A screen of red reads as a
 * broken app rather than as a formula still being written, and the state resolves itself the moment
 * the reply completes the formula. So the source is kept, under a class that styles it as ordinary
 * text, while the inline colour that made it an alarm goes.
 *
 * The reason is carried across as a data attribute rather than dropped: a formula that is still
 * wrong once the reply is complete is a bug in the normalizer, and the KaTeX message is what says
 * which shape it failed to see.
 *
 * Only the completed reply is logged. Every prefix of a reply passes through here while it streams,
 * and each one ends mid-formula, so logging those would be a dozen lines of noise per reply — the
 * console would be full of the normal case and silent about the one worth reading.
 */
function rehypeFormulaSource(options?: { streaming?: boolean }) {
  const streaming = options?.streaming ?? false;
  const downgrade = (node: HastNode) => {
    if (!node.children) return;
    for (const child of node.children) {
      const classes = child.properties?.className;
      if (child.tagName === 'span' && Array.isArray(classes) && classes.includes('katex-error')) {
        const title = typeof child.properties?.title === 'string' ? child.properties.title : '';
        if (title && !streaming) reportFormula(title);
        child.properties = { className: ['katex-source'], title, 'data-formula-error': title };
      } else downgrade(child);
    }
  };
  return (tree: HastNode) => { downgrade(tree); };
}

/**
 * Token-by-token replies arrive every ~50 ms. Parsing Markdown for every intermediate string makes
 * a tall block change shape constantly — an open fence, a half-built table or a paragraph that is
 * about to become a list has a different layout each time — and with the transcript pinned to the
 * bottom that reads as flicker. Parse at most this often while streaming; the final text is always
 * parsed immediately, and the element is memoized so a skipped update costs nothing.
 */
const STREAM_PARSE_INTERVAL_MS = 120;
/** Kept in sync with the `.message-markdown.is-replacing` animation in global.css. */
const REPLACE_ANIMATION_MS = 320;
// Layout effects run before paint in the browser, so the swap animation is in place on the first
// painted frame. Node-side rendering and tests fall back to the ordinary effect.
const useBrowserLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

function useStreamedContent(content: string, streaming: boolean): string {
  const [parsed, setParsed] = useState(content);
  const lastParse = useRef(0);
  useEffect(() => {
    if (!streaming) return;
    const wait = Math.max(0, STREAM_PARSE_INTERVAL_MS - (Date.now() - lastParse.current));
    const timer = setTimeout(() => { lastParse.current = Date.now(); setParsed(content); }, wait);
    return () => clearTimeout(timer);
  }, [content, streaming]);
  if (!streaming) return content;
  // A regenerated reply that no longer extends what is on screen must not keep the old answer.
  return content.startsWith(parsed) ? parsed : content;
}

export const MessageContent = memo(function MessageContent({ content, streaming = false }: { content: string; streaming?: boolean }) {
  const id = useId();
  const rendered = useStreamedContent(content, streaming);
  const previous = useRef(content);
  const replaceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [replacing, setReplacing] = useState(false);
  useBrowserLayoutEffect(() => {
    const before = previous.current;
    previous.current = content;
    // Ordinary streaming extends what is already on screen. A rewrite means an interim body
    // (for example a "let me check…" preamble) was replaced by the next message or the answer;
    // animate that swap so the text does not appear to mutate in place.
    if (!before || !content || content.startsWith(before)) return;
    setReplacing(true);
    if (replaceTimer.current) clearTimeout(replaceTimer.current);
    replaceTimer.current = setTimeout(() => {
      replaceTimer.current = null;
      setReplacing(false);
    }, REPLACE_ANIMATION_MS);
  }, [content]);
  useEffect(() => () => {
    if (replaceTimer.current) clearTimeout(replaceTimer.current);
  }, []);
  const body = useMemo(() => <Markdown
    components={components}
    remarkPlugins={[remarkGfm, remarkCjkFriendly, remarkMath]}
    remarkRehypeOptions={{ clobberPrefix: `message-${id}-`, footnoteLabel: '注释' }}
    rehypePlugins={[[rehypeKatex, { trust: false, strict: 'ignore', maxExpand: 1000, maxSize: 20 }], [rehypeFormulaSource, { streaming }]]}
  >{normalizeMarkdown(rendered)}</Markdown>, [rendered, streaming, id]);
  return <div className={`message-markdown${replacing ? ' is-replacing' : ''}`}>{body}</div>;
});
