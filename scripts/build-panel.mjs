/**
 * [graft-Max N8] 面板前端构建：panel/main.ts → dist/panel/app.js（esbuild），
 * 并把 index.html / style.css 原样拷过去。
 *
 * 与 `build-viewer.mjs` 同一套做法（esbuild、零运行时依赖、产物随包发布），
 * 所以 `node dist/cli.js mcp` 起来就能用，不需要用户装任何前端工具链。
 *
 * 为什么不 minify：面板是给人排查问题的地方，`/app.js` 保持可读，现场看一眼
 * 就能对上 `panel/main.ts` 的行号。
 */
import { build } from 'esbuild';
import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const outDir = join(root, 'dist', 'panel');
mkdirSync(outDir, { recursive: true });

const result = await build({
  entryPoints: [join(root, 'panel', 'main.ts')],
  bundle: true,
  minify: false,
  sourcemap: false,
  format: 'iife',
  target: 'es2020',
  outfile: join(outDir, 'app.js'),
  logLevel: 'warning',
  metafile: true,
});

for (const asset of ['index.html', 'style.css']) {
  const src = join(root, 'panel', asset);
  if (!existsSync(src)) throw new Error(`panel asset missing: ${src}`);
  copyFileSync(src, join(outDir, asset));
}

const bytes = statSync(join(outDir, 'app.js')).size;
const files = Object.keys(result.metafile?.outputs ?? {}).length;
console.log(`panel bundle → dist/panel/ (app.js ${(bytes / 1024).toFixed(1)} KB, ${files} outputs)`);
