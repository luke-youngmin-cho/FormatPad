import { test, expect, type Page } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { startStaticServer } from '../../helpers';

const docsDir = path.resolve('docs');

async function installHangingAiMock(page: Page): Promise<void> {
  await page.addInitScript(() => {
    localStorage.setItem('fp-ai-provider', 'openai-compatible');
    localStorage.setItem('fp-ai-endpoint-openai-compatible', 'https://formatpad.test');

    const originalFetch = window.fetch.bind(window);
    window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (!url.startsWith('https://formatpad.test/chat/completions')) {
        return originalFetch(input, init);
      }

      const stream = new ReadableStream({
        start(controller) {
          init?.signal?.addEventListener('abort', () => {
            controller.error(new DOMException('Aborted', 'AbortError'));
          }, { once: true });
        },
      });
      return Promise.resolve(new Response(stream, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      }));
    };
  });
}

async function installDelayedAiMock(page: Page): Promise<void> {
  await page.addInitScript(() => {
    localStorage.setItem('fp-ai-provider', 'openai-compatible');
    localStorage.setItem('fp-ai-endpoint-openai-compatible', 'https://formatpad.test');

    const originalFetch = window.fetch.bind(window);
    window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (!url.startsWith('https://formatpad.test/chat/completions')) {
        return originalFetch(input, init);
      }

      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        start(controller) {
          const timer = window.setTimeout(() => {
            controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"Explained."}}]}\n\n'));
            controller.enqueue(encoder.encode('data: [DONE]\n\n'));
            controller.close();
          }, 1000);
          init?.signal?.addEventListener('abort', () => {
            window.clearTimeout(timer);
            controller.error(new DOMException('Aborted', 'AbortError'));
          }, { once: true });
        },
      });
      return Promise.resolve(new Response(stream, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      }));
    };
  });
}

async function installMcpMock(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const server = {
      id: 'mock',
      label: 'Mock MCP',
      enabled: true,
      command: 'mock',
      args: [],
      env: {},
      description: 'Mock MCP server for UI tests.',
      readOnlyDefault: true,
    };
    const tool = {
      name: 'read_file',
      description: 'Read a workspace file.',
      inputSchema: {
        type: 'object',
        required: ['path'],
        properties: {
          path: { type: 'string', description: 'Workspace-relative file path.' },
          limit: { type: 'integer', description: 'Maximum bytes to read.' },
          includeHidden: { type: 'boolean', description: 'Include hidden files.' },
        },
      },
    };
    (window as any).mcp = {
      listServers: async () => ({
        servers: [server],
        statuses: { mock: { state: 'running', toolCount: 1, resourceCount: 0 } },
      }),
      setEnabled: async () => ({
        server,
        statuses: { mock: { state: 'running', toolCount: 1, resourceCount: 0 } },
      }),
      listTools: async () => [tool],
      listResources: async () => [],
      readResource: async () => ({ contents: [] }),
      prepareToolCall: async () => ({ readOnly: true, canPersistGlobal: true }),
      callTool: async () => ({ content: [{ type: 'text', text: 'ok' }] }),
      upsertServer: async () => server,
      removeServer: async () => [server],
      refreshServer: async () => ({ state: 'running', toolCount: 1, resourceCount: 0 }),
      revokeGlobalPermission: async () => true,
      exportConfig: async () => ({ version: 1, servers: [server] }),
      importConfig: async () => [server],
    };
  });
}

async function installStoppedMcpMock(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const server = {
      id: 'stale',
      label: 'Stale MCP',
      enabled: true,
      command: 'mock',
      args: [],
      env: {},
      description: 'Stopped server with stale enabled config.',
      readOnlyDefault: true,
    };
    (window as any).mcp = {
      listServers: async () => ({
        servers: [server],
        statuses: { stale: { state: 'stopped', toolCount: 0, resourceCount: 0 } },
      }),
      setEnabled: async (_id: string, enabled: boolean) => {
        server.enabled = enabled;
        return {
          server,
          statuses: { stale: { state: enabled ? 'running' : 'stopped', toolCount: 0, resourceCount: 0 } },
        };
      },
      listTools: async () => [],
      listResources: async () => [],
      readResource: async () => ({ contents: [] }),
      prepareToolCall: async () => ({ readOnly: true, canPersistGlobal: true }),
      callTool: async () => ({ content: [{ type: 'text', text: 'ok' }] }),
      upsertServer: async () => server,
      removeServer: async () => [server],
      refreshServer: async () => ({ state: 'stopped', toolCount: 0, resourceCount: 0 }),
      revokeGlobalPermission: async () => true,
      exportConfig: async () => ({ version: 1, servers: [server] }),
      importConfig: async () => [server],
    };
  });
}

test('web build loads, new-file works, no console errors', async ({ page }) => {
  if (!fs.existsSync(path.join(docsDir, 'index.html'))) {
    test.skip(true, 'docs/ not built — run npm run build:web:min first');
    return;
  }

  const consoleErrors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });

  const { url, close } = await startStaticServer(docsDir);

  await page.goto(url);
  await page.waitForLoadState('domcontentloaded');

  await expect(page.locator('meta[name="viewport"]')).toHaveAttribute('content', /width=device-width/);

  // Toolbar must be present
  await expect(page.locator('#toolbar')).toBeVisible({ timeout: 10000 });
  await expect(page.locator('#btn-ai')).toBeVisible();
  await expect(page.locator('#btn-mcp')).toHaveCount(0);
  await expect(page.locator('#btn-git')).toHaveCount(0);

  await page.locator('#btn-ai').click();
  await expect(page.locator('.ai-sidebar')).toBeVisible();
  await expect(page.locator('.ai-context-chip')).toContainText('No active document');

  await page.locator('#btn-ai').click();
  await expect(page.locator('.ai-sidebar')).toBeHidden();

  await page.locator('#btn-ai').click();
  await expect(page.locator('.ai-sidebar')).toBeVisible();
  await page.evaluate(() => (window as any).formatpadCommands.runCommand('file.new'));
  await expect(page.locator('.ai-context-chip')).toContainText('Context: Untitled');

  await page.locator('.ai-mode-tabs button[data-mode="mcp"]').click();
  await expect(page.locator('.ai-mcp-panel')).toBeVisible();
  await expect(page.locator('.ai-mcp-panel')).toContainText('MCP is desktop-only');

  await page.evaluate(() => (window as any).formatpadCommands.runCommand('git.openPanel'));
  await expect(page.locator('#fmt-modal')).toContainText('Git Status and Commands');
  await page.locator('#fmt-modal-close').click();

  // Create a new file
  await expect(page.locator('.tab-item')).toBeVisible({ timeout: 5000 });

  // No unexpected console errors (ignore favicon 404s)
  const realErrors = consoleErrors.filter(
    (e) => !e.toLowerCase().includes('favicon'),
  );
  expect(realErrors).toHaveLength(0);

  await close();
});

test('MCP tool lists are collapsible and explain argument schemas', async ({ page }) => {
  if (!fs.existsSync(path.join(docsDir, 'index.html'))) {
    test.skip(true, 'docs/ not built - run npm run build:web:min first');
    return;
  }

  const { url, close } = await startStaticServer(docsDir);
  await installMcpMock(page);

  try {
    await page.goto(url);
    await page.waitForLoadState('domcontentloaded');
    await page.locator('#btn-ai').click();
    await page.locator('.ai-mode-tabs button[data-mode="mcp"]').click();

    const card = page.locator('.ai-mcp-card').filter({ hasText: 'Mock MCP' });
    await expect(card).toBeVisible();
    await card.getByRole('button', { name: 'Tools' }).click();
    const hideTools = card.getByRole('button', { name: 'Hide tools' });
    await expect(hideTools).toBeVisible();
    await expect(hideTools).toHaveAttribute('aria-pressed', 'true');
    await expect(hideTools).toHaveAttribute('aria-expanded', 'true');
    await expect(hideTools).toHaveClass(/active/);
    await expect(card.getByRole('button', { name: /read_file/ })).toContainText('required path');

    await card.getByRole('button', { name: 'Hide tools' }).click();
    await expect(card.getByRole('button', { name: /read_file/ })).toHaveCount(0);
    await expect(card.getByRole('button', { name: 'Tools' })).toHaveAttribute('aria-pressed', 'false');

    await card.getByRole('button', { name: 'Resources' }).click();
    const hideResources = card.getByRole('button', { name: 'Hide resources' });
    await expect(hideResources).toHaveAttribute('aria-pressed', 'true');
    await expect(hideResources).toHaveAttribute('aria-expanded', 'true');
    await expect(hideResources).toHaveClass(/active/);
    await expect(card.locator('.ai-mcp-empty')).toContainText('No resources reported');
    await hideResources.click();

    await card.getByRole('button', { name: 'Tools' }).click();
    await card.getByRole('button', { name: /read_file/ }).click();
    await expect(page.locator('#fmt-modal')).toContainText('Required: path');
    await expect(page.locator('#fmt-modal')).toContainText('Workspace-relative file path.');
    await expect(page.locator('#fmt-modal')).toContainText('Input schema');
    await expect(page.locator('#fmt-modal textarea')).toHaveValue(/"path": "<path>"/);
  } finally {
    await close();
  }
});

test('MCP stopped servers do not appear enabled from stale config', async ({ page }) => {
  if (!fs.existsSync(path.join(docsDir, 'index.html'))) {
    test.skip(true, 'docs/ not built - run npm run build:web:min first');
    return;
  }

  const { url, close } = await startStaticServer(docsDir);
  await installStoppedMcpMock(page);

  try {
    await page.goto(url);
    await page.waitForLoadState('domcontentloaded');
    await page.locator('#btn-ai').click();
    await page.locator('.ai-mode-tabs button[data-mode="mcp"]').click();

    const card = page.locator('.ai-mcp-card').filter({ hasText: 'Stale MCP' });
    await expect(card).toBeVisible();
    await expect(card.getByRole('checkbox', { name: 'Enable Stale MCP' })).not.toBeChecked();
    await expect(card).toContainText('stopped');
    await card.getByRole('button', { name: 'Tools' }).click();
    await expect(page.locator('.ai-action-status')).toContainText('Enable Stale MCP before using MCP tools.');
  } finally {
    await close();
  }
});

test('AI edit diff modal close button cancels the running action', async ({ page }) => {
  if (!fs.existsSync(path.join(docsDir, 'index.html'))) {
    test.skip(true, 'docs/ not built - run npm run build:web:min first');
    return;
  }

  const { url, close } = await startStaticServer(docsDir);

  try {
    await page.goto(url);
    await page.waitForLoadState('domcontentloaded');
    await page.evaluate(async () => {
      await (window as any).formatpad.dropFile(new File(['# Plan\n\n## Scope\n\nShip beta.'], 'plan.md', { type: 'text/markdown' }));
    });

    await page.locator('#btn-ai').click();
    await page.locator('.ai-mode-tabs button[data-mode="actions"]').click();
    await page.getByRole('button', { name: /Generate \/ refresh TOC/ }).click();
    await expect(page.locator('#fmt-modal')).toContainText('Generate / refresh Markdown TOC');
    await expect(page.locator('.ai-action-running')).toContainText('Generate / refresh TOC');

    await page.locator('#fmt-modal-close').click();
    await expect(page.locator('.ai-action-running')).toHaveCount(0);
    await expect(page.locator('.ai-action-status')).toContainText('canceled');
    await expect(page.locator('#fmt-modal')).toBeHidden();
  } finally {
    await close();
  }
});

test('Assist tools distinguish local actions from AI-powered actions', async ({ page }) => {
  if (!fs.existsSync(path.join(docsDir, 'index.html'))) {
    test.skip(true, 'docs/ not built - run npm run build:web:min first');
    return;
  }

  const { url, close } = await startStaticServer(docsDir);

  try {
    await page.goto(url);
    await page.waitForLoadState('domcontentloaded');
    await page.evaluate(async () => {
      await (window as any).formatpad.dropFile(new File(['{"name":"FormatPad","beta":2}'], 'sample.json', { type: 'application/json' }));
    });

    await page.locator('#btn-ai').click();
    await expect(page.locator('.ai-mode-tabs button[data-mode="actions"]')).toHaveText('Assist');
    await page.locator('.ai-mode-tabs button[data-mode="actions"]').click();
    await expect(page.locator('.ai-actions-panel')).toContainText('AI-powered edits');
    await expect(page.locator('.ai-actions-panel')).toContainText('Local format tools');

    const localAction = page.getByRole('button', { name: /Generate JSON Schema/ });
    await expect(localAction).toContainText('Runs locally');
    await expect(localAction).not.toBeDisabled();

    const aiAction = page.getByRole('button', { name: /Validate \+ explain/ });
    await expect(aiAction).toContainText('Uses AI provider');
    await expect(aiAction).toContainText('Requires provider key');
    await expect(aiAction).toBeDisabled();
  } finally {
    await close();
  }
});

test('JSON sample generation cancel does not create an output tab', async ({ page }) => {
  if (!fs.existsSync(path.join(docsDir, 'index.html'))) {
    test.skip(true, 'docs/ not built - run npm run build:web:min first');
    return;
  }

  const { url, close } = await startStaticServer(docsDir);

  try {
    await page.goto(url);
    await page.waitForLoadState('domcontentloaded');
    await page.evaluate(async () => {
      await (window as any).formatpad.dropFile(new File(['{"type":"object","properties":{"name":{"type":"string"}}}'], 'schema.json', { type: 'application/json' }));
    });

    await page.locator('#btn-ai').click();
    await page.locator('.ai-mode-tabs button[data-mode="actions"]').click();
    await page.getByRole('button', { name: /Generate samples from schema/ }).click();
    await expect(page.locator('#fmt-modal')).toContainText('Generate samples');
    await page.locator('#fmt-modal-footer button', { hasText: 'Cancel' }).click();

    await expect(page.locator('.ai-action-running')).toHaveCount(0);
    await expect(page.locator('.ai-action-status')).toContainText('Canceled');
    await expect(page.locator('.tab-item')).not.toContainText('sample-data.json');
  } finally {
    await close();
  }
});

test('JSON sample generation refuses non-schema documents', async ({ page }) => {
  if (!fs.existsSync(path.join(docsDir, 'index.html'))) {
    test.skip(true, 'docs/ not built - run npm run build:web:min first');
    return;
  }

  const { url, close } = await startStaticServer(docsDir);

  try {
    await page.goto(url);
    await page.waitForLoadState('domcontentloaded');
    await page.evaluate(async () => {
      await (window as any).formatpad.dropFile(new File(['{"name":"FormatPad","beta":2}'], 'sample.json', { type: 'application/json' }));
    });

    await page.locator('#btn-ai').click();
    await page.locator('.ai-mode-tabs button[data-mode="actions"]').click();
    await page.getByRole('button', { name: /Generate samples from schema/ }).click();
    await page.locator('#fmt-modal-footer button.primary').click();

    await expect(page.locator('.ai-action-running')).toHaveCount(0);
    await expect(page.locator('.ai-action-status')).toContainText('Open a JSON Schema first');
    await expect(page.locator('.tab-item')).not.toContainText('sample-data.json');
  } finally {
    await close();
  }
});

test('AI edit apply returns to the source tab after tab switching', async ({ page }) => {
  if (!fs.existsSync(path.join(docsDir, 'index.html'))) {
    test.skip(true, 'docs/ not built - run npm run build:web:min first');
    return;
  }

  const { url, close } = await startStaticServer(docsDir);
  await installDelayedAiMock(page);

  try {
    await page.goto(url);
    await page.waitForLoadState('domcontentloaded');
    await page.evaluate(async () => {
      await (window as any).formatpad.dropFile(new File(['{"name":"FormatPad",}'], 'broken.json', { type: 'application/json' }));
      await (window as any).formatpad.dropFile(new File(['{"other":true}'], 'other.json', { type: 'application/json' }));
    });

    await page.locator('.tab-item').filter({ hasText: 'broken.json' }).click();
    await page.locator('#btn-ai').click();
    await page.locator('.ai-mode-tabs button[data-mode="actions"]').click();
    await page.getByRole('button', { name: /Repair \+ explain/ }).click();
    await expect(page.locator('.ai-action-running')).toContainText('Repair + explain');

    await page.locator('.tab-item').filter({ hasText: 'other.json' }).click();
    await expect(page.locator('.tab-item.active')).toContainText('other.json');
    await expect(page.locator('#fmt-modal')).toContainText('Repair JSON');
    await expect(page.locator('.tab-item.active')).toContainText('broken.json');

    await page.locator('#fmt-modal-footer button.primary').click();
    await page.locator('.tab-item').filter({ hasText: 'broken.json' }).click();
    await expect(page.locator('.cm-content')).toContainText('"name":"FormatPad"');

    await page.locator('.tab-item').filter({ hasText: 'other.json' }).click();
    await expect(page.locator('.cm-content')).toContainText('"other":true');
  } finally {
    await close();
  }
});

test('web PWA assets are self-contained for offline install', async () => {
  if (!fs.existsSync(path.join(docsDir, 'index.html'))) {
    test.skip(true, 'docs/ not built - run npm run build:web:min first');
    return;
  }

  const manifest = JSON.parse(fs.readFileSync(path.join(docsDir, 'manifest.webmanifest'), 'utf-8'));
  expect(manifest.start_url).toBe('./');
  expect(manifest.scope).toBe('./');
  expect(manifest.file_handlers?.[0]?.action).toBe('./');

  const sw = fs.readFileSync(path.join(docsDir, 'sw.js'), 'utf-8');
  expect(sw).not.toContain('storage.googleapis.com');
  expect(sw).toContain('styles/fonts/KaTeX_Main-Regular.woff2');
  expect(fs.existsSync(path.join(docsDir, 'styles', 'fonts', 'KaTeX_Main-Regular.woff2'))).toBe(true);
});

test('web file launch consumer and non-FSA save fallback work', async ({ page }) => {
  if (!fs.existsSync(path.join(docsDir, 'index.html'))) {
    test.skip(true, 'docs/ not built - run npm run build:web:min first');
    return;
  }

  const { url, close } = await startStaticServer(docsDir);
  await page.goto(url);
  await page.waitForLoadState('domcontentloaded');

  const opened = await page.evaluate(async () => {
    return await (window as any).formatpad.openFileHandles([{
      kind: 'file',
      name: 'launch.md',
      getFile: async () => new File(['# Launched\n\nfrom file handler'], 'launch.md', { type: 'text/markdown' }),
    }]);
  });
  expect(opened).toBe(true);
  await expect(page.locator('.tab-item')).toContainText('launch.md');
  await expect(page.locator('.cm-content')).toContainText('from file handler');

  const downloadPromise = page.waitForEvent('download');
  const saved = await page.evaluate(async () => {
    return await (window as any).formatpad.saveFile('web:nohandle/fallback.md', '# Download fallback');
  });
  expect(saved).toBe(true);
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('fallback.md');

  await close();
});

test('AI edit action cancel stops a hanging provider response', async ({ page }) => {
  if (!fs.existsSync(path.join(docsDir, 'index.html'))) {
    test.skip(true, 'docs/ not built - run npm run build:web:min first');
    return;
  }

  const { url, close } = await startStaticServer(docsDir);
  await installHangingAiMock(page);

  try {
    await page.goto(url);
    await page.waitForLoadState('domcontentloaded');
    await page.evaluate(async () => {
      await (window as any).formatpad.dropFile(new File(['{"name":"FormatPad"}'], 'sample.json', { type: 'application/json' }));
    });

    await page.locator('#btn-ai').click();
    await page.locator('.ai-mode-tabs button[data-mode="actions"]').click();
    await page.getByRole('button', { name: /Validate \+ explain/ }).click();
    await expect(page.locator('#fmt-modal')).toContainText('Validate current JSON');
    await expect(page.locator('#fmt-modal')).toContainText('Schema for current file: sample.json');
    await expect(page.locator('#fmt-modal')).toContainText('FormatPad validates the currently open JSON document against this schema.');
    await page.locator('#fmt-modal-footer button.primary').click();

    await expect(page.locator('.ai-action-running')).toContainText('Validate + explain');
    await page.locator('.ai-action-running button').click();
    await expect(page.locator('.ai-action-running')).toHaveCount(0);
    await expect(page.locator('.ai-action-status')).toContainText('canceled');
  } finally {
    await close();
  }
});

test('AI chat can run without an active document and can be canceled', async ({ page }) => {
  if (!fs.existsSync(path.join(docsDir, 'index.html'))) {
    test.skip(true, 'docs/ not built - run npm run build:web:min first');
    return;
  }

  const { url, close } = await startStaticServer(docsDir);
  await installHangingAiMock(page);

  try {
    await page.goto(url);
    await page.waitForLoadState('domcontentloaded');
    await page.locator('#btn-ai').click();
    await page.locator('.ai-composer').fill('Can you answer without a document?');
    await page.locator('.ai-send').click();
    await expect(page.locator('.ai-send')).toHaveText('Stop');
    await expect(page.locator('.ai-message.assistant .ai-loading-line')).toContainText('Waiting for AI response');
    await page.locator('.ai-send').click();
    await expect(page.locator('.ai-send')).toHaveText('Send');
    await expect(page.locator('.ai-log')).toContainText('Canceled.');
    await expect(page.locator('.ai-message.user').first()).toHaveCSS('justify-content', 'flex-end');
    await expect(page.locator('.ai-message.assistant').first()).toHaveCSS('justify-content', 'flex-start');
    const messageGaps = await page.evaluate(() => {
      const log = document.querySelector('.ai-log')?.getBoundingClientRect();
      const user = document.querySelector('.ai-message.user .ai-message-bubble')?.getBoundingClientRect();
      const assistant = document.querySelector('.ai-message.assistant .ai-message-bubble')?.getBoundingClientRect();
      return {
        userLeft: user && log ? user.left - log.left : 0,
        userRight: user && log ? log.right - user.right : 0,
        assistantLeft: assistant && log ? assistant.left - log.left : 0,
        assistantRight: assistant && log ? log.right - assistant.right : 0,
      };
    });
    expect(messageGaps.userLeft).toBeGreaterThan(30);
    expect(messageGaps.userRight).toBeLessThan(24);
    expect(messageGaps.assistantLeft).toBeLessThan(24);
    expect(messageGaps.assistantRight).toBeGreaterThan(30);
    const historyItem = page.locator('.ai-history-item').first();
    await expect(historyItem).toContainText('Can you answer without a document?');
    await historyItem.hover();
    await expect(historyItem.locator('.ai-history-delete')).toHaveCSS('opacity', '1');
    page.once('dialog', dialog => dialog.accept());
    await historyItem.locator('.ai-history-delete').click();
    await expect(page.locator('.ai-history-item')).toHaveCount(0);
    await expect(page.locator('.ai-chat-panel .ai-empty')).toContainText('AI sidebar is ready');
  } finally {
    await close();
  }
});
