import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { launchElectron } from '../helpers';

test('renderer file APIs require an approved file or workspace capability', async () => {
  const secretFile = path.join(os.tmpdir(), `orpad-secret-${Date.now()}.md`);
  const writeTarget = path.join(os.tmpdir(), `orpad-write-${Date.now()}.md`);
  fs.writeFileSync(secretFile, '# Secret outside workspace\n');

  const app = await launchElectron();
  const win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');

  const readResult = await win.evaluate(async (filePath) => {
    return await (window as any).orpad.readFile(filePath);
  }, secretFile);
  expect(String(readResult?.error || '')).toContain('outside');

  const saveResult = await win.evaluate(async (filePath) => {
    return await (window as any).orpad.saveFile(filePath, '# Should not be written\n');
  }, writeTarget);
  expect(saveResult).toBe(false);
  expect(fs.existsSync(writeTarget)).toBe(false);

  fs.rmSync(secretFile, { force: true });
  await app.close();
});

test('opening a file does not grant arbitrary sibling file access', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orpad-cap-'));
  const openedFile = path.join(dir, 'opened.md');
  const siblingFile = path.join(dir, 'sibling.md');
  fs.writeFileSync(openedFile, '# Opened file\n');
  fs.writeFileSync(siblingFile, '# Sibling secret\n');

  const app = await launchElectron([openedFile]);
  const win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');

  const openedResult = await win.evaluate(async (filePath) => {
    return await (window as any).orpad.readFile(filePath);
  }, openedFile);
  expect(openedResult?.content).toContain('Opened file');

  const siblingResult = await win.evaluate(async (filePath) => {
    return await (window as any).orpad.readFile(filePath);
  }, siblingFile);
  expect(String(siblingResult?.error || '')).toContain('outside');

  await app.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('workspace tree access comes from main-owned approved workspace state', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orpad-workspace-'));
  fs.writeFileSync(path.join(dir, 'note.md'), '# Workspace note\n');

  const app = await launchElectron();
  const win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');
  const userData = await app.evaluate(({ app: electronApp }) => electronApp.getPath('userData'));
  fs.writeFileSync(path.join(userData, 'approved-workspace.json'), JSON.stringify({
    version: 1,
    workspaceRoot: dir,
  }));

  const approved = await win.evaluate(async () => {
    return await (window as any).orpad.getApprovedWorkspace();
  });
  expect(path.resolve(approved)).toBe(path.resolve(dir));

  const tree = await win.evaluate(async (workspacePath) => {
    return await (window as any).orpad.readDirectory(workspacePath);
  }, dir);
  expect(tree.some((item: { name: string }) => item.name === 'note.md')).toBe(true);

  await app.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('workspace capability rejects symlink escapes where supported', async ({}, testInfo) => {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orpad-workspace-'));
  const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orpad-outside-'));
  const linkPath = path.join(workspaceDir, 'outside-link');
  const secretPath = path.join(outsideDir, 'secret.md');
  fs.writeFileSync(secretPath, '# Symlink escape secret\n');
  try {
    fs.symlinkSync(outsideDir, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
  } catch {
    fs.rmSync(workspaceDir, { recursive: true, force: true });
    fs.rmSync(outsideDir, { recursive: true, force: true });
    testInfo.skip(true, 'filesystem symlink/junction creation is unavailable');
  }

  const app = await launchElectron();
  const win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');
  const userData = await app.evaluate(({ app: electronApp }) => electronApp.getPath('userData'));
  fs.writeFileSync(path.join(userData, 'approved-workspace.json'), JSON.stringify({
    version: 1,
    workspaceRoot: workspaceDir,
  }));
  await win.evaluate(async () => {
    await (window as any).orpad.getApprovedWorkspace();
  });

  const result = await win.evaluate(async (filePath) => {
    return await (window as any).orpad.readFile(filePath);
  }, path.join(linkPath, 'secret.md'));
  expect(String(result?.error || '')).toContain('outside');

  await app.close();
  fs.rmSync(workspaceDir, { recursive: true, force: true });
  fs.rmSync(outsideDir, { recursive: true, force: true });
});
