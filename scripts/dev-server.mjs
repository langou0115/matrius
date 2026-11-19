import { createHash } from 'node:crypto';
import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cacheDir = join(root, 'node_modules', '.cache', 'matrius-server');

// Stat source files without reading their contents. Exclude tests and large
// vendor binaries; resource paths still refer to the original source directory.
export async function sourceSnapshot(directory, options = {}) {
  const {
    pattern = /\.(?:ts|json|sql)$/u,
    skipDirs = ['tests', 'vendor', 'node_modules', '.data', '.venv'],
  } = options;
  const entries = await readdir(directory, { withFileTypes: true });
  const groups = await Promise.all(entries.map(async (entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      return skipDirs.includes(entry.name)
        ? [] : sourceSnapshot(path, { pattern, skipDirs });
    }
    if (pattern && !pattern.test(entry.name)) return [];
    const info = await stat(path);
    return [[path, info.size, info.mtimeMs, info.ctimeMs]];
  }));
  return groups.flat().sort(([left], [right]) => left.localeCompare(right));
}

export async function prepareServer() {
  const startedAt = performance.now();
  const inputs = await Promise.all([
    sourceSnapshot(join(root, 'server')),
    sourceSnapshot(join(root, 'contract')),
    readFile(join(root, 'package-lock.json'), 'utf8'),
    readFile(join(root, 'package.json'), 'utf8'),
    readFile(join(root, 'tsconfig.json'), 'utf8'),
    readFile(fileURLToPath(import.meta.url), 'utf8'),
  ]);
  const key = createHash('sha256').update(JSON.stringify([process.version, ...inputs])).digest('hex');
  const manifestPath = join(cacheDir, 'manifest.json');
  try {
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    if (manifest?.key === key && Array.isArray(manifest.files) && manifest.files.includes('main.mjs')
      && manifest.files.every((file) => typeof file === 'string' && /^[\w-]+\.mjs$/u.test(file))) {
      await Promise.all(manifest.files.map((file) => stat(join(cacheDir, file))));
      console.log(`Node API build cache hit (${((performance.now() - startedAt) / 1000).toFixed(2)}s).`);
      return join(cacheDir, 'main.mjs');
    }
  } catch (error) {
    if (!['ENOENT', 'ENOTDIR'].includes(error.code) && !(error instanceof SyntaxError)) throw error;
  }

  console.log('Preparing Node API build cache (source or dependencies changed)...');
  const { build, transformWithOxc } = await import('vite');
  await build({
    root,
    configFile: false,
    envDir: false,
    mode: 'development',
    logLevel: 'warn',
    // Bundle the large ESM schema graphs into a few files. Leave packages with
    // native binaries, workers or runtime assets external to preserve resolution.
    ssr: { noExternal: ['zod', 'typebox'] },
    plugins: [{
      name: 'preserve-server-resource-paths',
      transform(code, id) {
        if (!id.startsWith(join(root, 'server').replaceAll('\\', '/')) || !id.endsWith('.ts') || !code.includes('import.meta.url')) return;
        return transformWithOxc(code, id, {
          define: { 'import.meta.url': JSON.stringify(pathToFileURL(id).href) },
          sourcemap: true,
        });
      },
    }],
    build: {
      ssr: join(root, 'server', 'app.ts'),
      outDir: cacheDir,
      emptyOutDir: true,
      copyPublicDir: false,
      minify: false,
      sourcemap: true,
      rolldownOptions: { output: { entryFileNames: 'main.mjs', chunkFileNames: '[name]-[hash].mjs' } },
    },
  });
  const files = (await readdir(cacheDir)).filter((file) => file.endsWith('.mjs'));
  await writeFile(manifestPath, JSON.stringify({ key, files }));
  console.log(`Node API build cache prepared in ${((performance.now() - startedAt) / 1000).toFixed(2)}s.`);
  return join(cacheDir, 'main.mjs');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  prepareServer().then((entry) => import(pathToFileURL(entry).href)).then(({ start }) => start()).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
