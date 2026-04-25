const esbuild = require('esbuild');
const path = require('path');
const fs = require('fs');

const distDir = path.join(__dirname, '../dist');
if (!fs.existsSync(distDir)) fs.mkdirSync(distDir, { recursive: true });

esbuild.build({
  entryPoints: [path.join(__dirname, '../src/renderer/renderer.js')],
  bundle: true,
  outfile: path.join(distDir, 'renderer.js'),
  platform: 'browser',
  format: 'iife',
  minify: process.argv.includes('--minify'),
  sourcemap: false,
  target: ['chrome120'],
  loader: { '.css': 'text' },
  plugins: [{
    name: 'browser-safe-aliases',
    setup(build) {
      build.onResolve({ filter: /^isomorphic-git$/ }, () => ({
        path: path.join(__dirname, '../node_modules/isomorphic-git/index.js'),
      }));
    },
  }],
  define: {
    'process.env.NODE_ENV': '"production"',
    'process.env.FORMATPAD_WEB': '"false"',
    'process.env.PLAUSIBLE_DOMAIN': JSON.stringify(process.env.PLAUSIBLE_DOMAIN || ''),
    'process.env.APP_VERSION': JSON.stringify(require('../package.json').version),
  },
}).then(() => {
  console.log('FormatPad renderer bundled successfully.');
}).catch((err) => {
  console.error(err);
  process.exit(1);
});
