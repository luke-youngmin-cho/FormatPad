import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outFile = path.join(ROOT, 'src', 'main', 'updater-public-key.json');
const publicKey = String(process.env.ORPAD_UPDATER_PUBLIC_KEY || '').trim();

if (!publicKey) {
  throw new Error('ORPAD_UPDATER_PUBLIC_KEY is required for release builds.');
}

fs.writeFileSync(outFile, `${JSON.stringify({
  publicKey,
  generatedAt: new Date().toISOString(),
}, null, 2)}\n`, 'utf-8');

console.log(`Wrote updater public key config: ${path.relative(ROOT, outFile)}`);
