import { test, expect } from '@playwright/test';
import * as path from 'path';
import { launchElectron } from '../helpers';

test('drag a tab between two others; order updates', async () => {
  const app = await launchElectron();
  const win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');

  // Open three fixture files so tabs have distinct names
  const fixtures = [
    path.resolve('tests/fixtures/sample.json'),
    path.resolve('tests/fixtures/sample.csv'),
    path.resolve('tests/fixtures/sample.yaml'),
  ];
  for (const fp of fixtures) {
    await win.evaluate((p: string) => window.formatpad.dropFile(p), fp);
    await win.waitForTimeout(200);
  }

  await expect(win.locator('.tab-item')).toHaveCount(3, { timeout: 8000 });

  const tabs = win.locator('.tab-item');
  const firstNameBefore = await tabs.nth(0).locator('.tab-name').textContent();

  // Playwright's locator.dragTo() uses mouse events, which do not reliably
  // trigger HTML5 DnD handlers (dragstart/dragover/drop). Simulate the full
  // drag sequence in-page with a shared DataTransfer so the app's drop handler
  // can read the dragged tab ID from e.dataTransfer.getData().
  const reordered = await win.evaluate(() => {
    const tabEls = Array.from(document.querySelectorAll('.tab-item'));
    if (tabEls.length < 3) return false;
    const source = tabEls[0];
    const target = tabEls[2];
    const dt = new DataTransfer();
    source.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }));
    target.dispatchEvent(new DragEvent('dragover',  { bubbles: true, cancelable: true, dataTransfer: dt }));
    target.dispatchEvent(new DragEvent('drop',      { bubbles: true, cancelable: true, dataTransfer: dt }));
    source.dispatchEvent(new DragEvent('dragend',   { bubbles: true, cancelable: true, dataTransfer: dt }));
    return true;
  });

  if (!reordered) {
    test.fixme(true, 'Tab drag reorder: could not find 3 tabs to drag between');
    return;
  }

  // After reorder the first slot should have a different tab name
  const firstNameAfter = await tabs.nth(0).locator('.tab-name').textContent();
  expect(firstNameAfter).not.toBe(firstNameBefore);

  await app.close();
});
