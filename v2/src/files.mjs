import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export const hash = value => createHash('sha256').update(value).digest('hex');
export const json = value => JSON.stringify(value, null, 2) + '\n';
export const fail = message => { throw new Error(message); };
export const exists = async p => { try { await fs.lstat(p); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } };

// Reject every symlink component, including a non-existent leaf's parent.
// This is accidental/path-input protection, not isolation from the OS account.
export async function inside(root, relative) {
  if (typeof relative !== 'string' || !relative || relative.includes('\\') || relative.includes('\0') || path.isAbsolute(relative) || relative.split('/').some(p => p === '..' || p === '.')) fail('Unsafe project path');
  const base = await fs.realpath(root);
  const target = path.resolve(base, relative);
  if (!target.startsWith(base + path.sep)) fail('Path escapes project');
  let current = base;
  for (const component of relative.split('/')) {
    current = path.join(current, component);
    try { if ((await fs.lstat(current)).isSymbolicLink()) fail('Symlinks are not allowed in project paths'); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
  return target;
}
export async function read(root, relative) { return fs.readFile(await inside(root, relative), 'utf8'); }
export async function readJSON(root, relative, fallback) {
  try { return JSON.parse(await read(root, relative)); }
  catch (e) { if (e.code === 'ENOENT' && fallback !== undefined) return structuredClone(fallback); throw e; }
}
export async function write(root, relative, value) {
  const target = await inside(root, relative);
  await fs.mkdir(path.dirname(target), { recursive: true });
  const temp = target + '.' + randomUUID() + '.tmp';
  const handle = await fs.open(temp, 'wx', 0o600);
  try { await handle.writeFile(typeof value === 'string' ? value : json(value)); await handle.sync(); }
  finally { await handle.close(); }
  await fs.rename(temp, target);
}
export async function locked(root, action) {
  const dir = await inside(root, '.tsugite');
  await fs.mkdir(dir, { recursive: true });
  const lock = await inside(root, '.tsugite/operation.lock');
  let handle;
  try { handle = await fs.open(lock, 'wx', 0o600); }
  catch (e) { if (e.code === 'EEXIST') fail('Project busy or interrupted: operation.lock exists; inspect before recovery'); throw e; }
  try { await handle.writeFile(json({ pid: process.pid, at: new Date().toISOString() })); await handle.sync(); return await action(); }
  finally { await handle.close(); await fs.unlink(lock); }
}
export async function fileHash(root, relative) { return hash(await fs.readFile(await inside(root, relative))); }
export async function treeHash(root) {
  const result = [];
  async function walk(relative = '') {
    for (const name of (await fs.readdir(path.join(root, relative))).sort()) {
      if (name === 'node_modules' || name === '.git') continue;
      const rel = relative ? relative + '/' + name : name;
      const p = await inside(root, rel), stat = await fs.lstat(p);
      if (stat.isDirectory()) await walk(rel);
      else if (stat.isFile()) result.push([rel, await fileHash(root, rel)]);
      else fail('Unsupported plugin file');
    }
  }
  await walk();
  return hash(json(result));
}
