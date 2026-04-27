// This test validates P0-8's two specific optimizations:
//   1. AST cache hits on revisited content (undo/redo scenario).
//   2. Mermaid 400ms debounce does not block the main thread.
// It does NOT assert 60fps per-keystroke typing on 10k-line files —
// that requires incremental parsing which the P0-8 brief deferred.
// See strategy doc §11.7 for the full perf roadmap.

import { test, expect } from '@playwright/test';
import * as path from 'path';
import { launchElectron } from '../helpers';

test('markdown-perf: AST cache hits during undo and Mermaid debounce do not block main thread', async () => {
  const fixturePath = path.resolve('tests/fixtures/p0-8/big.md');
  const app = await launchElectron();
  const win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');

  await win.evaluate((p: string) => window.orpad.dropFile(p), fixturePath);

  // Wait for initial render of the large file to settle
  await win.waitForTimeout(1500);

  // Step 1: Type 20 characters — cache-miss scenario (novel content hash each
  // keystroke → full reparse). We measure wall time for the total scenario
  // assertion but do NOT assert longestTask here.
  const scenarioStart = Date.now();

  await win.evaluate(() => {
    const editor = document.querySelector('.cm-content') as HTMLElement;
    if (editor) {
      editor.focus();
      for (let i = 0; i < 20; i++) {
        document.execCommand('insertText', false, 'a');
      }
    }
  });

  // Allow typing to settle before undo sequence
  await win.waitForTimeout(300);

  // Step 2: Install PerformanceObserver then press Ctrl+Z 20 times via
  // Playwright's native keyboard API so CodeMirror's keymap fires correctly.
  // Undo revisits prior content hashes → AST cache hits → faster rerenders.
  await win.evaluate(() => {
    (window as any).__perfMax = 0;
    const obs = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (entry.duration > (window as any).__perfMax) {
          (window as any).__perfMax = entry.duration;
        }
      }
    });
    obs.observe({ type: 'longtask', buffered: false });
    (window as any).__perfObs = obs;
  });

  // Focus the editor before firing keyboard shortcuts
  await win.locator('.cm-content').focus();

  for (let i = 0; i < 20; i++) {
    await win.keyboard.press('Control+z');
  }

  // Wait for Mermaid debounce (400ms) + render to settle
  await win.waitForTimeout(600);

  const longestTask = await win.evaluate(() => {
    (window as any).__perfObs.disconnect();
    return (window as any).__perfMax as number;
  });

  const scenarioDuration = Date.now() - scenarioStart;

  // Assertion (a): AST cache hits during undo should keep longest task < 500ms.
  // 500ms is chosen to be above observed headroom while still catching regressions.
  expect(longestTask).toBeLessThan(500);

  // Assertion (b): Full scenario (type + undo) must not catastrophically regress.
  expect(scenarioDuration).toBeLessThan(10000);

  await app.close();
});
