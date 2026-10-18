import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { parse, stringify } from 'yaml';
import { hash, json, fail, read, readJSON, write, inside, exists, locked, fileHash } from './files.mjs';
import { units, validateBudget, reserve, settle, budgetView } from './budget.mjs';
import { plugin, pluginID } from './plugins.mjs';
import { taste } from './taste.mjs';
import { sample, probe, command } from '../plugins/local/index.mjs';

const stateFile = '.tsugite/state.json';
const initialState = { version: 1, ledger: { entries: [] }, jobs: {}, renders: {}, events: [] };
export const state = root => readJSON(root, stateFile, initialState);
export async function saveState(root, s, event) {
  if (event) s.events.push({ at: new Date().toISOString(), ...event });
  // One atomic document is authoritative for ledger, jobs and history.
  await write(root, stateFile, s);
}
export async function config(root) {
  const bytes = await read(root, 'tsugite.yaml');
  const c = parse(bytes, { maxAliasCount: 0 });
  if (!c || typeof c !== 'object' || Array.isArray(c)) fail('Invalid tsugite.yaml');
  const allowed = ['version','name','format','length','use','make','export','budget','checks','knowledge'];
  for (const key of Object.keys(c)) if (!allowed.includes(key)) fail('Unknown project field: ' + key);
  if (c.version !== undefined && c.version !== 2) fail('Expected project version 2');
  if (typeof c.name !== 'string' || !c.name.trim() || c.name.length > 200) fail('Project needs a name');
  if (!['9:16','16:9','1:1'].includes(c.format)) fail('Unsupported format');
  const seconds = typeof c.length === 'number' ? c.length : /^\d+(\.\d+)?s$/.test(c.length) ? Number(c.length.slice(0,-1)) : NaN;
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 3600) fail('Length must be between 0 and 3600 seconds');
  c.length = seconds;
  c.use ??= []; c.make ??= []; c.budget ??= {}; c.knowledge ??= [];
  if (!Array.isArray(c.use) || !Array.isArray(c.make) || !Array.isArray(c.knowledge) || c.use.length + c.make.length === 0 || c.use.length + c.make.length > 100) fail('Use 1–100 clips');
  validateBudget(c.budget); pluginID(c.export);
  if (c.checks && (Object.keys(c.checks).some(x => x !== 'auto_clips') || typeof c.checks.auto_clips !== 'boolean')) fail('Invalid checks settings');
  const ids = new Set();
  for (const m of c.make) {
    if (!m || Object.keys(m).some(x => !['id','with','prompt','seconds'].includes(x))) fail('Invalid make task');
    pluginID(m.id); pluginID(m.with);
    if (ids.has(m.id) || typeof m.prompt !== 'string' || m.prompt.length > 10000 || !Number.isFinite(m.seconds) || m.seconds <= 0 || m.seconds > 600) fail('Invalid or duplicate make task');
    ids.add(m.id);
  }
  for (const f of c.use) { if (typeof f !== 'string' || !f.startsWith('assets/')) fail('Inputs must be inside assets/'); await inside(root, f); }
  for (const f of c.knowledge) { if (typeof f !== 'string' || !f.endsWith('.md')) fail('Knowledge packs must be Markdown paths'); await inside(root, f); }
  return { c, configHash: hash(bytes) };
}
async function buildPlan(root) {
  const { c, configHash } = await config(root), plugins = {}, tasks = [];
  const retries = await readJSON(root, '.tsugite/retries.json', {});
  const inputs = [];
  for (let i = 0; i < c.use.length; i++) {
    const relative = c.use[i];
    const metadata = await probe(await inside(root, relative));
    inputs.push({ id: `input-${i}`, path: relative, hash: await fileHash(root, relative), ...metadata });
  }
  const renderer = await plugin(root, c.export);
  if (!renderer.manifest.capabilities.includes('renderer')) fail('Plugin cannot render');
  plugins[c.export] = renderer.manifest;
  for (const task of c.make) {
    const { manifest, implementation } = await plugin(root, task.with, true);
    if (!manifest.capabilities.includes('source') || typeof implementation.make !== 'function') fail('Plugin cannot make clips');
    const quote = await implementation.quote(task);
    units(quote.credits); pluginID(quote.service);
    plugins[task.with] = manifest;
    const identity = hash(json({ task, plugin: manifest.digest, attempt: retries[task.id] ?? 0 }));
    tasks.push({ ...task, quote, key: identity });
  }
  const clips = [...inputs.map(x => ({ id: x.id, path: x.path, hash: x.hash, seconds: c.length / (inputs.length + tasks.length) })), ...tasks.map(x => ({ id: x.id, path: `.tsugite/media/${x.key}.mp4`, seconds: x.seconds, taskKey: x.key }))];
  // Scale durations to the requested total while retaining the proposed ratios.
  const total = clips.reduce((sum,x) => sum + x.seconds, 0);
  for (const clip of clips) clip.seconds = clip.seconds / total * c.length;
  const knowledge = [];
  for (const file of c.knowledge) knowledge.push({ path: file, text: await read(root, file) });
  const plan = { version: 2, configHash, name: c.name, format: c.format, seconds: c.length, renderer: c.export, plugins, inputs, tasks, timeline: { version: 1, format: c.format, seconds: c.length, clips }, budget: c.budget, checks: c.checks ?? {}, taste: await taste(root), knowledge };
  const s = await state(root);
  reserve(s.ledger, tasks.map(t => ({ id: t.key, ...t.quote })), c.budget);
  return plan;
}
export async function plan(root) {
  return locked(root, async () => {
    const value = await buildPlan(root);
    let previous;
    try { previous = await read(root,'.tsugite/plan.json'); } catch(e) { if(e.code!=='ENOENT') throw e; }
    if (previous !== undefined && previous !== json(value)) {
      // Preserve superseded records and never revive approval by reverting files.
      for (const stage of ['plan','clips','final']) {
        const approval = await readJSON(root,`.tsugite/approvals/${stage}.json`,{});
        if (approval.scope) {
          await write(root,`.tsugite/approvals/history/${randomUUID()}.json`,approval);
          await write(root,`.tsugite/approvals/${stage}.json`,{stage,superseded:true});
        }
      }
    }
    await write(root, '.tsugite/plan.json', value);
    const digest = hash(json(value));
    await write(root, `.tsugite/plans/${digest}.json`, value);
    return { plan: value, digest, waitingFor: 'plan check', review: 'Use tsugite plan --review to open the confirmation page' };
  });
}
export async function currentPlan(root) {
  const raw = await read(root, '.tsugite/plan.json'), value = JSON.parse(raw);
  if (json(await buildPlan(root)) !== json(value)) fail('Plan no longer matches files or settings; run tsugite plan');
  return { plan: value, digest: hash(raw) };
}
async function mediaSnapshot(root, p, s) {
  return Promise.all(p.timeline.clips.map(async clip => {
    if (clip.taskKey && s.jobs[clip.taskKey]?.status !== 'done') fail('Clips are not ready');
    const digest = await fileHash(root, clip.path);
    if (clip.taskKey ? digest !== s.jobs[clip.taskKey].hash : digest !== clip.hash) fail('Clip changed; replan or recover explicitly');
    return { path: clip.path, hash: digest };
  }));
}
export async function checkScope(root, stage, p, digest, s) {
  if (stage === 'plan') return digest;
  const media = await mediaSnapshot(root, p, s);
  if (stage === 'clips') return hash(json({ digest, media }));
  if (stage === 'final') {
    const output = s.renders[digest];
    if (!output || output.status !== 'done' || await fileHash(root, output.path) !== output.hash || await fileHash(root, 'out/final.mp4') !== output.hash) fail('Final output is missing or changed');
    return hash(json({ digest, media, output }));
  }
  fail('Invalid check');
}
export async function requireApproval(root, stage, p, digest, s) {
  const scope = await checkScope(root, stage, p, digest, s);
  const approval = await readJSON(root, `.tsugite/approvals/${stage}.json`, {});
  if (approval.scope !== scope || approval.digest !== digest || approval.stage !== stage) fail(`Waiting for ${stage} check in the confirmation page`);
  return scope;
}
// Not exported: only the local review HTTP handler can record a check.
export async function status(root) {
  const { plan: p, digest } = await currentPlan(root), s = await state(root), checks = {};
  for (const stage of ['plan','clips','final']) {
    try { await requireApproval(root, stage, p, digest, s); checks[stage] = 'approved'; }
    catch { checks[stage] = 'waiting'; }
  }
  return { name: p.name, digest, checks, budget: budgetView(s.ledger), jobs: s.jobs, output: s.renders[digest] ?? null, plan: p };
}
export async function make(root) {
  return locked(root, async () => {
    const { plan: p, digest } = await currentPlan(root), s = await state(root);
    await requireApproval(root, 'plan', p, digest, s);
    // Reserve the whole batch atomically before the first side effect.
    s.ledger = reserve(s.ledger, p.tasks.map(t => ({ id: t.key, ...t.quote })), p.budget);
    await saveState(root, s, { action: 'reserve', digest });
    for (const task of p.tasks) {
      const previous = s.jobs[task.key];
      if (previous?.status === 'done') { if (await fileHash(root, previous.path) !== previous.hash) fail('Completed clip changed'); continue; }
      const reservation = s.ledger.entries.find(x => x.id === task.key);
      if (previous || reservation.status !== 'reserved') fail('Uncertain task outcome; reconcile before retry');
      const relative = `.tsugite/media/${task.key}.mp4`, output = await inside(root, relative);
      await fs.mkdir(path.dirname(output), { recursive: true });
      if (await exists(output)) fail('Untracked output exists; inspect before recovery');
      s.jobs[task.key] = { id: task.id, path: relative, status: 'started' }; reservation.status = 'started';
      await saveState(root, s, { action: 'make-start', id: task.id });
      try {
        if ((await currentPlan(root)).digest !== digest) fail('Plan changed before execution');
        const { implementation } = await plugin(root, task.with, true);
        const result = await implementation.make({ task, output, sample: p.inputs.length ? await inside(root, p.inputs[0].path) : undefined, idempotencyKey: task.key });
        await probe(output);
        settle(s.ledger, task.key, result.credits);
        s.jobs[task.key] = { id: task.id, path: relative, status: 'done', hash: await fileHash(root, relative) };
        await saveState(root, s, { action: 'make-done', id: task.id });
      } catch (e) {
        // Keep the full reservation on errors and crashes. Never infer a refund.
        reservation.status = 'uncertain'; s.jobs[task.key].status = 'uncertain';
        await saveState(root, s, { action: 'make-uncertain', id: task.id });
        throw e;
      }
    }
    await mediaSnapshot(root, p, s);
    if (!p.tasks.length && p.checks.auto_clips === true) {
      const scope = await checkScope(root, 'clips', p, digest, s);
      await write(root, '.tsugite/approvals/clips.json', { stage: 'clips', digest, scope, source: 'configured-zero-new-assets', at: new Date().toISOString() });
    }
    return { made: p.tasks.length, waitingFor: p.tasks.length || !p.checks.auto_clips ? 'clips check' : 'export', budget: budgetView(s.ledger) };
  });
}
export async function exportVideo(root) {
  return locked(root, async () => {
    const { plan: p, digest } = await currentPlan(root), s = await state(root);
    await requireApproval(root, 'plan', p, digest, s);
    await requireApproval(root, 'clips', p, digest, s);
    if (s.renders[digest]?.status === 'done') {
      await checkScope(root, 'final', p, digest, s);
      return { output: s.renders[digest].path, reused: true, waitingFor: 'final check' };
    }
    if (s.renders[digest]) fail('Previous export interrupted; inspect recorded run before recovery');
    const run = randomUUID(), scratch = await inside(root, `.tsugite/renders/${run}`);
    await fs.mkdir(scratch, { recursive: true });
    const relative = `.tsugite/renders/${run}/final.mp4`, output = await inside(root, relative);
    s.renders[digest] = { path: relative, status: 'started' };
    await saveState(root, s, { action: 'export-start', digest });
    try {
      const { implementation } = await plugin(root, p.renderer, true);
      if (typeof implementation.render !== 'function') fail('Renderer missing render');
      const quote = await implementation.quote(p.timeline);
      if (quote.credits !== 0) fail('This alpha permits only zero-credit exports');
      const result = await implementation.render({ timeline: p.timeline, inputs: await Promise.all(p.timeline.clips.map(x => inside(root, x.path))), output, scratch });
      if (result.credits !== 0) fail('Renderer violated zero-credit contract');
      if ((await currentPlan(root)).digest !== digest) fail('Plan changed during export');
      const metadata = await probe(output);
      if (Math.abs(metadata.seconds - p.seconds) > 0.15) fail('Export duration does not match plan');
      // Archive is authoritative; out/final.mp4 is a convenience copy.
      const final = await inside(root, 'out/final.mp4'); await fs.mkdir(path.dirname(final), { recursive: true });
      await fs.copyFile(output, final);
      s.renders[digest] = { path: relative, status: 'done', hash: await fileHash(root, relative), ...metadata };
      await saveState(root, s, { action: 'export-done', digest });
      return { output: 'out/final.mp4', archive: relative, ...metadata, waitingFor: 'final check' };
    } catch (e) { s.renders[digest].status = 'uncertain'; await saveState(root, s, { action: 'export-uncertain', digest }); throw e; }
  });
}
export async function init(destination) {
  await fs.mkdir(destination, { recursive: false });
  try {
    for (const dir of ['assets','taste','out','.tsugite']) await fs.mkdir(await inside(destination, dir));
    await sample(await inside(destination, 'assets/intro.mp4'));
    await write(destination, 'tsugite.yaml', stringify({ version: 2, name: 'My first 継手', format: '9:16', length: '6s', use: ['assets/intro.mp4'], export: 'local', budget: {}, checks: { auto_clips: true } }));
    await write(destination, 'taste/rules.md', '# Taste rules\n');
    return { project: destination, next: 'tsugite check; tsugite plan' };
  } catch (e) { fail('Init stopped; partial files retained for inspection: ' + e.message); }
}
export async function environment(root) {
  const checks = {};
  for (const program of ['ffmpeg','ffprobe']) { try { await command(program, ['-version']); checks[program] = 'ready'; } catch { checks[program] = 'missing'; } }
  checks.node = Number(process.versions.node.split('.')[0]) >= 22 ? 'ready' : 'unsupported';
  if (root) { try { await buildPlan(root); checks.project = 'ready'; } catch (e) { checks.project = e.message; } }
  return { ok: Object.values(checks).every(x => x === 'ready'), checks };
}
export async function cleanPreview(root) {
  const { plan: p, digest } = await currentPlan(root), s = await state(root);
  await requireApproval(root, 'final', p, digest, s);
  const keep = new Set(p.timeline.clips.map(x => x.path));
  keep.add(s.renders[digest].path);
  const files = [];
  // Only known generated, settled files; never inspect user assets for removal.
  for (const job of Object.values(s.jobs)) if (job.status === 'done' && !keep.has(job.path) && job.path.startsWith('.tsugite/media/')) files.push({ path: job.path, hash: await fileHash(root, job.path) });
  for (const render of Object.values(s.renders)) if (render.status === 'done' && !keep.has(render.path) && render.path.startsWith('.tsugite/renders/')) files.push({ path: render.path, hash: await fileHash(root, render.path) });
  return { digest, files, previewDigest: hash(json({ digest, files })), mode: 'move-to-project-trash', preserved: ['assets','taste','approvals','plans','state','final output'] };
}
