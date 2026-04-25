import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { startStaticServer } from '../../helpers';

const docsDir = path.resolve('docs');

test('web build loads, new-file works, no console errors', async ({ page }) => {
  if (!fs.existsSync(path.join(docsDir, 'index.html'))) {
    test.skip(true, 'docs/ not built — run npm run build:web:min first');
    return;
  }

  const consoleErrors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });

  const { url, close } = await startStaticServer(docsDir);

  await page.goto(url);
  await page.waitForLoadState('networkidle');

  await expect(page.locator('meta[name="viewport"]')).toHaveAttribute('content', /width=device-width/);

  // Toolbar must be present
  await expect(page.locator('#toolbar')).toBeVisible({ timeout: 10000 });
  await expect(page.locator('#btn-ai')).toBeVisible();
  await expect(page.locator('#btn-mcp')).toHaveCount(0);
  await expect(page.locator('#btn-git')).toHaveCount(0);

  await page.locator('#btn-ai').click();
  await expect(page.locator('.ai-sidebar')).toBeVisible();
  await expect(page.locator('.ai-context-chip')).toContainText('No active document');

  await page.locator('#btn-ai').click();
  await expect(page.locator('.ai-sidebar')).toBeHidden();

  await page.locator('#btn-ai').click();
  await expect(page.locator('.ai-sidebar')).toBeVisible();
  await page.evaluate(() => (window as any).formatpadCommands.runCommand('file.new'));
  await expect(page.locator('.ai-context-chip')).toContainText('Context: Untitled');

  await page.locator('.ai-mode-tabs button[data-mode="mcp"]').click();
  await expect(page.locator('.ai-mcp-panel')).toBeVisible();
  await expect(page.locator('.ai-mcp-panel')).toContainText('MCP is desktop-only');

  await page.evaluate(() => (window as any).formatpadCommands.runCommand('git.openPanel'));
  await expect(page.locator('#fmt-modal')).toContainText('Git Status and Commands');
  await page.locator('#fmt-modal-close').click();

  // Create a new file
  await expect(page.locator('.tab-item')).toBeVisible({ timeout: 5000 });

  // No unexpected console errors (ignore favicon 404s)
  const realErrors = consoleErrors.filter(
    (e) => !e.toLowerCase().includes('favicon'),
  );
  expect(realErrors).toHaveLength(0);

  await close();
});

test('web PWA assets are self-contained for offline install', async () => {
  if (!fs.existsSync(path.join(docsDir, 'index.html'))) {
    test.skip(true, 'docs/ not built - run npm run build:web:min first');
    return;
  }

  const manifest = JSON.parse(fs.readFileSync(path.join(docsDir, 'manifest.webmanifest'), 'utf-8'));
  expect(manifest.start_url).toBe('./');
  expect(manifest.scope).toBe('./');
  expect(manifest.file_handlers?.[0]?.action).toBe('./');

  const sw = fs.readFileSync(path.join(docsDir, 'sw.js'), 'utf-8');
  expect(sw).not.toContain('storage.googleapis.com');
  expect(sw).toContain('styles/fonts/KaTeX_Main-Regular.woff2');
  expect(fs.existsSync(path.join(docsDir, 'styles', 'fonts', 'KaTeX_Main-Regular.woff2'))).toBe(true);
});

test('web file launch consumer and non-FSA save fallback work', async ({ page }) => {
  if (!fs.existsSync(path.join(docsDir, 'index.html'))) {
    test.skip(true, 'docs/ not built - run npm run build:web:min first');
    return;
  }

  const { url, close } = await startStaticServer(docsDir);
  await page.goto(url);
  await page.waitForLoadState('networkidle');

  const opened = await page.evaluate(async () => {
    return await (window as any).formatpad.openFileHandles([{
      kind: 'file',
      name: 'launch.md',
      getFile: async () => new File(['# Launched\n\nfrom file handler'], 'launch.md', { type: 'text/markdown' }),
    }]);
  });
  expect(opened).toBe(true);
  await expect(page.locator('.tab-item')).toContainText('launch.md');
  await expect(page.locator('.cm-content')).toContainText('from file handler');

  const downloadPromise = page.waitForEvent('download');
  const saved = await page.evaluate(async () => {
    return await (window as any).formatpad.saveFile('web:nohandle/fallback.md', '# Download fallback');
  });
  expect(saved).toBe(true);
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('fallback.md');

  await close();
});
