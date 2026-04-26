import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
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

  const userData = await app.evaluate(({ app: electronApp }) => electronApp.getPath('userData'));
  const mcpConfigPath = path.join(userData, 'mcp-servers.json');
  fs.writeFileSync(mcpConfigPath, JSON.stringify({
    version: 1,
    servers: [{
      id: 'filesystem',
      label: 'Filesystem (workspace)',
      transport: 'stdio',
      enabled: true,
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem@2026.1.14', '${workspacePath}'],
      env: {},
      description: 'Stale enabled state from a previous session.',
      readOnlyDefault: true,
    }],
  }, null, 2), 'utf-8');

  await win.locator('.ai-mode-tabs button[data-mode="mcp"]').click();
  await expect(win.locator('.ai-mcp-panel')).toContainText('MCP servers');
  const filesystemCard = win.locator('.ai-mcp-card').filter({ hasText: 'Filesystem (workspace)' });
  await expect(filesystemCard.getByRole('checkbox', { name: 'Enable Filesystem (workspace)' })).not.toBeChecked();
  await win.locator('.ai-mcp-panel').getByRole('button', { name: 'Refresh' }).click();
  await expect(win.locator('.ai-action-status')).toContainText('MCP server status refreshed.');
  const savedMcpConfig = JSON.parse(fs.readFileSync(mcpConfigPath, 'utf-8'));
  expect(savedMcpConfig.servers.find((server: { id?: string }) => server.id === 'filesystem')?.enabled).toBe(false);
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
  await expect(win.locator('.terminal-new-popover')).toContainText('AI CLI apps');
  await expect(win.locator('.terminal-shell-card[data-profile-kind="ai-cli"]')).toHaveCount(3);
  const shellCardCount = await win.locator('.terminal-shell-card').count();
  const shellEmptyCount = await win.locator('.terminal-shell-empty').count();
  expect(shellCardCount + shellEmptyCount).toBeGreaterThan(0);

  await win.evaluate(() => (window as any).formatpadCommands.runCommand('git.openPanel'));
  await expect(win.locator('#fmt-modal')).toContainText('Git Status and Commands');

  await app.close();
});
