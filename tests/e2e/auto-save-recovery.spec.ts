import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as nodePath from 'path';
import { launchElectron } from '../helpers';

test('recovery file is written for unsaved changes', async () => {
  const app = await launchElectron();
  const win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');

  // Trigger the recovery-save IPC path (simulates the 30 s auto-save timer)
  await win.evaluate(async () => {
    await window.orpad.autoSaveRecovery(null, '# Recovery smoke test\n\nUnsaved content.');
  });

  // Get userData path from main process (no require needed in evaluate body)
  const userData = await app.evaluate(({ app: electronApp }) => electronApp.getPath('userData'));

  // Verify the recovery file was written using Node fs in the test file (not inside evaluate)
  const recoveryDir = nodePath.join(userData, 'recovery');
  const files: string[] = fs.existsSync(recoveryDir) ? fs.readdirSync(recoveryDir) : [];
  const hasRecovery = files.some(f => f.endsWith('.json'));

  expect(hasRecovery).toBe(true);

  await app.close();
});
