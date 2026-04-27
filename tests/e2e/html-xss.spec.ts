import { test, expect } from '@playwright/test';
import * as path from 'path';
import { launchElectron } from '../helpers';

test('HTML preview: XSS vectors are neutralized by DOMPurify + iframe sandbox', async () => {
  const fixturePath = path.resolve('tests/fixtures/p0-6/xss.html');
  const app = await launchElectron();
  const win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');

  let dialogFired = false;
  win.on('dialog', () => { dialogFired = true; });

  await win.evaluate((p: string) => window.orpad.dropFile(p), fixturePath);

  // Wait for the HTML preview iframe to render
  const preview = win.locator('#content');
  await expect(preview.locator('iframe')).toBeVisible({ timeout: 8000 });

  // Allow scripts time to execute if they weren't blocked
  await win.waitForTimeout(500);

  // None of the XSS globals should be set on the outer (renderer) window
  const xssGlobals = await win.evaluate(() => ({
    ran: (window as any).__XSS_RAN,
    img: (window as any).__XSS_IMG,
    link: (window as any).__XSS_LINK,
    frame: (window as any).__XSS_FRAME,
    svg: (window as any).__XSS_SVG,
  }));

  expect(xssGlobals.ran).toBeUndefined();
  expect(xssGlobals.img).toBeUndefined();
  expect(xssGlobals.link).toBeUndefined();
  expect(xssGlobals.frame).toBeUndefined();
  expect(xssGlobals.svg).toBeUndefined();

  // No dialog (alert/confirm/prompt) should have fired
  expect(dialogFired).toBe(false);

  await app.close();
});
