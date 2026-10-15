import hljs from 'highlight.js/lib/core';
import type { LanguageFn } from 'highlight.js';

const loaders: Record<string, () => Promise<{ default: LanguageFn }>> = {
  javascript: () => import('highlight.js/lib/languages/javascript'),
  typescript: () => import('highlight.js/lib/languages/typescript'),
  python: () => import('highlight.js/lib/languages/python'),
  json: () => import('highlight.js/lib/languages/json'),
  bash: () => import('highlight.js/lib/languages/bash'),
  sql: () => import('highlight.js/lib/languages/sql'),
  xml: () => import('highlight.js/lib/languages/xml'),
  css: () => import('highlight.js/lib/languages/css'),
  yaml: () => import('highlight.js/lib/languages/yaml'),
  rust: () => import('highlight.js/lib/languages/rust'),
  go: () => import('highlight.js/lib/languages/go'),
  java: () => import('highlight.js/lib/languages/java'),
  c: () => import('highlight.js/lib/languages/c'),
  cpp: () => import('highlight.js/lib/languages/cpp'),
  csharp: () => import('highlight.js/lib/languages/csharp'),
  php: () => import('highlight.js/lib/languages/php'),
  ruby: () => import('highlight.js/lib/languages/ruby'),
  swift: () => import('highlight.js/lib/languages/swift'),
  kotlin: () => import('highlight.js/lib/languages/kotlin'),
  diff: () => import('highlight.js/lib/languages/diff'),
  markdown: () => import('highlight.js/lib/languages/markdown'),
};
const aliases: Record<string, string> = {
  js: 'javascript', jsx: 'javascript', ts: 'typescript', tsx: 'typescript',
  py: 'python', sh: 'bash', shell: 'bash', zsh: 'bash', html: 'xml', svg: 'xml',
  yml: 'yaml', rs: 'rust', golang: 'go', cs: 'csharp', 'c#': 'csharp',
  'c++': 'cpp', rb: 'ruby', kt: 'kotlin', md: 'markdown',
};
const loading = new Map<string, Promise<void>>();

function loadLanguage(language: string): Promise<void> {
  let pending = loading.get(language);
  if (!pending) {
    pending = loaders[language]().then((grammar) => { hljs.registerLanguage(language, grammar.default); });
    loading.set(language, pending);
    void pending.catch(() => { loading.delete(language); });
  }
  return pending;
}

export async function highlightCode(code: string, label: string): Promise<string | null> {
  const language = aliases[label.toLowerCase()] ?? label.toLowerCase();
  // Keep unknown languages and oversized blocks readable without auto-detection.
  if (!Object.hasOwn(loaders, language) || code.length > 50_000) return null;
  await loadLanguage(language);
  if (language === 'typescript' || language === 'javascript') await loadLanguage('xml');
  return hljs.highlight(code, { language, ignoreIllegals: true }).value;
}
