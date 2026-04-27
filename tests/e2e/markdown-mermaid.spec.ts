import { test, expect } from '@playwright/test';
import * as path from 'path';
import { launchElectron } from '../helpers';

test('mermaid fenced block renders an SVG in preview', async () => {
  const fixturePath = path.resolve('tests/fixtures/sample-mermaid.md');
  const app = await launchElectron();
  const win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');

  await win.evaluate((p: string) => window.orpad.dropFile(p), fixturePath);

  // Wait past the 400ms per-block debounce before polling for the SVG.
  await win.waitForTimeout(600);

  // renderMermaidBlocks() renders SVG into .mermaid-block inside #content.
  // Use the class selector so we only match the actual mermaid output.
  await expect(win.locator('#content .mermaid-block svg').first()).toBeVisible({ timeout: 15000 });

  await app.close();
});
