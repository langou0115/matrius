import { Fragment } from 'react';

function InlineText({ text }: { text: string }) {
  return <>{text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).map((part, index) =>
    part.startsWith('**') && part.endsWith('**') ? <strong key={index}>{part.slice(2, -2)}</strong>
      : part.startsWith('`') && part.endsWith('`') ? <code key={index}>{part.slice(1, -1)}</code>
        : <Fragment key={index}>{part}</Fragment>)}</>;
}

// A small safe text renderer for the current UI, not a full Markdown parser.
export function MessageContent({ content }: { content: string }) {
  return <>{content.split(/(```[^\n]*\n[\s\S]*?```)/g).filter(Boolean).map((block, index) => {
    if (block.startsWith('```')) {
      const newline = block.indexOf('\n');
      return <div className="message-code" key={index}><div className="message-code-header">{block.slice(3, newline).trim() || 'text'}</div><pre><code>{block.slice(newline + 1, -3).replace(/\n$/, '')}</code></pre></div>;
    }
    return <Fragment key={index}>{block.trim().split(/\n\s*\n/).filter(Boolean).map((paragraph, part) => <p key={part}><InlineText text={paragraph} /></p>)}</Fragment>;
  })}</>;
}
