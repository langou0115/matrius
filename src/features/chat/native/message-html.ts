import katex from 'katex';

import type { NativeTheme } from '@/theme/native-theme';
import { parseMarkdown, type Block, type Inline } from './markdown';

function escapeHtml(value: string) {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function renderMath(tex: string, display: boolean) {
  try {
    // MathML output needs no stylesheet or font files, so the WebView works fully offline.
    return katex.renderToString(tex, { displayMode: display, output: 'mathml', throwOnError: false, strict: 'ignore' });
  } catch {
    return `<code>${escapeHtml(tex)}</code>`;
  }
}

function renderInline(nodes: Inline[]): string {
  return nodes.map((node) => {
    switch (node.type) {
      case 'text': return escapeHtml(node.value).replace(/\n/g, '<br>');
      case 'code': return `<code>${escapeHtml(node.value)}</code>`;
      case 'strong': return `<strong>${renderInline(node.children)}</strong>`;
      case 'em': return `<em>${renderInline(node.children)}</em>`;
      case 'link': return `<a href="${escapeHtml(node.href)}" target="_blank" rel="noreferrer">${renderInline(node.children)}</a>`;
      case 'math': return `<span class="math">${renderMath(node.tex, node.display)}</span>`;
    }
  }).join('');
}

function renderBlocks(blocks: Block[]): string {
  return blocks.map((block) => {
    switch (block.type) {
      case 'paragraph': return `<p>${renderInline(block.children)}</p>`;
      case 'heading': return `<h${block.level}>${renderInline(block.children)}</h${block.level}>`;
      case 'code': return `<pre><button type="button">复制</button><code>${escapeHtml(block.code)}</code></pre>`;
      case 'table': return `<pre class="table"><code>${escapeHtml(block.code)}</code></pre>`;
      case 'quote': return `<blockquote>${renderBlocks(block.blocks)}</blockquote>`;
      case 'list': return block.ordered
        ? `<ol>${block.items.map((item) => `<li>${renderInline(item)}</li>`).join('')}</ol>`
        : `<ul>${block.items.map((item) => `<li>${renderInline(item)}</li>`).join('')}</ul>`;
      case 'rule': return '<hr>';
    }
  }).join('');
}

const copyAndMeasure = `
  (function () {
    var lastHeight = 0;
    function sendHeight() {
      var height = Math.ceil(document.body.getBoundingClientRect().height);
      if (height === lastHeight) return;
      lastHeight = height;
      window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'height', height: height }));
    }
    document.querySelectorAll('pre').forEach(function (pre) {
      var button = pre.querySelector('button');
      var code = pre.querySelector('code');
      if (!button || !code) return;
      button.addEventListener('click', function () {
        window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'copy', text: code.textContent || '' }));
      });
    });
    if (typeof ResizeObserver === 'function') new ResizeObserver(sendHeight).observe(document.body);
    window.addEventListener('load', sendHeight);
    setTimeout(sendHeight, 0);
    setTimeout(sendHeight, 120);
  })();
`;

export function renderMessageHtml(markdown: string, theme: NativeTheme): string {
  const { colors } = theme;
  const body = renderBlocks(parseMarkdown(markdown));
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">
<style>
:root { color-scheme: ${theme.mode}; }
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; background: transparent; }
body { color: ${colors.foreground}; font: 16px/1.65 -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans SC", sans-serif; overflow-wrap: anywhere; -webkit-text-size-adjust: 100%; }
p { margin: 0 0 10px; }
p:last-child { margin-bottom: 0; }
h1, h2, h3, h4, h5, h6 { margin: 16px 0 8px; line-height: 1.35; }
h1 { font-size: 1.4em; } h2 { font-size: 1.25em; } h3 { font-size: 1.12em; } h4, h5, h6 { font-size: 1em; }
a { color: ${colors.primary}; text-decoration: underline; }
code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.92em; background: ${colors.muted}; border-radius: 5px; padding: 1px 4px; }
pre { position: relative; margin: 10px 0; padding: 12px; padding-top: 34px; background: ${colors.muted}; border-radius: 8px; overflow-x: auto; }
pre code { background: transparent; padding: 0; white-space: pre; }
pre button { position: absolute; top: 6px; right: 6px; border: 0; background: transparent; color: ${colors.mutedForeground}; font: 12px -apple-system, sans-serif; padding: 4px 6px; }
pre.table { padding-top: 12px; }
blockquote { margin: 10px 0; padding: 2px 0 2px 12px; border-left: 3px solid ${colors.border}; color: ${colors.mutedForeground}; }
ul, ol { margin: 8px 0; padding-left: 22px; }
li { margin: 3px 0; }
hr { border: 0; border-top: 1px solid ${colors.border}; margin: 14px 0; }
.math { display: inline-block; max-width: 100%; overflow-x: auto; vertical-align: middle; }
.katex-display, .katex { color: inherit; }
.math math { font-size: 1.05em; }
</style>
</head>
<body>${body}<script>${copyAndMeasure}</script></body>
</html>`;
}
