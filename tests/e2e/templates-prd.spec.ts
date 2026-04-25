import { test, expect } from '@playwright/test';
import { launchElectron } from '../helpers';

test('creates a PRD from template and shows template status', async () => {
  const app = await launchElectron();
  const win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');

  await win.click('#btn-template');
  await expect(win.locator('.template-picker')).toBeVisible();
  await win.locator('.template-field input').first().fill('Codex PRD Smoke');
  await win.getByRole('button', { name: 'Create' }).click();

  await expect(win.locator('.tab-name').filter({ hasText: 'prd-codex-prd-smoke.md' })).toBeVisible();
  await expect(win.locator('.tab-item.modified').filter({ hasText: 'prd-codex-prd-smoke.md' })).toBeVisible();
  await expect(win.locator('#template-status-host')).toContainText('0/4 sections');
  await expect(win.locator('#template-status-host')).toContainText('3 unchecked');
  await expect(win.locator('.markdown-body h1')).toContainText('Codex PRD Smoke');

  await app.close();
});

test('global file shortcuts do not fire while typing in template fields', async () => {
  const app = await launchElectron();
  const win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');

  const before = await win.locator('.tab-item').count();
  await win.click('#btn-template');
  const titleInput = win.locator('.template-field input').first();
  await titleInput.fill('Draft inside modal');
  await win.keyboard.press('Control+n');

  await expect(titleInput).toHaveValue('Draft inside modal');
  await expect(win.locator('.tab-item')).toHaveCount(before);

  await app.close();
});
