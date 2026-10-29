import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * `web.output: "single"` exports a static SPA shell and does not apply
 * `app/+html.tsx`. Inject the PWA tags into the exported shell so browsers
 * see the manifest and touch icon before hydration.
 */
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const file = resolve(root, 'dist/index.html');

const tags = [
  '<meta name="theme-color" content="#ffffff" />',
  '<link rel="manifest" href="/manifest.json" />',
  '<link rel="apple-touch-icon" href="/icons/apple-touch-icon.png" />',
  '<meta name="apple-mobile-web-app-capable" content="yes" />',
  '<meta name="apple-mobile-web-app-status-bar-style" content="default" />',
  '<meta name="apple-mobile-web-app-title" content="Matrius" />',
].join('\n    ');

let html = await readFile(file, 'utf8');
if (html.includes('rel="manifest"')) {
  console.log('PWA metadata already present in dist/index.html');
  process.exit(0);
}
if (!html.includes('</head>')) throw new Error('dist/index.html has no </head>');

html = html.replace('<html lang="en">', '<html lang="zh-CN">');
html = html.replace('</head>', `    ${tags}\n  </head>`);
await writeFile(file, html);
console.log('Injected PWA metadata into dist/index.html');
