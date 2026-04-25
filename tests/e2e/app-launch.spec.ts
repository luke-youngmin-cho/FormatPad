import { test, expect } from '@playwright/test';
import { launchElectron } from '../helpers';

test('desktop app launches, window title contains FormatPad', async () => {
  const app = await launchElectron();
  const win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');

  await expect(win).toHaveTitle(/FormatPad/);
  await expect(win.locator('#btn-ai')).toBeVisible();
  await expect(win.locator('#btn-mcp')).toHaveCount(0);
  await expect(win.locator('#btn-git')).toHaveCount(0);

  await win.locator('#btn-ai').click();
  await expect(win.locator('.ai-sidebar')).toBeVisible();
  await expect(win.locator('.ai-context-chip')).toContainText('No active document');

  await win.locator('#btn-ai').click();
  await expect(win.locator('.ai-sidebar')).toBeHidden();

  await win.locator('#btn-ai').click();
  await expect(win.locator('.ai-sidebar')).toBeVisible();
  await win.evaluate(() => (window as any).formatpadCommands.runCommand('file.new'));
  await expect(win.locator('.ai-context-chip')).toContainText('Context:');

  await win.locator('.ai-mode-tabs button[data-mode="mcp"]').click();
  await expect(win.locator('.ai-mcp-panel')).toContainText('MCP servers');

  await win.evaluate(() => (window as any).formatpadCommands.runCommand('git.openPanel'));
  await expect(win.locator('#fmt-modal')).toContainText('Git Status and Commands');

  await app.close();
});
