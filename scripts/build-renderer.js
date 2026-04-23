const esbuild = require('esbuild');
const path = require('path');
const fs = require('fs');

const distDir = path.join(__dirname, '../dist');
if (!fs.existsSync(distDir)) fs.mkdirSync(distDir, { recursive: true });

esbuild.buildSync({
  entryPoints: [path.join(__dirname, '../src/renderer/renderer.js')],
  bundle: true,
  outfile: path.join(distDir, 'renderer.js'),
  platform: 'browser',
  format: 'iife',
  minify: process.argv.includes('--minify'),
  sourcemap: false,
  target: ['chrome120'],
  loader: { '.css': 'text' },
  define: {
    'process.env.NODE_ENV': '"production"',
  },
});

console.log('FormatPad renderer bundled successfully.');
