const esbuild = require('esbuild');
const path = require('path');
const fs = require('fs');

const distDir = path.join(__dirname, '../dist');
if (!fs.existsSync(distDir)) fs.mkdirSync(distDir, { recursive: true });

const common = {
  bundle: true,
  platform: 'browser',
  format: 'iife',
  minify: process.argv.includes('--minify'),
  sourcemap: false,
  target: ['chrome120'],
  loader: { '.css': 'text' },
  define: {
    'process.env.NODE_ENV': '"production"',
    'process.env.ORPAD_WEB': '"false"',
    'process.env.PLAUSIBLE_DOMAIN': JSON.stringify(process.env.PLAUSIBLE_DOMAIN || ''),
    'process.env.APP_VERSION': JSON.stringify(require('../package.json').version),
  },
};

const browserSafeAliases = {
  name: 'browser-safe-aliases',
  setup(build) {
    build.onResolve({ filter: /^isomorphic-git$/ }, () => ({
      path: path.join(__dirname, '../node_modules/isomorphic-git/index.js'),
    }));
  },
};

Promise.all([
  esbuild.build({
    ...common,
    entryPoints: [path.join(__dirname, '../src/renderer/renderer.js')],
    outfile: path.join(distDir, 'renderer.js'),
    plugins: [browserSafeAliases],
  }),
  esbuild.build({
    ...common,
    entryPoints: [path.join(__dirname, '../src/renderer/terminal-window.js')],
    outfile: path.join(distDir, 'terminal-window.js'),
  }),
]).then(() => {
  console.log('OrPAD renderer bundled successfully.');
}).catch((err) => {
  console.error(err);
  process.exit(1);
});
