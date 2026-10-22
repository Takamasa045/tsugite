import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

const exec = promisify(execFile);
const CREDIT_KEYS = ['credits', 'credit', 'cost', 'cost_credits', 'costCredits', 'creditsConsumed', 'costCredit'];

export function commandList(command, fallback) {
  if (command == null) return fallback;
  const list = Array.isArray(command) ? command : [command];
  if (!list.length || list.some(part => typeof part !== 'string' || !part || /[\0\r\n]/.test(part))) throw new Error('Invalid CLI command');
  return list;
}

function redact(text) {
  return String(text || '').replace(/\b(api[_-]?key|token|authorization|secret)\b[^\n]*/gi, '[redacted]').trim().slice(0, 500);
}
export async function runCommand(command, args, {timeout = 30000} = {}) {
  try {
    return await exec(command[0], [...command.slice(1), ...args], {encoding: 'utf8', timeout, windowsHide: true, maxBuffer: 1024 * 1024 * 8});
  } catch (error) {
    if (error.code === 'ENOENT') {
      const missing = new Error('CLI_NOT_INSTALLED');
      missing.code = 'ENOENT';
      throw missing;
    }
    const stdout = redact(error.stdout);
    const stderr = redact(error.stderr);
    const safe = new Error([stderr, stdout].filter(Boolean).join('\n') || 'CLI command failed');
    safe.code = error.code;
    safe.stdout = stdout;
    safe.stderr = stderr;
    safe.outputText = safe.message;
    throw safe;
  }
}

export async function runJson(command, args, options) {
  const result = await runCommand(command, args, options);
  try { return JSON.parse(result.stdout); }
  catch { throw new Error('CLI returned non-JSON output'); }
}

// Explicit null and a missing field are both unknown. A finite number, including zero, is a reported amount.
export function knownCredits(value, keys = CREDIT_KEYS) {
  let found = null;
  const visit = item => {
    if (found !== null || !item || typeof item !== 'object') return;
    if (Array.isArray(item)) { item.forEach(visit); return; }
    for (const key of keys) {
      if (!Object.hasOwn(item, key)) continue;
      const candidate = item[key];
      if (typeof candidate === 'number' && Number.isFinite(candidate) && candidate >= 0) { found = candidate; return; }
      if (candidate && typeof candidate === 'object') visit(candidate);
    }
    for (const [key, child] of Object.entries(item)) if (!keys.includes(key)) visit(child);
  };
  visit(value);
  return found;
}

const JOB_KEYS = ['video_id', 'videoId', 'task_id', 'taskId', 'generationId', 'id'];
export function providerJobId(value) {
  const walk = item => {
    if (Array.isArray(item)) { for (const child of item) { const found = walk(child); if (found) return found; } return null; }
    if (!item || typeof item !== 'object') return null;
    for (const key of JOB_KEYS) {
      const candidate = item[key];
      if (typeof candidate === 'string' && /^[-a-zA-Z0-9_]{1,128}$/.test(candidate)) return candidate;
      if (typeof candidate === 'number' && Number.isSafeInteger(candidate) && candidate > 0) return String(candidate);
    }
    for (const child of Object.values(item)) { const found = walk(child); if (found) return found; }
    return null;
  };
  return walk(value);
}
