// Compile application TS/TSX for Node's test runner without a second build tool.
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve as resolvePath } from 'node:path';
import ts from 'typescript';

// React Router's hooks need a mounted router and these tests never navigate, so the
// navigation module is replaced with a no-op stand-in before it can be loaded.
const ROUTER_STUB = new URL('./stubs/router.mjs', import.meta.url);

/** Vite replaces this at build time; tests toggle `globalThis.__DEV__` instead. */
const DEV_FLAG = /import\.meta\.env\.DEV/g;

export async function resolve(specifier, context, nextResolve) {
  if (specifier === '@/router') {
    return { url: ROUTER_STUB.href, shortCircuit: true };
  }
  // Stylesheets only exist for the browser bundle.
  if (specifier.endsWith('.css')) {
    return { url: 'data:text/javascript,export default {}', shortCircuit: true };
  }
  const local = specifier.startsWith('@agent/') ? pathToFileURL(resolvePath('agent/src', specifier.slice(7))) : specifier.startsWith('@/')
    ? pathToFileURL(resolvePath('src', specifier.slice(2)))
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
    const source = readFileSync(fileURLToPath(url), 'utf8').replace(DEV_FLAG, '(globalThis.__DEV__ === true)');
    const { outputText } = ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
      fileName: fileURLToPath(url),
    });
    return { format: 'module', source: outputText, shortCircuit: true };
  }
  return nextLoad(url, context);
}
