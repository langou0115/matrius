// Compile application TS/TSX for Node's test runner without a second build tool.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join, resolve as resolvePath } from 'node:path';

// React Router's hooks need a mounted router and these tests never navigate, so the
// navigation module is replaced with a no-op stand-in before it can be loaded.
const ROUTER_STUB = new URL('./stubs/router.mjs', import.meta.url);

/** Vite replaces these at build time; tests toggle globals instead. */
const DEV_FLAG = /import\.meta\.env\.DEV/g;
const TARGET_FLAG = /import\.meta\.env\.VITE_MATRIUS_TARGET/g;

const CACHE_DIR = resolvePath('node_modules/.cache/matrius-test-ts');
const CACHE_VERSION = 'v1-es2022-react-jsx';
let cacheDirReady = false;
let tsPromise = null;

function loadTypeScript() {
  tsPromise ??= import('typescript').then((mod) => mod.default ?? mod);
  return tsPromise;
}

function readCached(cacheFile) {
  try {
    return readFileSync(cacheFile, 'utf8');
  } catch {
    return null;
  }
}

function writeCached(cacheFile, outputText) {
  try {
    if (!cacheDirReady) {
      mkdirSync(CACHE_DIR, { recursive: true });
      cacheDirReady = true;
    }
    const tmpFile = `${cacheFile}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    writeFileSync(tmpFile, outputText, 'utf8');
    try {
      renameSync(tmpFile, cacheFile);
    } catch {
      try { unlinkSync(tmpFile); } catch { /* ignore */ }
    }
  } catch {
    // Cache is best-effort; never fail a test run if disk cache is unavailable.
  }
}

export async function resolve(specifier, context, nextResolve) {
  if (specifier === '@/router') {
    return { url: ROUTER_STUB.href, shortCircuit: true };
  }
  // Stylesheets only exist for the browser bundle.
  if (specifier.endsWith('.css')) {
    return { url: 'data:text/javascript,export default {}', shortCircuit: true };
  }
  const local = specifier.startsWith('@contract/')
    ? pathToFileURL(resolvePath('contract', specifier.slice('@contract/'.length)))
    : specifier.startsWith('@/')
      ? pathToFileURL(resolvePath('ui', specifier.slice(2)))
      : specifier.startsWith('.') && context.parentURL ? new URL(specifier, context.parentURL) : null;
  if (local?.protocol === 'file:' && !local.pathname.includes('/node_modules/')) {
    for (const extension of ['', '.ts', '.tsx']) {
      const file = fileURLToPath(local) + extension;
      if (/\.tsx?$/.test(file) && existsSync(file)) return { url: pathToFileURL(file).href, shortCircuit: true };
    }
  }
  return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
  if (/\.tsx?$/.test(url) && !url.includes('/node_modules/')) {
    const filePath = fileURLToPath(url);
    const rawSource = readFileSync(filePath, 'utf8');
    const hash = createHash('sha1')
      .update(CACHE_VERSION)
      .update('\0')
      .update(filePath)
      .update('\0')
      .update(rawSource)
      .digest('hex');
    const cacheFile = join(CACHE_DIR, `${hash}.mjs`);
    const cached = readCached(cacheFile);
    if (cached !== null) {
      return { format: 'module', source: cached, shortCircuit: true };
    }

    const source = rawSource
      .replace(DEV_FLAG, '(globalThis.__DEV__ === true)')
      .replace(TARGET_FLAG, "(globalThis.__MATRIUS_TARGET__ ?? 'web')");
    const ts = await loadTypeScript();
    const { outputText } = ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
      fileName: filePath,
    });
    writeCached(cacheFile, outputText);
    return { format: 'module', source: outputText, shortCircuit: true };
  }
  return nextLoad(url, context);
}
