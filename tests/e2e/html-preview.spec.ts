import { test, expect } from '@playwright/test';
import * as path from 'path';
import { launchElectron } from '../helpers';

test('HTML preview renders sanitized output; inline script does not execute', async () => {
  const fixturePath = path.resolve('tests/fixtures/sample.html');
  const app = await launchElectron();
  const win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');

  let dialogFired = false;
  win.on('dialog', () => { dialogFired = true; });

  await win.evaluate((p: string) => window.orpad.dropFile(p), fixturePath);

  // renderHTMLPreview() writes content into a sandboxed srcdoc iframe inside #content.
  // Use frameLocator to reach into the iframe's document.
  const iframe = win.frameLocator('#content iframe');
  await expect(iframe.locator('h1').first()).toBeVisible({ timeout: 8000 });

  // Allow a short settle time; the alert(1) must NOT have fired
  await win.waitForTimeout(300);
  expect(dialogFired).toBe(false);

  await app.close();
});
