import { memo, useId } from 'react';
import Markdown, { type Components } from 'react-markdown';
import remarkCjkFriendly from 'remark-cjk-friendly/parseOnly';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';

import { normalizeMarkdown } from '../markdown/normalize-markdown';
import { CodeBlock } from './code-block.web';

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

export const MessageContent = memo(function MessageContent({ content, streaming = false }: { content: string; streaming?: boolean }) {
  const id = useId();
  return <div className="message-markdown"><Markdown
    components={components}
    remarkPlugins={[remarkGfm, remarkCjkFriendly, remarkMath]}
    remarkRehypeOptions={{ clobberPrefix: `message-${id}-`, footnoteLabel: '注释' }}
    rehypePlugins={[[rehypeKatex, { trust: false, strict: 'ignore', maxExpand: 1000, maxSize: 20 }], [rehypeFormulaSource, { streaming }]]}
  >{normalizeMarkdown(content)}</Markdown></div>;
});
