import { test, expect } from '@playwright/test';
import * as path from 'path';
import { launchElectron } from '../helpers';

test('markdown with $…$ renders a .katex element in preview', async () => {
  const fixturePath = path.resolve('tests/fixtures/sample-katex.md');
  const app = await launchElectron();
  const win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');

  await win.evaluate((p: string) => window.orpad.dropFile(p), fixturePath);

  const preview = win.locator('#content');
  await expect(preview.locator('.katex').first()).toBeVisible({ timeout: 10000 });

  await app.close();
});
