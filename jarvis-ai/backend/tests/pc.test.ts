import { describe, expect, it, beforeAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// A throw-away "documents" folder with a secret next to normal files, and a sibling folder that must stay unreachable.
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-pc-'));
const allowed = path.join(base, 'allowed');
const outside = path.join(base, 'outside');
fs.mkdirSync(path.join(allowed, 'sub'), { recursive: true });
fs.mkdirSync(path.join(allowed, 'node_modules'), { recursive: true });
fs.mkdirSync(outside);
fs.writeFileSync(path.join(allowed, 'notes.txt'), 'Buy seeds and fertilizer.\nCall the supplier.');
fs.writeFileSync(path.join(allowed, 'sub', 'prices.csv'), 'item,price\nurea,300');
fs.writeFileSync(path.join(allowed, '.env'), 'API_KEY=supersecret');
fs.writeFileSync(path.join(allowed, 'my-passwords.txt'), 'bank: hunter2');
fs.writeFileSync(path.join(allowed, 'photo.png'), Buffer.from([0x89, 0x50, 0, 0, 1]));
fs.writeFileSync(path.join(allowed, 'node_modules', 'x.txt'), 'dep');
fs.writeFileSync(path.join(outside, 'private.txt'), 'outside secret');

process.env.PC_READ_FOLDERS = allowed;
process.env.JWT_SECRET = 'z'.repeat(40);
process.env.APP_ACCESS_CODE = 'pc-test-code';
process.env.DATABASE_PATH = ':memory:';

const pc = await import('../src/tools/pc.js');
const { selectTools, runServerTool } = await import('../src/tools/index.js');

describe('read-only PC access', () => {
  it('lists, finds and reads allowed files', () => {
    const l = pc.listFolder();
    const names = l.items.map((i) => i.name);
    expect(names).toContain('notes.txt');
    expect(names).toContain('sub');
    expect(pc.findFiles('prices').matches[0].path.endsWith('prices.csv')).toBe(true);
    expect(pc.readTextFile('notes.txt').content).toContain('Buy seeds');
    expect(pc.readTextFile(path.join(allowed, 'sub', 'prices.csv')).content).toContain('urea');
  });

  it('hides and refuses secrets, protected folders and non-text files', () => {
    const names = pc.listFolder().items.map((i) => i.name);
    expect(names).not.toContain('.env');
    expect(names).not.toContain('my-passwords.txt');
    expect(names).not.toContain('node_modules');
    expect(() => pc.readTextFile('.env')).toThrow();
    expect(() => pc.readTextFile('my-passwords.txt')).toThrow();
    expect(() => pc.readTextFile('photo.png')).toThrow();
    expect(() => pc.readTextFile('node_modules/x.txt')).toThrow();
    expect(pc.findFiles('passwords').matches).toEqual([]);
  });

  it('cannot escape the allowed folder (.., absolute paths, sibling prefix)', () => {
    expect(() => pc.readTextFile('../outside/private.txt')).toThrow(/outside/);
    expect(() => pc.readTextFile(path.join(outside, 'private.txt'))).toThrow(/outside/);
    expect(() => pc.listFolder(outside)).toThrow(/outside/);
    expect(() => pc.listFolder(os.homedir())).toThrow();
    expect(() => pc.listFolder('C:\\Windows')).toThrow();
  });

  it('cannot escape through a symlink / junction', () => {
    const link = path.join(allowed, 'sneaky');
    try { fs.symlinkSync(outside, link, 'junction'); } catch { return; } // skip if the OS refuses to create it
    expect(() => pc.readTextFile('sneaky/private.txt')).toThrow(/outside/);
  });

  it('system info is read-only data', () => {
    const s = pc.systemInfo();
    expect(s.cores).toBeGreaterThan(0);
    expect(s.memoryGB.total).toBeGreaterThan(0);
    expect(s.readableFolders).toEqual([fs.realpathSync(allowed)]);
  });

  it('PC tools are only offered, and only run, when the request is allowed', async () => {
    expect(selectTools('what is in my documents folder', false).map((t) => t.name)).not.toContain('listFolder');
    expect(selectTools('what is in my documents folder', true).map((t) => t.name)).toContain('listFolder');
    const ctx: any = { userId: 1, timezone: 'Asia/Kolkata', sources: [], pcAllowed: false };
    expect((await runServerTool('readTextFile', { path: 'notes.txt' }, ctx) as any).error).toMatch(/off for this connection/);
    ctx.pcAllowed = true;
    expect((await runServerTool('readTextFile', { path: 'notes.txt' }, ctx) as any).content).toContain('Buy seeds');
    expect((await runServerTool('readTextFile', { path: '.env' }, ctx) as any).error).toBeTruthy();
  });

  it('the module exposes no write/delete/exec functions', () => {
    expect(Object.keys(pc).sort()).toEqual(['PcError', 'allowedRoots', 'findFiles', 'listFolder', 'readTextFile', 'resolveSafe', 'systemInfo']);
  });
});
