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
  const filesystemCard = win.locator('.ai-mcp-card').filter({ hasText: 'Filesystem (workspace)' });
  await filesystemCard.getByRole('button', { name: 'Tools' }).click();
  await expect(win.locator('.ai-action-status')).toContainText('Enable Filesystem (workspace) before using MCP tools.');
  await filesystemCard.getByRole('button', { name: 'Resources' }).click();
  await expect(win.locator('.ai-action-status')).toContainText('Enable Filesystem (workspace) before using MCP resources.');
  await expect(filesystemCard.getByRole('button', { name: 'Open URI' })).toBeVisible();

  await win.locator('#btn-terminal').click();
  await expect(win.locator('.terminal-panel')).toBeVisible();
  await expect(win.locator('.terminal-new')).toHaveCount(0);
  await expect(win.locator('.terminal-kill')).toHaveCount(0);
  await expect(win.locator('.terminal-tab-add')).toBeVisible();
  await win.locator('.terminal-tab-add').click();
  await expect(win.locator('.terminal-new-panel')).toHaveCount(0);
  await expect(win.locator('.terminal-new-popover')).toBeVisible();
  await expect(win.locator('.terminal-new-popover')).toHaveCSS('position', 'fixed');
  await expect(win.locator('.terminal-new-popover')).toContainText('Choose a shell profile');
  const shellCardCount = await win.locator('.terminal-shell-card').count();
  const shellEmptyCount = await win.locator('.terminal-shell-empty').count();
  expect(shellCardCount + shellEmptyCount).toBeGreaterThan(0);

  await win.evaluate(() => (window as any).formatpadCommands.runCommand('git.openPanel'));
  await expect(win.locator('#fmt-modal')).toContainText('Git Status and Commands');

  await app.close();
});
