import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {existsSync, readdirSync} from 'node:fs';
import {commandList, knownCredits, providerJobId, runCommand, runJson} from './cli-run.mjs';

export function loginInvocation(command) {
  const script = command.find(part => part.endsWith('video_gen.py'));
  if (!script) return {command, args: ['auth', 'status', '--json']};
  return {command: [command[0], script.slice(0, -'video_gen.py'.length) + 'auth.py'], args: ['status']};
}

export function discoverTopviewCommand(home, environment = process.env) {
  if (environment.TSUGITE_TOPVIEW_VIDEO_COMMAND) {
    let parsed;
    try { parsed = JSON.parse(environment.TSUGITE_TOPVIEW_VIDEO_COMMAND); }
    catch { throw new Error('TSUGITE_TOPVIEW_VIDEO_COMMAND must be a JSON command array'); }
    if (!Array.isArray(parsed) || !parsed.length || parsed.some(part => typeof part !== 'string' || !part)) throw new Error('TSUGITE_TOPVIEW_VIDEO_COMMAND must be a JSON command array');
    return parsed;
  }
  const python = environment.TSUGITE_TOPVIEW_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
  const direct = path.join(home, '.agents', 'skills', 'topview-skill', 'scripts', 'video_gen.py');
  if (existsSync(direct)) return [python, direct];
  const cacheRoot = path.join(home, '.codex', 'plugins', 'cache', 'local', 'topview-ai');
  try {
    const versions = readdirSync(cacheRoot, {withFileTypes: true}).filter(entry => entry.isDirectory()).map(entry => entry.name).sort().reverse();
    for (const version of versions) {
      const candidate = path.join(cacheRoot, version, 'skills', 'topview-skill', 'scripts', 'video_gen.py');
      if (existsSync(candidate)) return [python, candidate];
    }
  } catch { /* missing cache is not installed */ }
  throw new Error('TopView CLI is not installed. Install the official TopView skill (video_gen.py) or set the connection command. No generation was submitted.');
}

export function buildTopviewCliArgs(task, inputs, outputDir) {
  const options = task.options ?? {};
  const mode = options.mode ?? 'text';
  if (!['text', 'image'].includes(mode)) throw new Error('Unsupported TopView mode');
  if (typeof options.model !== 'string' || !options.model.trim()) throw new Error('Choose a TopView model explicitly');
  const args = ['run', '--type', mode === 'image' ? 'i2v' : 't2v', '--model', options.model, '--prompt', task.prompt, '--duration', String(task.seconds), '--count', '1', '--resolution', String(options.resolution ?? 720), '--aspect-ratio', options.aspect ?? '16:9', '--output-dir', outputDir, '--json', '--quiet', '--timeout', '900'];
  if (mode === 'image') { if (inputs.length !== 1) throw new Error('Image-to-video needs exactly one local image input'); args.push('--first-frame', inputs[0]); }
  if (options.sound !== undefined) args.push('--sound', options.sound ? 'on' : 'off');
  return args;
}

function notInstalled() {
  return new Error('TopView CLI is not installed. Install the official TopView skill (video_gen.py) or set the connection command. No generation was submitted.');
}
function notLoggedIn() {
  return new Error('TopView CLI is not logged in. Run python auth.py login from the official TopView skill. No generation was submitted.');
}

async function placeVideo(directory, output) {
  const files = (await fs.readdir(directory)).filter(name => /\.(mp4|mov|webm)$/i.test(name)).sort();
  if (files.length !== 1) throw new Error('TopView CLI did not return exactly one video file');
  await fs.writeFile(output, await fs.readFile(path.join(directory, files[0])), {flag: 'wx'});
}

export function createCli({command = null, invoke = null} = {}) {
  const executable = command == null && invoke == null ? discoverTopviewCommand(os.homedir()) : commandList(command, ['topview']);
  const call = invoke ?? (async (args, timeout, prefix = executable) => runJson(prefix, args, {timeout}));
  return {async make({task, output, inputs = [], onSubmitted}) {
    const login = loginInvocation(executable);
    try {
      if (invoke) await call(login.args, 30000, login.command);
      else await runCommand(login.command, login.args, {timeout: 30000});
    } catch (error) {
      if (error.code === 'ENOENT') throw (login.command === executable ? notInstalled() : notLoggedIn());
      throw notLoggedIn();
    }
    if (typeof onSubmitted !== 'function') throw new Error('Durable submission callback required');
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'tsugite-topview-'));
    try {
      let created;
      try { created = await call(buildTopviewCliArgs(task, inputs, directory), 960000); }
      catch (error) { if (error.code === 'ENOENT') throw notInstalled(); throw new Error('TopView CLI failed before a task id was saved; do not resubmit'); }
      const id = providerJobId(created);
      if (!id) throw new Error('TopView CLI did not return a task id; do not resubmit');
      await onSubmitted({providerJobId: id});
      await placeVideo(directory, output);
      return {providerJobId: id, credits: knownCredits(created)};
    } finally { await fs.rm(directory, {recursive: true, force: true}); }
  }};
}
