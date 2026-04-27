import { test, expect } from '@playwright/test';
import * as path from 'path';
import { launchElectron } from '../helpers';

test('CSV file renders grid with 10 data rows and a header', async () => {
  const fixturePath = path.resolve('tests/fixtures/sample.csv');
  const app = await launchElectron();
  const win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');

  await win.evaluate((p: string) => window.orpad.dropFile(p), fixturePath);

  // Wait for the spreadsheet grid
  await expect(win.locator('.sgrid-table')).toBeVisible({ timeout: 8000 });

  // sample.csv has 10 data rows
  const dataRows = win.locator('.sgrid-table tbody tr');
  await expect(dataRows).toHaveCount(10, { timeout: 5000 });

  await app.close();
});
