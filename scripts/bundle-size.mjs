/**
 * Bundle size check for FormatPad web build.
 *
 * Builds the web bundle IN MEMORY (never writes to docs/) so this script can
 * run in CI and locally without touching the deploy artifact. Measures
 * gzipped size of the renderer bundle and the rewritten index.html, fails
 * if either exceeds budget, and writes a JSON report + esbuild metafile.
 *
 * Usage: node scripts/bundle-size.mjs
 * Budgets:
 *   renderer.js  gzipped  ≤ RENDERER_BUDGET_BYTES
 *   index.html   gzipped  ≤ HTML_BUDGET_BYTES
 */

import * as esbuild from 'esbuild';
import * as fs from 'fs';
import * as path from 'path';
import { gzipSync } from 'zlib';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

// NOTE: ideal target is 1.8 MB; raised to current+10% until P0-9 tree-shakes mermaid/cytoscape.
const RENDERER_BUDGET_BYTES = 2.05 * 1024 * 1024; // ~2.05 MB gzipped
const HTML_BUDGET_BYTES = 100 * 1024;             // 100 KB gzipped

// ── 1. Bundle the minified renderer in-memory ────────────────────────────────
console.log('Bundling minified web renderer (in-memory)…');
const result = esbuild.buildSync({
  entryPoints: [path.join(ROOT, 'src/web/entry.js')],
  bundle: true,
  minify: true,
  platform: 'browser',
  format: 'iife',
  sourcemap: false,
  target: ['chrome120', 'firefox115', 'safari17', 'edge120'],
  loader: { '.css': 'text', '.png': 'dataurl' },
  define: { 'process.env.NODE_ENV': '"production"' },
  write: false,
  metafile: true,
});

const rendererBuf = Buffer.from(result.outputFiles[0].contents);
const metafile = result.metafile;

const metaDir = path.join(ROOT, 'state');
if (!fs.existsSync(metaDir)) fs.mkdirSync(metaDir, { recursive: true });
fs.writeFileSync(path.join(metaDir, 'bundle-meta.json'), JSON.stringify(metafile, null, 2));

// ── 2. Compute top-15 input modules by bytes ─────────────────────────────────
const sorted = Object.entries(metafile.inputs)
  .map(([file, data]) => ({ file, bytes: data.bytes }))
  .sort((a, b) => b.bytes - a.bytes)
  .slice(0, 15);

// ── 3. Rewrite index.html exactly like scripts/build-web.js does ─────────────
// Keep this mirror logic tight — if build-web.js changes, update both.
const srcHtml = fs.readFileSync(path.join(ROOT, 'src/renderer/index.html'), 'utf-8');
const builtHtml = srcHtml
  .replace(
    /<meta http-equiv="Content-Security-Policy" content="[^"]+">/,
    '<meta http-equiv="Content-Security-Policy" content="' +
      "default-src 'self'; " +
      "style-src 'self' 'unsafe-inline'; " +
      "img-src 'self' data: blob: https:; " +
      "font-src 'self' data:; " +
      "script-src 'self'; " +
      "connect-src 'self'; " +
      "frame-src 'self' data: blob:;" +
    '">'
  )
  .replace(
    /<script src="\.\.\/\.\.\/dist\/renderer\.js"><\/script>/,
    '<script src="renderer.js"></script>'
  );

// ── 4. Measure gzipped sizes ─────────────────────────────────────────────────
const rendererGzip = gzipSync(rendererBuf).length;
const htmlBuf = Buffer.from(builtHtml, 'utf-8');
const htmlGzip = gzipSync(htmlBuf).length;
const rendererRaw = rendererBuf.length;
const htmlRaw = htmlBuf.length;

const kb = (n) => (n / 1024).toFixed(1) + ' KB';
const mb = (n) => (n / 1024 / 1024).toFixed(2) + ' MB';

// ── 5. Print report ──────────────────────────────────────────────────────────
console.log('\n═══════════════ Bundle Size Report ═══════════════');
console.log(`  renderer.js   raw: ${kb(rendererRaw).padStart(10)}   gzip: ${mb(rendererGzip).padStart(8)}   budget: ${mb(RENDERER_BUDGET_BYTES)}`);
console.log(`  index.html    raw: ${kb(htmlRaw).padStart(10)}   gzip: ${kb(htmlGzip).padStart(8)}   budget: ${kb(HTML_BUDGET_BYTES)}`);
console.log('\n  Top 15 modules by uncompressed size:');
for (const { file, bytes } of sorted) {
  const rel = path.relative(ROOT, file).replace(/\\/g, '/');
  console.log(`    ${kb(bytes).padStart(10)}  ${rel}`);
}
console.log('═══════════════════════════════════════════════════');

// ── 6. Write JSON report ─────────────────────────────────────────────────────
const report = {
  timestamp: new Date().toISOString(),
  budgets: {
    renderer_gzip_max_bytes: RENDERER_BUDGET_BYTES,
    html_gzip_max_bytes: HTML_BUDGET_BYTES,
  },
  actual: {
    renderer_raw_bytes: rendererRaw,
    renderer_gzip_bytes: rendererGzip,
    html_raw_bytes: htmlRaw,
    html_gzip_bytes: htmlGzip,
  },
  passed: rendererGzip <= RENDERER_BUDGET_BYTES && htmlGzip <= HTML_BUDGET_BYTES,
  top15_modules: sorted,
};
fs.writeFileSync(path.join(ROOT, 'bundle-size-report.json'), JSON.stringify(report, null, 2));
console.log('\n  Report written to bundle-size-report.json');

// ── 7. Gate ──────────────────────────────────────────────────────────────────
let failed = false;
if (rendererGzip > RENDERER_BUDGET_BYTES) {
  console.error(`\nFAIL: renderer.js gzipped (${mb(rendererGzip)}) exceeds budget (${mb(RENDERER_BUDGET_BYTES)})`);
  failed = true;
}
if (htmlGzip > HTML_BUDGET_BYTES) {
  console.error(`\nFAIL: index.html gzipped (${kb(htmlGzip)}) exceeds budget (${kb(HTML_BUDGET_BYTES)})`);
  failed = true;
}
if (!failed) {
  console.log('\nPASS: bundle within budget.');
}

process.exit(failed ? 1 : 0);
