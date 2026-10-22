import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {keepExtension} from './transport.mjs';
import {commandList, knownCredits, providerJobId, runJson} from './cli-run.mjs';

const GENERATE = new Set(['text', 'image', 'transition', 'extend', 'reference']);

export function buildPixverseCliArgs(task, idempotencyKey, inputs = []) {
  const mode = task.options?.mode ?? 'text';
  const operation = mode === 'text' || mode === 'image' ? 'video' : mode;
  if (!['video', 'image', 'transition', 'extend', 'upscale', 'modify', 'reference'].includes(operation)) throw new Error('Unsupported PixVerse CLI mode');
  const options = task.options ?? {};
  const args = ['create', operation];
  const push = (flag, value) => { if (value !== undefined && value !== null && value !== '') args.push(flag, String(value)); };
  if (mode !== 'upscale') push('--prompt', task.prompt);
  if (mode !== 'upscale') push('--model', options.model ?? 'v6');
  if (GENERATE.has(mode)) push('--duration', task.seconds);
  if (mode === 'text' || mode === 'reference') push('--aspect-ratio', options.aspect ?? '16:9');
  if (options.seed !== undefined) push('--seed', options.seed);
  if (mode !== 'upscale') push('--quality', options.quality ?? '360p');
  if (mode !== 'upscale') args.push('--count', '1');
  if (mode === 'image') { if (inputs.length !== 1) throw new Error('Image-to-video needs exactly one local image input'); push('--image', inputs[0]); }
  if (mode === 'transition') { if (inputs.length !== 2) throw new Error('Transition needs first and last local image inputs'); args.push('--images', ...inputs); }
  if (mode === 'extend' || mode === 'upscale' || mode === 'modify') push('--video', inputs[0]);
  if (mode === 'modify' && inputs.length > 1) args.push('--images', ...inputs.slice(1));
  if (mode === 'reference') args.push('--images', ...inputs);
  if (['text', 'image', 'transition', 'reference'].includes(mode) && options.audio !== undefined) args.push(options.audio ? '--audio' : '--no-audio');
  const key = String(idempotencyKey || '').replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 120);
  if (key) args.push('--idempotency-key', key);
  args.push('--no-wait', '--json');
  return args;
}

function defaultCommand() {
  return process.env.PIXVERSE_CLI ? [process.env.PIXVERSE_CLI] : ['pixverse'];
}

function notInstalled() {
  return new Error('PixVerse CLI is not installed. Install the official pixverse command, then run pixverse auth login. No generation was submitted.');
}
function notLoggedIn() {
  return new Error('PixVerse CLI is not logged in. Run pixverse auth login. No generation was submitted.');
}

async function assertLogin(call) {
  let body;
  try { body = await call(['auth', 'status', '--json'], 30000); }
  catch (error) {
    if (error.code === 'ENOENT') throw notInstalled();
    let parsed = null;
    try { parsed = JSON.parse(error.stdout || ''); } catch { /* status text is not the charge */ }
    if (Number(error.code) === 3 || parsed?.authenticated === false) throw notLoggedIn();
    throw new Error('PixVerse CLI login check failed. Run pixverse auth status --json. No generation was submitted.');
  }
  if (!body || body.authenticated !== true) throw notLoggedIn();
}

async function placeVideo(directory, output) {
  const files = (await fs.readdir(directory)).filter(name => /\.(mp4|mov|webm)$/i.test(name)).sort();
  if (files.length !== 1) throw new Error('PixVerse CLI did not return exactly one video file');
  await fs.writeFile(output, await fs.readFile(path.join(directory, files[0])), {flag: 'wx'});
}

export function createCli({command = null, invoke = null, keepTail = keepExtension} = {}) {
  const executable = commandList(command, defaultCommand());
  const call = invoke ?? (async (args, timeout) => runJson(executable, args, {timeout}));
  return {async make({task, output, inputs = [], idempotencyKey, onSubmitted}) {
    await assertLogin(call);
    if (typeof onSubmitted !== 'function') throw new Error('Durable submission callback required');
    const created = await call(buildPixverseCliArgs(task, idempotencyKey, inputs), 120000);
    const id = providerJobId(created);
    if (!id) throw new Error('PixVerse CLI did not return a task id; do not resubmit');
    await onSubmitted({providerJobId: id});
    const waited = await call(['task', 'wait', id, '--type', 'video', '--timeout', '900', '--json'], 960000);
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'tsugite-pixverse-'));
    try {
      await call(['asset', 'download', id, '--type', 'video', '--dest', directory, '--json'], 180000);
      await placeVideo(directory, output);
    } finally { await fs.rm(directory, {recursive: true, force: true}); }
    if ((task.options?.mode ?? 'text') === 'extend') await keepTail(output, task.seconds);
    const charged = knownCredits(waited);
    return {providerJobId: id, credits: charged === null ? knownCredits(created) : charged};
  }};
}
