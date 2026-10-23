import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {commandList, knownCredits, providerJobId, runJson} from './cli-run.mjs';

export function buildKlingCliArgs(task) {
  const options = task.options ?? {};
  const model = options.model ?? 'kling-3.0';
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(model)) throw new Error('Invalid Kling CLI model');
  if ((task.inputs ?? []).length) throw new Error('Kling CLI in v2 currently sends text-to-video only');
  const args = ['text_to_video', '--model', model, '--duration', String(task.seconds), '--aspectRatio', options.aspect ?? '16:9'];
  if (options.quality) args.push('--resolution', options.quality);
  args.push('--poll', '900', '--quiet', task.prompt);
  return args;
}

function defaultCommand() {
  return process.env.KLING_CLI ? [process.env.KLING_CLI] : ['kling'];
}
function notInstalled() {
  return new Error('Kling CLI is not installed. Install the official kling command, then run kling login. No generation was submitted.');
}
function notLoggedIn() {
  return new Error('Kling CLI is not logged in. Run kling login. No generation was submitted.');
}
function privateHost(hostname) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return host === 'localhost' || host.endsWith('.localhost') || host === '::1' || /^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host) || /^169\.254\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host);
}
function strings(value, found = []) {
  if (typeof value === 'string') found.push(value);
  else if (Array.isArray(value)) value.forEach(item => strings(item, found));
  else if (value && typeof value === 'object') Object.values(value).forEach(item => strings(item, found));
  return found;
}
async function place(bytes, output) {
  await fs.writeFile(output, bytes, {flag: 'wx'});
}
async function materialize(body, output, fetch) {
  const values = strings(body);
  const remote = values.map(value => { try { return new URL(value); } catch { return null; } }).find(url => url && url.protocol === 'https:' && /\.(mp4|mov|webm)$/i.test(url.pathname));
  if (remote) {
    if (remote.username || remote.password || privateHost(remote.hostname)) throw new Error('Kling media URL must use public HTTPS');
    const response = await fetch(remote, {redirect: 'error', credentials: 'omit'});
    if (!response.ok) throw new Error('Kling media download failed; verify billing before retry');
    const limit = 64 * 1024 * 1024;
    if (Number(response.headers.get('content-length')) > limit) throw new Error('Kling media download exceeds the size limit');
    const chunks = []; let size = 0;
    for await (const chunk of response.body ?? []) { size += chunk.length; if (size > limit) throw new Error('Kling media download exceeds the size limit'); chunks.push(Buffer.from(chunk)); }
    await place(Buffer.concat(chunks), output);
    return;
  }
  const root = await fs.realpath(os.tmpdir());
  for (const candidate of values) {
    if (!path.isAbsolute(candidate) || !/\.(mp4|mov|webm)$/i.test(candidate)) continue;
    let real;
    try { real = await fs.realpath(candidate); } catch { continue; }
    if (real !== root && !real.startsWith(root + path.sep)) continue;
    await place(await fs.readFile(real), output);
    return;
  }
  throw new Error('Kling CLI completed without a downloadable video');
}

export function createCli({command = null, invoke = null, fetch = globalThis.fetch} = {}) {
  const executable = commandList(command, defaultCommand());
  const call = invoke ?? (async (args, timeout) => runJson(executable, args, {timeout}));
  return {async make({task, output, onSubmitted}) {
    let identity;
    try { identity = await call(['who_am_i', '--quiet'], 30000); }
    catch (error) {
      if (error.code === 'ENOENT') throw notInstalled();
      throw notLoggedIn();
    }
    const user = identity?.user ?? identity?.body?.user;
    if (!user || user.userId === undefined || user.userId === null || user.userId === '') throw notLoggedIn();
    if (typeof onSubmitted !== 'function') throw new Error('Durable submission callback required');
    const created = await call(buildKlingCliArgs(task), 960000);
    const id = providerJobId(created);
    if (!id) throw new Error('Kling CLI did not return a task id; do not resubmit');
    await onSubmitted({providerJobId: id});
    await materialize(created, output, fetch);
    return {providerJobId: id, credits: knownCredits(created)};
  }};
}
