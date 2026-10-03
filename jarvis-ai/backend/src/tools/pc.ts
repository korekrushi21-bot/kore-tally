import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { config } from '../config.js';

/**
 * READ-ONLY access to this PC. There is deliberately no write, delete, rename, move, execute or network function here.
 * Safety rules:
 *  - only inside the folders listed in PC_READ_FOLDERS (default: Desktop, Documents, Downloads of the current user)
 *  - symlinks / junctions are resolved first, so they cannot be used to escape the allowed folders
 *  - secrets are never readable (.env, keys, certificates, password stores, tokens, ssh/aws config...)
 *  - only known text file types, small size, and at most a few thousand characters are returned
 *  - the tools are offered only to requests coming from this PC itself and only when the AI runs locally (Ollama),
 *    so file contents do not leave the machine
 */

const TEXT_EXT = new Set(['.txt', '.md', '.csv', '.tsv', '.json', '.log', '.xml', '.html', '.htm', '.yml', '.yaml', '.ini', '.cfg', '.js', '.ts', '.tsx', '.jsx', '.py', '.java', '.c', '.cpp', '.cs', '.sql', '.css', '.rtf']);
const DENY_NAME = /(^\.env|\.env$|\.pem$|\.key$|\.pfx$|\.p12$|\.kdbx?$|\.ppk$|\.keystore$|\.jks$|id_rsa|id_ed25519|\.npmrc$|\.netrc$|credential|password|passwd|secret|token|wallet|seed|private)/i;
const IGNORE_DIR = /^(node_modules|\.git|\.svn|appdata|\$recycle\.bin|system volume information|windows|program files.*)$/i;
const MAX_FILE_BYTES = 1_000_000;

export function allowedRoots(): string[] {
  const home = os.homedir();
  const configured = config.pcReadFolders.length ? config.pcReadFolders : ['Desktop', 'Documents', 'Downloads'].map((d) => path.join(home, d));
  const out: string[] = [];
  for (const f of configured) { try { out.push(fs.realpathSync(path.resolve(f))); } catch { /* folder missing */ } }
  return out;
}

const norm = (p: string) => (process.platform === 'win32' ? p.toLowerCase() : p);
function inside(root: string, p: string) {
  const r = norm(root).replace(/[\\/]+$/, ''); const q = norm(p);
  return q === r || q.startsWith(r + path.sep);
}

export class PcError extends Error {}

/** Resolve a user/model supplied path to a real path that is inside an allowed folder, or throw. */
export function resolveSafe(input: string | undefined): string {
  const roots = allowedRoots();
  if (!roots.length) throw new PcError('No readable folders are configured.');
  let target = (input ?? '').trim().replace(/^["']|["']$/g, '');
  if (!target) return roots[0];
  // friendly names
  const alias: Record<string, string> = { desktop: 'Desktop', documents: 'Documents', downloads: 'Downloads' };
  const a = alias[target.toLowerCase()];
  if (a) target = path.join(os.homedir(), a);
  if (!path.isAbsolute(target)) target = path.join(roots[0], target);
  let real: string;
  try { real = fs.realpathSync(path.resolve(target)); } catch { throw new PcError('Path not found.'); }
  const root = roots.find((r) => inside(r, real));
  if (!root) throw new PcError('That location is outside the folders JARVIS may read.');
  // protected names are checked only BELOW the allowed folder (the folder itself was chosen by the user)
  const below = path.relative(root, real).split(path.sep).filter(Boolean);
  if (below.some((s) => IGNORE_DIR.test(s)) || DENY_NAME.test(path.basename(real))) throw new PcError('That item is protected and cannot be read.');
  return real;
}

export function listFolder(p?: string) {
  const dir = resolveSafe(p);
  const st = fs.statSync(dir);
  if (!st.isDirectory()) throw new PcError('That is a file, not a folder.');
  const items = fs.readdirSync(dir, { withFileTypes: true })
    .filter((e) => !IGNORE_DIR.test(e.name) && !DENY_NAME.test(e.name))
    .slice(0, 100)
    .map((e) => {
      let size: number | undefined; let modified: string | undefined;
      try { const s = fs.statSync(path.join(dir, e.name)); size = e.isDirectory() ? undefined : s.size; modified = s.mtime.toISOString().slice(0, 16); } catch { /* ignore */ }
      return { name: e.name, type: e.isDirectory() ? 'folder' : 'file', sizeKB: size != null ? Math.round(size / 1024) : undefined, modified };
    });
  return { folder: dir, count: items.length, truncated: items.length >= 100, items };
}

export function findFiles(query: string, folder?: string) {
  const root = resolveSafe(folder);
  const q = query.trim().toLowerCase();
  if (q.length < 2) throw new PcError('Search text is too short.');
  const hits: { path: string; sizeKB: number; modified: string }[] = [];
  let visited = 0;
  const walk = (d: string, depth: number) => {
    if (hits.length >= 30 || depth > 4 || visited > 5000) return;
    let entries: fs.Dirent[]; try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      visited++;
      if (e.isSymbolicLink() || IGNORE_DIR.test(e.name)) continue;
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full, depth + 1);
      else if (e.name.toLowerCase().includes(q) && !DENY_NAME.test(e.name)) {
        try { const s = fs.statSync(full); hits.push({ path: full, sizeKB: Math.round(s.size / 1024), modified: s.mtime.toISOString().slice(0, 16) }); } catch { /* ignore */ }
      }
      if (hits.length >= 30) return;
    }
  };
  walk(root, 0);
  return { searchedIn: root, matches: hits };
}

export function readTextFile(p: string, maxChars = 3000) {
  const file = resolveSafe(p);
  const st = fs.statSync(file);
  if (!st.isFile()) throw new PcError('That is a folder, not a file.');
  const ext = path.extname(file).toLowerCase();
  if (!TEXT_EXT.has(ext)) throw new PcError(`Only plain text files can be read (${[...TEXT_EXT].slice(0, 8).join(' ')} ...).`);
  if (st.size > MAX_FILE_BYTES) throw new PcError('File is too large to read.');
  const limit = Math.min(Math.max(Number(maxChars) || 3000, 200), 6000);
  const buf = fs.readFileSync(file);
  if (buf.subarray(0, 2000).includes(0)) throw new PcError('That file is not plain text.');
  const text = buf.toString('utf8');
  return { file, sizeKB: Math.round(st.size / 1024), modified: st.mtime.toISOString().slice(0, 16), truncated: text.length > limit, content: text.slice(0, limit) };
}

export function systemInfo() {
  const cpus = os.cpus();
  const gb = (n: number) => Math.round((n / 1024 ** 3) * 10) / 10;
  const disks: { drive: string; totalGB: number; freeGB: number }[] = [];
  const letters = process.platform === 'win32' ? 'CDEF'.split('').map((l) => `${l}:\\`) : ['/'];
  for (const d of letters) {
    try { const s = fs.statfsSync(d); disks.push({ drive: d, totalGB: gb(s.blocks * s.bsize), freeGB: gb(s.bavail * s.bsize) }); } catch { /* drive absent */ }
  }
  return {
    computer: os.hostname(), os: `${os.type()} ${os.release()}`, cpu: cpus[0]?.model?.trim(), cores: cpus.length,
    memoryGB: { total: gb(os.totalmem()), free: gb(os.freemem()) }, disks, uptimeHours: Math.round((os.uptime() / 3600) * 10) / 10,
    readableFolders: allowedRoots(),
  };
}
