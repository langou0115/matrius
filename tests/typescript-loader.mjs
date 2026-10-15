// Compile application TS/TSX for Node's test runner without a second build tool.
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve as resolvePath } from 'node:path';
import ts from 'typescript';

export async function resolve(specifier, context, nextResolve) {
  const local = specifier.startsWith('@/')
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
    const { outputText } = ts.transpileModule(readFileSync(fileURLToPath(url), 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
      fileName: fileURLToPath(url),
    });
    return { format: 'module', source: outputText, shortCircuit: true };
  }
  return nextLoad(url, context);
}
