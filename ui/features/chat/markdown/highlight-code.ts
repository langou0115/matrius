// Use Shiki's official tokenizer and HTML renderer; no local grammar or token renderer.
async function loadEngine() {
  const [{ createHighlighterCore }, { createOnigurumaEngine }, { bundledLanguages }, light, dark] = await Promise.all([
    import('shiki/core'),
    import('shiki/engine/oniguruma'),
    import('shiki/langs'),
    import('shiki/themes/one-light.mjs'),
    import('shiki/themes/one-dark-pro.mjs'),
  ]);
  const highlighter = await createHighlighterCore({
    engine: createOnigurumaEngine(import('shiki/wasm')),
    themes: [light, dark],
    langs: [],
  });
  return { highlighter, languages: bundledLanguages };
}

let enginePromise: ReturnType<typeof loadEngine> | undefined;
const loading = new Map<string, Promise<void>>();
const aliases: Record<string, string> = {
  psm1: 'powershell', psd1: 'powershell', cmd: 'bat', batch: 'bat', dos: 'bat',
  shell: 'shellscript', zsh: 'shellscript',
};

export async function highlightCode(code: string, label: string): Promise<string | null> {
  const normalized = label.trim().toLowerCase();
  const language = Object.hasOwn(aliases, normalized) ? aliases[normalized] : normalized;
  if (!language || ['text', 'txt', 'plain', 'plaintext'].includes(language) || code.length > 50_000) return null;
  enginePromise ??= loadEngine().catch((error: unknown) => { enginePromise = undefined; throw error; });
  const { highlighter, languages } = await enginePromise;
  if (!Object.hasOwn(languages, language)) return null;
  const loader = languages[language as keyof typeof languages];
  let pending = loading.get(language);
  if (!pending) {
    pending = highlighter.loadLanguage(loader).catch((error: unknown) => { loading.delete(language); throw error; });
    loading.set(language, pending);
  }
  await pending;
  const html = highlighter.codeToHtml(code, {
    lang: language,
    themes: { light: 'one-light', dark: 'one-dark-pro' },
    defaultColor: false,
    cssVariablePrefix: '--syntax-',
    tokenizeMaxLineLength: 4000,
  });
  // Keep our accessible scroll container and toolbar; the code subtree is emitted
  // entirely by Shiki, including source escaping and theme styles.
  const start = html.indexOf('<code>');
  const end = html.lastIndexOf('</code>');
  return start >= 0 && end >= start ? html.slice(start + '<code>'.length, end) : null;
}
