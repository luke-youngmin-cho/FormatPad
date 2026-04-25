import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import LZString from 'lz-string';
import { startStaticServer } from '../../helpers';

const docsDir = path.resolve('docs');

test.beforeEach(() => {
  if (!fs.existsSync(path.join(docsDir, 'index.html'))) {
    test.skip(true, 'docs/ not built - run npm run build:web:min first');
  }
});

test('share fragments load from URL hash without query leakage', async ({ page }) => {
  const { url, close } = await startStaticServer(docsDir);
  const compressed = LZString.compressToEncodedURIComponent('# Shared\n\nfrom hash');

  await page.goto(`${url}/#fragment=${compressed}&name=hash-share.md`);
  await expect(page.locator('.tab-item')).toContainText('hash-share.md');
  await expect(page.locator('.cm-content')).toContainText('from hash');

  const current = new URL(page.url());
  expect(current.search).toBe('');
  expect(current.hash).toContain('fragment=');

  await close();
});

test('legacy query fragments migrate to hash after load', async ({ page }) => {
  const { url, close } = await startStaticServer(docsDir);
  const compressed = LZString.compressToEncodedURIComponent('legacy query content');

  await page.goto(`${url}/?fragment=${compressed}&name=legacy.md`);
  await expect(page.locator('.tab-item')).toContainText('legacy.md');

  const current = new URL(page.url());
  expect(current.search).not.toContain('fragment=');
  expect(current.hash).toContain('fragment=');

  await close();
});

test('web URL fetch rejects bodies over the safety cap', async ({ page }) => {
  const { url, close } = await startStaticServer(docsDir);
  await page.route('https://example.com/large.md', route => route.fulfill({
    status: 200,
    contentType: 'text/plain',
    body: 'x'.repeat(10 * 1024 * 1024 + 1),
  }));
  page.on('dialog', dialog => dialog.accept());

  await page.goto(url);
  const message = await page.evaluate(async () => {
    try {
      await (window as any).formatpad.fetchUrlText('https://example.com/large.md', { skipHostConfirmation: true });
      return null;
    } catch (err) {
      return (err as Error).message;
    }
  });

  expect(message).toContain('safety limit');

  await close();
});
