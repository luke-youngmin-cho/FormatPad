import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RELEASE_DIR = path.join(ROOT, 'release');
const PACKAGE = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8'));
const manifestName = String(process.env.FORMATPAD_RELEASE_MANIFEST_NAME || 'formatpad-release-manifest.json').trim();
const OUT_FILE = path.join(RELEASE_DIR, manifestName);

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

function privateKeyObject(value) {
  const key = String(value || '').trim();
  if (!key) throw new Error('FORMATPAD_RELEASE_SIGNING_PRIVATE_KEY is required.');
  if (key.includes('BEGIN PRIVATE KEY')) return crypto.createPrivateKey(key);
  return crypto.createPrivateKey({
    key: Buffer.from(key, 'base64'),
    format: 'der',
    type: 'pkcs8',
  });
}

function sha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

if (!fs.existsSync(RELEASE_DIR)) {
  throw new Error('release directory does not exist. Run electron-builder first.');
}

const installers = fs.readdirSync(RELEASE_DIR)
  .filter(name => /\.(exe|dmg)$/i.test(name))
  .sort();

if (!installers.length) {
  throw new Error('No installer assets found in release/.');
}

const manifest = {
  schema: 1,
  product: 'FormatPad',
  version: PACKAGE.version,
  createdAt: new Date().toISOString(),
  files: installers.map((name) => {
    const filePath = path.join(RELEASE_DIR, name);
    return {
      name,
      size: fs.statSync(filePath).size,
      sha256: sha256(filePath),
    };
  }),
};

const signature = crypto.sign(
  null,
  Buffer.from(stableStringify(manifest), 'utf-8'),
  privateKeyObject(process.env.FORMATPAD_RELEASE_SIGNING_PRIVATE_KEY)
).toString('base64');

fs.writeFileSync(OUT_FILE, `${JSON.stringify({
  ...manifest,
  signature: {
    algorithm: 'ed25519',
    value: signature,
  },
}, null, 2)}\n`, 'utf-8');

console.log(`Wrote signed release manifest: ${path.relative(ROOT, OUT_FILE)}`);
