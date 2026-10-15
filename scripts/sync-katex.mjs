import { createRequire } from 'node:module';
import { copyFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const source = dirname(require.resolve('katex/dist/katex.min.css'));
const version = require('katex/package.json').version;
const destination = new URL(`../public/vendor/katex/${version}/`, import.meta.url);
mkdirSync(new URL('fonts/', destination), { recursive: true });
// Expo Metro cannot resolve relative font URLs imported from CSS. Serve the
// official CSS and matching local WOFF2 fonts as ordinary public web assets.
const css = readFileSync(join(source, 'katex.min.css'), 'utf8')
  .replace(/,url\(fonts\/[^)]+\.(?:woff|ttf)\) format\("(?:woff|truetype)"\)/g, '');
writeFileSync(new URL('katex.min.css', destination), css);
for (const font of readdirSync(join(source, 'fonts'))) {
  if (font.endsWith('.woff2')) copyFileSync(join(source, 'fonts', font), new URL(`fonts/${font}`, destination));
}
copyFileSync(join(source, '..', 'LICENSE'), new URL('LICENSE', destination));
console.log(`Prepared local KaTeX ${version} CSS and WOFF2 fonts.`);
