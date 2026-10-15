import { memo, useId } from 'react';
import Markdown, { type Components } from 'react-markdown';
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

export const MessageContent = memo(function MessageContent({ content }: { content: string }) {
  const id = useId();
  return <div className="message-markdown"><Markdown
    components={components}
    remarkPlugins={[remarkGfm, remarkMath]}
    remarkRehypeOptions={{ clobberPrefix: `message-${id}-`, footnoteLabel: '注释' }}
    rehypePlugins={[[rehypeKatex, { trust: false, strict: 'ignore', maxExpand: 1000, maxSize: 20 }]]}
  >{normalizeMarkdown(content)}</Markdown></div>;
});
