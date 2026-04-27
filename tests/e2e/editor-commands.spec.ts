import { test, expect } from '@playwright/test';
import { launchElectron } from '../helpers';

test('replace command focuses the replace field', async () => {
  const app = await launchElectron();
  const win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');

  await win.keyboard.press('Control+n');
  await win.evaluate(() => (window as any).orpadCommands.runCommand('edit.replace'));

  await expect(win.locator('.cm-search input[name="replace"]')).toBeFocused();

  await app.close();
});
