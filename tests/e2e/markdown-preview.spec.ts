import { test, expect } from '@playwright/test';
import * as path from 'path';
import { launchElectron } from '../helpers';

test('markdown file preview renders heading and fenced code block', async () => {
  const fixturePath = path.resolve('tests/fixtures/sample.md');
  const app = await launchElectron();
  const win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');

  await win.evaluate((p: string) => window.orpad.dropFile(p), fixturePath);

  const preview = win.locator('#content');
  await expect(preview.locator('h1')).toHaveText('Hello World', { timeout: 8000 });
  await expect(preview.locator('pre code')).toBeVisible({ timeout: 5000 });

  await app.close();
});
