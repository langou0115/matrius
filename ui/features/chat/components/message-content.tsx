import { Download } from 'lucide-react';
import { memo, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  Streamdown, type CodeHighlighterPlugin, type Components, type DiagramPlugin, type IconMap, type PluginConfig,
  type StreamdownTranslations,
} from 'streamdown';
import { cjk } from '@streamdown/cjk';
import { createMathPlugin, type MathPlugin } from '@streamdown/math';
import rehypeKatex from 'rehype-katex';

import { Icon } from '@/components/web/icon';
import type { WebActivity } from '@contract/agent-types';
import { prepareCitations, type CitationSource, type MessageCitationContext } from '../citations';
import { normalizeMarkdown } from '../markdown/normalize-markdown';
import { CitationMarker } from './citation-marker';

function citationLabel(href: string | undefined): string | null {
  if (!href?.startsWith('#citation-')) return null;
  try {
    return decodeURIComponent(href.slice('#citation-'.length));
  } catch {
    return null;
  }
}

/**
 * Streamdown's own sanitiser allows a small set of harmless protocols but still lets a
 * `javascript:` URL reach the DOM. React refuses it at render time, but the check belongs here:
 * only http(s), mailto, anchors and relative links survive, everything else is dropped so no
 * protocol handler can be smuggled into an answer.
 */
const SAFE_PROTOCOLS = /^(?:https?:|mailto:|tel:)/iu;

function safeHref(href: string | undefined): string | undefined {
  if (!href) return undefined;
  const value = href.trim();
  if (!value) return undefined;
  if (value.startsWith('#') || value.startsWith('/') || value.startsWith('./') || value.startsWith('../')) return value;
  return SAFE_PROTOCOLS.test(value) ? value : undefined;
}

/**
 * GFM footnotes are the one thing in a reply that links to itself: `[^1]` renders as a raised
 * number pointing at the definition list at the end of the same message, and the `↩` beside a
 * definition points back. Following either one makes the browser scroll the nearest scroll
 * container to the target — including the document, whose `overflow: hidden` still permits
 * programmatic scrolling — and the whole app shell ends up shifted with no way to scroll back.
 * Answers about the web use the citation markers instead, so these two are rendered as inert
 * text: the number stays readable, nothing navigates.
 */
function createComponents(byLabel: Map<string, CitationSource> | null): Components {
  return {
    a({ node, children, href, ...props }) {
      const classes = node?.properties?.className;
      const isBackref = Array.isArray(classes) && classes.includes('data-footnote-backref');
      if (isBackref || (node?.properties as Record<string, unknown> | undefined)?.['data-footnote-backref'] !== undefined) return null;
      const label = byLabel ? citationLabel(href) : null;
      const source = label ? byLabel?.get(label) : undefined;
      if (source) return <CitationMarker source={source} />;
      const target = safeHref(href);
      if (target?.startsWith('#')) return <span className="message-footnote-ref">{children}</span>;
      return <a {...props} href={target} target={target && /^https?:/iu.test(target) ? '_blank' : undefined} rel="noreferrer noopener">{children}</a>;
    },
  };
}

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
 *
 * Streamdown runs the math plugin's rehype step after the caller's own rehype plugins, so this runs
 * KaTeX itself and then downgrades, rather than being registered as a separate plugin that would
 * see the tree before any formula was rendered.
 */
function katexWithFormulaSource(options?: { streaming?: boolean }) {
  const streaming = options?.streaming ?? false;
  const renderMath = rehypeKatex({
    trust: false,
    strict: 'ignore',
    maxExpand: 1000,
    maxSize: 20,
    errorColor: 'var(--muted-foreground)',
  });
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
  return (tree: HastNode, file: unknown) => {
    renderMath(tree as never, file as never);
    downgrade(tree);
  };
}

/**
 * Streamdown's math plugin is remark-math + rehype-katex. `singleDollarTextMath` is on because the
 * normalizer has already escaped every `$` that was currency; the rehype step is ours so a formula
 * KaTeX rejects is downgraded after it has been rendered, not before.
 */
function mathPluginFor(streaming: boolean): MathPlugin {
  const base = createMathPlugin({ singleDollarTextMath: true });
  return { ...base, rehypePlugin: [katexWithFormulaSource, { streaming }] as unknown as MathPlugin['rehypePlugin'] };
}

const streamdownIcons: Partial<IconMap> = {
  CheckIcon: ({ className, size = 16 }) => <Icon name="check" size={size} className={className} />,
  CopyIcon: ({ className, size = 16 }) => <Icon name="copy" size={size} className={className} />,
  DownloadIcon: ({ className, size = 16 }) => (
    <Download size={size} strokeWidth={1.65} className={className} aria-hidden="true" />
  ),
};

const translations: Partial<StreamdownTranslations> = {
  close: '关闭',
  copied: '已复制',
  copyCode: '复制代码',
  copyLink: '复制链接',
  copyTable: '复制表格',
  copyTableAsCsv: '复制为 CSV',
  copyTableAsMarkdown: '复制为 Markdown',
  copyTableAsTsv: '复制为 TSV',
  downloadDiagram: '下载图表',
  downloadDiagramAsMmd: '下载为 MMD',
  downloadDiagramAsPng: '下载为 PNG',
  downloadDiagramAsSvg: '下载为 SVG',
  downloadFile: '下载文件',
  downloadImage: '下载图片',
  downloadTable: '下载表格',
  downloadTableAsCsv: '下载为 CSV',
  downloadTableAsMarkdown: '下载为 Markdown',
  errorMermaid: 'Mermaid 图表渲染失败',
  exitFullscreen: '退出全屏',
  externalLinkWarning: '即将离开 Matrius',
  imageNotAvailable: '图片不可用',
  mermaidAriaLabel: 'Mermaid 图表',
  mermaidFormatMmd: 'MMD',
  mermaidFormatPng: 'PNG',
  mermaidFormatSvg: 'SVG',
  openExternalLink: '打开外部链接',
  openLink: '打开链接',
  resetView: '重置视图',
  tableFormatCsv: 'CSV',
  tableFormatMarkdown: 'Markdown',
  tableFormatTsv: 'TSV',
  viewFullscreen: '全屏查看',
  zoomIn: '放大',
  zoomOut: '缩小',
};

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

export const MessageContent = memo(function MessageContent({ content, streaming = false, webActivities, citationContext }: {
  content: string;
  streaming?: boolean;
  /** Web tool calls made for this answer. Supplying them enables footnote citations and cards. */
  webActivities?: WebActivity[];
  /** Whole-message citation index when a reply is split around inline Intelligent UI cards. */
  citationContext?: MessageCitationContext;
}) {
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
  const prepared = useMemo(() => {
    const normalized = normalizeMarkdown(rendered);
    return webActivities === undefined && !citationContext
      ? { markdown: normalized, byLabel: null }
      : prepareCitations(normalized, webActivities, citationContext);
  }, [rendered, webActivities, citationContext]);
  const components = useMemo(() => createComponents(prepared.byLabel), [prepared.byLabel]);

  // The Shiki engine (Oniguruma grammar bundle) and the Mermaid runtime are both large, so each
  // loads only when a reply actually needs it: a fence for the first, a ```mermaid block for the
  // second. Until then a code block renders as plain text, which is what it was before.
  const hasFence = useMemo(() => /(?:^|\n)\s{0,3}(?:`{3,}|~{3,})/u.test(prepared.markdown), [prepared.markdown]);
  const hasMermaid = useMemo(() => /(?:^|\n)\s{0,3}```mermaid\b/u.test(prepared.markdown), [prepared.markdown]);
  const [codePlugin, setCodePlugin] = useState<CodeHighlighterPlugin>();
  const [mermaidPlugin, setMermaidPlugin] = useState<DiagramPlugin>();
  useEffect(() => {
    if (!hasFence || codePlugin) return;
    let active = true;
    void import('@streamdown/code')
      .then((module) => { if (active) setCodePlugin(module.code); })
      .catch(() => { /* A fence keeps its source text if the highlighter fails to load. */ });
    return () => { active = false; };
  }, [hasFence, codePlugin]);
  useEffect(() => {
    if (!hasMermaid || mermaidPlugin) return;
    let active = true;
    void import('@streamdown/mermaid')
      .then((module) => { if (active) setMermaidPlugin(module.mermaid); })
      .catch(() => { /* The fence stays a plain code block if the diagram runtime fails. */ });
    return () => { active = false; };
  }, [hasMermaid, mermaidPlugin]);

  const plugins = useMemo<PluginConfig>(() => ({
    cjk,
    math: mathPluginFor(streaming),
    ...(codePlugin ? { code: codePlugin } : {}),
    ...(mermaidPlugin ? { mermaid: mermaidPlugin } : {}),
  }), [codePlugin, mermaidPlugin, streaming]);

  const body = useMemo(() => <Streamdown
    components={components}
    mode={streaming ? 'streaming' : 'static'}
    isAnimating={streaming}
    plugins={plugins}
    controls={{ table: false }}
    remarkRehypeOptions={{ clobberPrefix: `message-${id}-`, footnoteLabel: '注释' }}
    skipHtml
    linkSafety={{ enabled: false }}
    shikiTheme={['one-light', 'one-dark-pro']}
    codeBlockMaxHeight={0}
    tableMaxHeight={0}
    lineNumbers={false}
    icons={streamdownIcons}
    translations={translations}
  >{prepared.markdown}</Streamdown>, [prepared.markdown, components, plugins, streaming, id]);

  if (rendered.trim() && !prepared.markdown.trim()) return null;

  return <div className={`message-markdown${replacing ? ' is-replacing' : ''}`}>{body}</div>;
});
