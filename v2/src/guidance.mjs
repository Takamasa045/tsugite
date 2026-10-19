// Local preparation only. Rendering and approvals stay in the normal v2 flow.
import fs from 'node:fs/promises';
import path from 'node:path';
import { constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { stringify } from 'yaml';
import { config, currentPlan, state } from './core.mjs';
import { inputClips, audioTracks, captions, arrange } from './timeline.mjs';
import { inside, read, readJSON, write, fileHash, hash, json, locked, exists, fail } from './files.mjs';
import { command, probe } from '../plugins/local/index.mjs';

const home = '.tsugite/guidance';
const packFile = fileURLToPath(new URL('../packs/production-guides.json', import.meta.url));
const frameLimit = 24, copyLimit = 512 * 1024 * 1024;
const keys = (value, allowed, label) => {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !allowed.includes(k))) fail('Invalid ' + label);
};
const text = (value, limit = 2000) => typeof value === 'string' && value.trim() && value.length <= limit && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value);
async function boundedJSON(root, relative) {
  const target = await inside(root, relative), stat = await fs.lstat(target);
  if (!stat.isFile() || stat.size > 65536) fail('Guide request must be a regular JSON file of at most 64 KiB');
  return JSON.parse(await fs.readFile(target, 'utf8'));
}
async function pack() { const bytes = await fs.readFile(packFile); return { ...JSON.parse(bytes), digest: hash(bytes) }; }
async function localProject(root) {
  const value = await config(root);
  if (value.c.make.length) fail('Production guidance supports existing local media only; no generation tasks');
  if (value.c.use.length > 8 || (value.c.audio?.length ?? 0) > 8) fail('Choose at most eight clips and eight audio tracks for this guide');
  return value;
}
const ffInput = ['-protocol_whitelist', 'file,pipe', '-format_whitelist', 'mov,matroska,webm,avi,mpegts,wav,mp3,flac,ogg'];
async function capture(root, relative, directory, label, start = 0, seconds, loop = false) {
  const source = await inside(root, relative), before = await fileHash(root, relative), metadata = await probe(source);
  const duration = loop ? seconds ?? metadata.seconds : Math.min(seconds ?? metadata.seconds, metadata.seconds - start);
  if (!(duration > 0)) fail('No source frames in selected range');
  const frames = [];
  for (const [index, fraction] of [0, 0.5, 0.9].entries()) {
    const timelineOffset = Math.min(duration * fraction, Math.max(0, duration - 0.04));
    const time = loop ? (start + timelineOffset) % metadata.seconds : start + timelineOffset;
    const file = `${directory}/${label}-${index}.png`, target = await inside(root, file);
    await command('ffmpeg', ['-nostdin', '-v', 'error', '-n', ...ffInput, '-ss', String(time), '-i', source, '-frames:v', '1', '-vf', 'scale=640:640:force_original_aspect_ratio=decrease', '-threads', '1', target]);
    const signature = await fs.readFile(target);
    if (!signature.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) fail('Frame extraction did not produce a PNG');
    frames.push({ path: file, sha256: hash(signature), seconds: time, timelineOffset });
  }
  if (await fileHash(root, relative) !== before) fail('Media changed during guide inspection');
  return { path: relative, sha256: before, start, inspectedSeconds: duration, loop, metadata, frames };
}
async function audioEvidence(root, relative, directory, label, start = 0, seconds = 3) {
  const source = await inside(root, relative), metadata = await probe(source, 'audio');
  const file = `${directory}/${label}.wav`, duration = Math.min(seconds, metadata.seconds - start);
  if (!(duration > 0) || duration > 10) fail('Invalid bounded audio inspection range');
  await command('ffmpeg', ['-nostdin', '-v', 'error', '-n', ...ffInput, '-ss', String(start), '-i', source, '-map', '0:a:0', '-t', String(duration), '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', await inside(root, file)]);
  const { stderr, stdout } = await command('ffmpeg', ['-nostdin', '-hide_banner', ...ffInput, '-i', await inside(root, file), '-af', 'volumedetect', '-f', 's16le', '-'], { encoding: 'buffer' });
  const peak = stderr.toString('utf8').match(/max_volume:\s*(-?inf|[-\d.]+) dB/)?.[1];
  if (!peak) fail('Audio measurement failed');
  // volumedetect reports a finite ~-91 dB floor for all-zero s16 samples.
  // Inspect decoded PCM instead of treating that number as audible sound.
  return { path: file, sha256: await fileHash(root, file), source: relative, start, seconds: duration, maxDb: peak === '-inf' ? null : Number(peak), silent: stdout.length > 0 && stdout.every(byte => byte === 0), listening: 'not-listened' };
}
async function sourceUnchanged(root, inspection) {
  for (const source of inspection.sources) {
    if (await fileHash(root, source.path) !== source.sha256) fail('Inspected source changed; inspect again');
    for (const frame of source.frames) if (await fileHash(root, frame.path) !== frame.sha256) fail('Inspection frame changed; inspect again');
  }
  for (const audio of inspection.audio) if (await fileHash(root, audio.path) !== audio.sha256 || await fileHash(root, audio.source) !== audio.sourceSha256) fail('Inspected audio changed; inspect again');
}
function observations(value, frames, label) {
  if (!Array.isArray(value) || value.length !== frames.length || value.length > frameLimit) fail(label + ' requires an observation for every sampled frame');
  const seen = new Set();
  for (const observation of value) {
    keys(observation, ['path', 'sha256', 'observation'], label);
    const frame = frames.find(f => f.path === observation.path);
    if (!frame || seen.has(frame.path) || frame.sha256 !== observation.sha256 || !text(observation.observation)) fail('Invalid or stale ' + label);
    seen.add(frame.path);
  }
  // These are reported observations, not proof that another person watched.
  return value;
}
function listening(value) {
  keys(value, ['status', 'observation'], 'listening observation');
  if (!['not-listened', 'listened'].includes(value.status) || !text(value.observation)) fail('Invalid listening observation');
  return value;
}
export async function inspectGuidance(root) {
  return locked(root, async () => {
    const { c, configHash } = await localProject(root);
    let bytes = 0;
    for (const relative of new Set([...c.use.map(v => typeof v === 'string' ? v : v.path), ...(c.audio ?? []).map(a => a.path)])) {
      const stat = await fs.lstat(await inside(root, relative));
      if (!stat.isFile() || (bytes += stat.size) > copyLimit) fail('Guide inspection is limited to 512 MiB of regular local media');
    }
    const inputs = await inputClips(root, c.use), clips = arrange(inputs, [], c.length);
    const tracks = await audioTracks(root, c.audio ?? [], c.length), id = randomUUID(), directory = `${home}/inspections/${id}`;
    await fs.mkdir(await inside(root, directory), { recursive: true });
    const sources = [], audio = [];
    for (const [i, clip] of clips.entries()) {
      sources.push(await capture(root, clip.path, directory, 'clip-' + i, clip.start, clip.seconds, clip.loop));
      const audioStart = clip.loop ? clip.start % sources[i].metadata.seconds : clip.start;
      if (clip.audio) audio.push({ ...await audioEvidence(root, clip.path, directory, 'clip-audio-' + i, audioStart), sourceSha256: clip.hash });
    }
    for (const [i, track] of tracks.entries()) audio.push({ ...await audioEvidence(root, track.path, directory, 'track-' + i, track.offset), sourceSha256: track.hash });
    if (await fileHash(root, 'tsugite.yaml') !== configHash) fail('Project changed during inspection');
    const report = { version: 1, kind: 'material-inspection', id, configHash, sources, audio, semanticReview: 'pending', listening: 'pending', credits: 0 };
    const reportPath = directory + '/report.json';
    await write(root, reportPath, report); await write(root, home + '/current-inspection.json', { report: reportPath });
    return { report: reportPath, ...report, next: 'Open the actual sampled frames, listen where needed, then record observations in assets/guide-choice.json. Nothing is approved.' };
  });
}
async function defaultPrivateProfile() {
  // Checkout-only opt-in. A standalone package never scans the user's home.
  const repository = fileURLToPath(new URL('../../', import.meta.url));
  try {
    const pkg = await readJSON(repository, 'package.json');
    if (pkg.private !== true || pkg.scripts?.v2 !== 'node v2/bin/tsugite.mjs') return null;
    const candidate = await inside(repository, '.local/production-guidance.json');
    return await exists(candidate) ? candidate : null;
  } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}
async function privateGuidance(file, preset) {
  if (!file) return null;
  const directory = path.dirname(path.resolve(file)), relative = path.basename(file);
  const profile = await boundedJSON(directory, relative);
  keys(profile, ['version', 'source', 'common', 'presets'], 'private guide profile');
  if (profile.version !== 1 || typeof profile.source !== 'string' || !profile.source.endsWith('.md')) fail('Invalid private guide source');
  keys(profile.presets, ['clean', 'explain', 'rhythm'], 'private guide presets');
  const source = await inside(directory, profile.source), stat = await fs.lstat(source);
  if (!stat.isFile() || stat.size > 1000000) fail('Private guide source must be bounded local Markdown');
  const bytes = await fs.readFile(source), lines = bytes.toString('utf8').split(/\r?\n/), sections = [profile.common, profile.presets[preset]].filter(Boolean);
  const notes = [], digests = [];
  for (const section of sections) {
    keys(section, ['range', 'notes'], 'private guide section');
    if (!Array.isArray(section.range) || section.range.length !== 2 || !section.range.every(Number.isInteger) || section.range[0] < 1 || section.range[1] < section.range[0] || section.range[1] > lines.length || !Array.isArray(section.notes) || !section.notes.length || section.notes.length > 8 || section.notes.some(n => !text(n, 400) || /[\r\n]/.test(n))) fail('Invalid private guide section');
    notes.push(...section.notes); digests.push(hash(lines.slice(section.range[0] - 1, section.range[1]).join('\n')));
  }
  if (!sections.length) fail('No matching private guidance');
  // Never copy original prompt sections, source paths or full source text to knowledge.
  return { file: path.resolve(file), profileHash: await fileHash(directory, relative), sourceHash: hash(bytes), sectionHashes: digests, notes };
}
async function selection(root) {
  const current = await readJSON(root, home + '/current-selection.json');
  const value = await readJSON(root, current.report);
  if (value.kind !== 'guide-selection' || await fileHash(root, current.report) !== current.sha256 || await fileHash(root, 'tsugite.yaml') !== value.configHash || await fileHash(root, value.knowledge) !== value.knowledgeHash || (await pack()).digest !== value.packDigest) fail('Guide selection changed; inspect and select again');
  const inspected = await readJSON(root, value.inspection); await sourceUnchanged(root, inspected);
  if (value.privateGuide) {
    const fresh = await privateGuidance(value.privateGuide.file, value.preset);
    if (fresh.profileHash !== value.privateGuide.profileHash || fresh.sourceHash !== value.privateGuide.sourceHash) fail('Private guidance changed; select again');
  }
  return value;
}
export async function selectGuidance(root, request, { privateGuide } = {}) {
  return locked(root, async () => {
    if (!request?.startsWith('assets/')) fail('Guide choice must be in assets/');
    const choice = await boundedJSON(root, request);
    keys(choice, ['version', 'inspection', 'purpose', 'preset', 'intent', 'overrides', 'frames', 'audio'], 'guide choice');
    if (choice.version !== 1 || !text(choice.intent) || !['talk', 'montage', 'music'].includes(choice.purpose) || !['auto', 'clean', 'explain', 'rhythm'].includes(choice.preset ?? 'auto')) fail('Invalid guide choice');
    keys(choice.overrides, ['captions', 'music'], 'guide overrides');
    if (!['none', 'keep'].includes(choice.overrides.captions) || !['none', 'keep'].includes(choice.overrides.music)) fail('Choose explicit caption and added-music policies');
    const inspectedPath = choice.inspection ?? (await readJSON(root, home + '/current-inspection.json')).report;
    if (!inspectedPath.startsWith(home + '/inspections/') || !inspectedPath.endsWith('/report.json')) fail('Invalid inspection path');
    const inspected = await readJSON(root, inspectedPath), { c, configHash } = await localProject(root);
    if (inspected.kind !== 'material-inspection' || inspected.configHash !== configHash) fail('Material inspection is stale');
    await sourceUnchanged(root, inspected);
    const frameNotes = observations(choice.frames, inspected.sources.flatMap(s => s.frames), 'material review');
    const audio = listening(choice.audio), rules = await pack();
    const noText = choice.overrides.captions === 'none' || /(?:テロップ|字幕)(?:は)?(?:不要|なし)|no (?:new )?(?:captions|subtitles|text overlays)/i.test(choice.intent);
    const preset = noText ? 'clean' : choice.preset && choice.preset !== 'auto' ? choice.preset : Object.keys(rules.presets).find(k => rules.presets[k].purpose === choice.purpose);
    if (noText && c.renderer_options) fail('No-text intent conflicts with renderer graphics; explicitly convert them before selecting');
    const privateSnapshot = await privateGuidance(privateGuide ?? await defaultPrivateProfile(), preset);
    const id = randomUUID(), knowledge = `knowledge/production-guide-${id}.md`;
    const effective = { captions: noText ? 'none' : 'keep', music: choice.overrides.music };
    const notes = ['# Production guidance snapshot', '', 'Advisory preparation only; human checks remain in the confirmation page.', '', '## User intent', choice.intent, '', '## Explicit overrides', `Additional captions: ${effective.captions}. Additional music: ${effective.music}. Existing baked-in text/music cannot be removed by this policy.`, '', `## Selected purpose: ${preset}`, ...rules.presets[preset].guidance.map(n => '- ' + n), '', '## Common quality criteria', ...rules.quality.map(n => '- ' + n), ...(privateSnapshot ? ['', '## Selected private guidance (curated notes only)', ...privateSnapshot.notes.map(n => '- ' + n), 'Source snapshot: ' + privateSnapshot.sourceHash] : []), '', 'Visual observations are reported, not independent proof of viewing. Listen and inspect actual output before final approval.'].join('\n') + '\n';
    const previous = await readJSON(root, home + '/current-selection.json', null);
    const old = previous ? await readJSON(root, previous.report) : null;
    if (old) c.knowledge = c.knowledge.filter(p => p !== old.knowledge);
    c.knowledge.push(knowledge);
    if (noText) c.captions = [];
    if (effective.music === 'none') c.audio = (c.audio ?? []).filter(t => (t.kind ?? 'bgm') !== 'bgm');
    await write(root, home + `/history/${id}.yaml`, await read(root, 'tsugite.yaml'));
    await write(root, knowledge, notes);
    await write(root, 'tsugite.yaml', stringify(c));
    const report = { version: 1, kind: 'guide-selection', id, inspection: inspectedPath, preset, purpose: choice.purpose, intent: choice.intent, overrides: effective, frameObservations: frameNotes, audioObservation: audio, packDigest: rules.digest, privateGuide: privateSnapshot, knowledge, knowledgeHash: await fileHash(root, knowledge), configHash: await fileHash(root, 'tsugite.yaml'), approvals: 'not-granted' };
    const reportPath = `${home}/selections/${id}.json`;
    await write(root, reportPath, report); await write(root, home + '/current-selection.json', { report: reportPath, sha256: await fileHash(root, reportPath) });
    return { selection: reportPath, preset, overrides: effective, privateGuidanceUsed: !!privateSnapshot, knowledge, visualReview: 'reported', listening: audio.status, next: 'Prepare an opening preview, then plan it and wait for the human confirmation page. Presets do not synthesize edits automatically.' };
  });
}
async function copyBounded(root, destination, relative, budget) {
  const source = await inside(root, relative), stat = await fs.lstat(source);
  if (!stat.isFile() || (budget.bytes += stat.size) > copyLimit) fail('Preview copies are limited to 512 MiB of regular project files');
  const target = await inside(destination, relative); await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.copyFile(source, target, constants.COPYFILE_EXCL);
  if (await fileHash(root, relative) !== await fileHash(destination, relative)) fail('Source changed during preview copy');
}
export async function previewGuidance(root, seconds = 3) {
  return locked(root, async () => {
    if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 10) fail('Opening preview must be between zero and ten seconds');
    const selected = await selection(root), { c } = await localProject(root);
    if (c.export !== 'local' || c.renderer_options) fail('Opening preview currently supports the local FFmpeg renderer only; optional/native graphics need a separate reviewed preview');
    const length = Math.min(seconds, c.length), clips = arrange(await inputClips(root, c.use), [], c.length);
    const tracks = await audioTracks(root, c.audio ?? [], c.length), subtitle = await captions(root, c.captions, c.length);
    let remaining = length; const use = [];
    for (const clip of clips) { if (remaining <= 0.00001) break; const take = Math.min(remaining, clip.seconds); use.push({ path: clip.path, start: clip.start, seconds: take, audio: clip.audio, volume: clip.volume, loop: clip.loop }); remaining -= take; }
    const audio = tracks.filter(t => t.start < length).map(t => ({ path: t.path, start: t.start, offset: t.offset, seconds: Math.min(t.seconds, length - t.start), volume: t.volume, loop: t.loop, kind: t.kind }));
    const entries = subtitle.entries.filter(t => t.start < length).map(t => ({ ...t, end: Math.min(t.end, length) }));
    const id = randomUUID(), relative = `previews/guide-${id}`, destination = await inside(root, relative);
    await fs.mkdir(await inside(root, 'previews'), { recursive: true }); await fs.mkdir(destination);
    for (const dir of ['assets', 'out', 'taste', '.tsugite']) await fs.mkdir(await inside(destination, dir));
    const files = new Set([...use.map(t => t.path), ...audio.map(t => t.path), ...c.knowledge]), budget = { bytes: 0 };
    for (const file of files) await copyBounded(root, destination, file, budget);
    await selection(root); // Recheck inspected bytes/config after the copies.
    const project = { version: 2, name: c.name.slice(0, 180) + ' — opening preview', format: c.format, fps: c.fps ?? 24, length, use, audio, captions: entries, caption_mode: c.caption_mode ?? 'soft', export: 'local', execution: 'offline', budget: {}, checks: { auto_clips: false }, knowledge: c.knowledge };
    await write(destination, 'tsugite.yaml', stringify(project));
    await write(root, home + '/current-preview.json', { project: relative, selection: selected.id, configHash: await fileHash(root, 'tsugite.yaml'), previewConfigHash: await fileHash(destination, 'tsugite.yaml') });
    return { project: relative, projectDirectory: destination, seconds: length, copiedBytes: budget.bytes, rendered: false, approvals: 'not-granted', next: ['plan', 'make', 'export'].map(command => ({ command, project: destination })), note: 'Run plan for this preview; the human must approve its plan and clips in the page. No service is called.' };
  });
}
export async function reviewGuidance(root, request) {
  return locked(root, async () => {
    const selected = await selection(root), preview = await readJSON(root, home + '/current-preview.json');
    if (preview.selection !== selected.id || preview.configHash !== await fileHash(root, 'tsugite.yaml')) fail('Opening preview is stale');
    if (!preview.project.startsWith('previews/guide-')) fail('Invalid preview project');
    const directory = await inside(root, preview.project);
    if (await fileHash(directory, 'tsugite.yaml') !== preview.previewConfigHash) fail('Preview settings changed; prepare again');
    const { plan: p, digest } = await currentPlan(directory), s = await state(directory), rendered = s.renders[digest];
    if (p.seconds > 10) fail('Opening quality review is limited to ten seconds');
    if (rendered?.status !== 'done' || await fileHash(directory, 'out/final.mp4') !== rendered.hash) fail('Export the page-approved opening preview before quality review');
    const id = randomUUID(), reportDirectory = `${home}/reviews/${id}`; await fs.mkdir(await inside(root, reportDirectory), { recursive: true });
    const output = preview.project + '/out/final.mp4', measured = await capture(root, output, reportDirectory, 'output');
    await command('ffmpeg', ['-nostdin', '-v', 'error', ...ffInput, '-i', await inside(root, output), '-f', 'null', '-']);
    const audio = measured.metadata.hasAudio ? await audioEvidence(root, output, reportDirectory, 'output-audio', 0, p.seconds) : null;
    const intendedSound = p.timeline.clips.some(c => c.audio && c.volume > 0) || p.timeline.audio.some(a => a.volume > 0);
    const target = p.format === '9:16' ? [360,640] : p.format === '1:1' ? [640,640] : [640,360];
    const technical = { decoded: true, duration: Math.abs(measured.metadata.seconds - p.seconds) <= 0.15, dimensions: measured.metadata.width === target[0] && measured.metadata.height === target[1], noUnexpectedSubtitleTrack: selected.overrides.captions !== 'none' || !measured.metadata.hasCaptions, expectedSubtitleTrack: !p.timeline.captions.length || p.timeline.captionMode === 'burn' || measured.metadata.hasCaptions, intendedSoundPresent: !intendedSound || !!audio && !audio.silent };
    let frameNotes = null, heard = { status: 'not-listened', observation: 'Listening has not been reported.' };
    if (request) {
      if (!request.startsWith('assets/')) fail('Quality observations must be in assets/');
      const value = await boundedJSON(root, request); keys(value, ['version', 'outputSha256', 'frames', 'audio'], 'quality observations');
      const last = await readJSON(root, home + '/current-review.json', null);
      if (!last) fail('Create the quality evidence first, then inspect its frames');
      const evidence = await readJSON(root, last.report);
      if (value.version !== 1 || value.outputSha256 !== measured.sha256 || evidence.output.sha256 !== measured.sha256 || evidence.selection !== selected.id) fail('Quality observations are stale');
      for (const frame of evidence.output.frames) if (await fileHash(root, frame.path) !== frame.sha256) fail('Quality evidence changed');
      if (evidence.audio && await fileHash(root, evidence.audio.path) !== evidence.audio.sha256) fail('Quality audio evidence changed');
      frameNotes = observations(value.frames, evidence.output.frames, 'output review'); heard = listening(value.audio);
    }
    if (measured.sha256 !== rendered.hash || await fileHash(root, output) !== rendered.hash) fail('Output changed during quality review');
    const ready = Object.values(technical).every(Boolean) && !!frameNotes && (!intendedSound || heard.status === 'listened');
    const report = { version: 1, kind: 'opening-quality-review', selection: selected.id, preview: preview.project, output: measured, audio, technical, visual: { status: frameNotes ? 'reported-reviewed' : 'pending', observations: frameNotes, coverage: 'sampled frames only; not a full watch' }, listening: heard, readyForHumanFinalReview: ready, finalApproval: 'not-granted', credits: 0 };
    const reportPath = reportDirectory + '/report.json'; await write(root, reportPath, report); await write(root, home + '/current-review.json', { report: reportPath });
    return { report: reportPath, ...report, next: ready ? 'Human should watch the actual preview and decide in its confirmation page. Full export still needs its own current plan.' : 'Inspect the actual output frames and sound, then record observations; unfinished checks remain pending.' };
  });
}
