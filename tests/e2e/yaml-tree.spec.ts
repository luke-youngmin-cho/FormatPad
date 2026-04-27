import { test, expect } from '@playwright/test';
import * as path from 'path';
import { launchElectron } from '../helpers';

test('YAML file displays tree view with nested keys', async () => {
  const fixturePath = path.resolve('tests/fixtures/sample.yaml');
  const app = await launchElectron();
  const win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');

  await win.evaluate((p: string) => window.orpad.dropFile(p), fixturePath);

  // YAML uses the same JSON-editor tree renderer
  await expect(win.locator('.jedit-tree')).toBeVisible({ timeout: 8000 });

  const keyNames = win.locator('.jedit-key-name');
  await expect(keyNames.filter({ hasText: 'name' }).first()).toBeVisible({ timeout: 5000 });

  await app.close();
});
