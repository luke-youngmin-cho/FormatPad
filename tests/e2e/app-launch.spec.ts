import { test, expect } from '@playwright/test';
import { launchElectron } from '../helpers';

test('desktop app launches, window title contains FormatPad', async () => {
  const app = await launchElectron();
  const win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');

  await expect(win).toHaveTitle(/FormatPad/);
  await expect(win.locator('#btn-ai')).toBeVisible();
  await expect(win.locator('#btn-mcp')).toBeVisible();
  await expect(win.locator('#btn-git')).toBeVisible();

  await win.locator('#btn-ai').click();
  await expect(win.locator('.ai-sidebar')).toBeVisible();

  await win.locator('#btn-mcp').click();
  await expect(win.locator('.ai-mcp-panel')).toContainText('MCP servers');

  await win.locator('#btn-git').click();
  await expect(win.locator('#fmt-modal')).toContainText('Git Status and Commands');

  await app.close();
});
