import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { fixture, settings, page } from './helpers.mjs';
import { inspectGuidance, selectGuidance, previewGuidance, reviewGuidance } from '../src/guidance.mjs';
import { plan, make, exportVideo, status, currentPlan } from '../src/core.mjs';
import { read, readJSON, write, fileHash } from '../src/files.mjs';
import { command } from '../plugins/local/index.mjs';

const exec = promisify(execFile), cli = fileURLToPath(new URL('../bin/tsugite.mjs', import.meta.url));
async function choice(root, report, overrides = {}) {
  const value = { version: 1, inspection: report.report, purpose: 'talk', preset: 'auto', intent: 'Keep the source visible; no captions.', overrides: { captions: 'none', music: 'none' }, frames: report.sources.flatMap(s => s.frames).map(frame => ({ path: frame.path, sha256: frame.sha256, observation: 'Test observation on the extracted fixture frame; not an independent human review.' })), audio: { status: 'not-listened', observation: 'Synthetic muted fixture; no listening claim.' }, ...overrides };
  await write(root, 'assets/guide-choice.json', value); return value;
}
async function selected(t, overrides, projectSettings) {
  const value = await fixture(t); if (projectSettings) await settings(value.root, projectSettings);
  const inspected = await inspectGuidance(value.root);
  await choice(value.root, inspected, overrides); const result = await selectGuidance(value.root, 'assets/guide-choice.json');
  return { ...value, inspected, result };
}
async function rendered(t, overrides, projectSettings) {
  const value = await selected(t, overrides, projectSettings), preview = await previewGuidance(value.root, 2), project = path.join(value.root, preview.project);
  await plan(project); const ui = await page(t, project);
  await assert.rejects(make(project), /Waiting for plan check/);
  await ui.submit('approve', { stage: 'plan' }); await make(project);
  await assert.rejects(exportVideo(project), /Waiting for clips check/);
  await ui.refresh(); await ui.submit('approve', { stage: 'clips' }); await exportVideo(project);
  return { ...value, preview, project };
}
test('guide inspects real media and writes hash-bound frame evidence without claiming semantic or listening work', async t => {
  const { root } = await fixture(t), before = await fileHash(root, 'assets/intro.mp4'), configHash = await fileHash(root, 'tsugite.yaml');
  const inspected = await inspectGuidance(root);
  assert.equal(inspected.sources.length, 1); assert.equal(inspected.sources[0].frames.length, 3);
  assert.equal(inspected.semanticReview, 'pending'); assert.equal(inspected.credits, 0);
  for (const frame of inspected.sources[0].frames) {
    assert.equal(await fileHash(root, frame.path), frame.sha256);
    assert.ok((await fs.stat(path.join(root, frame.path))).size > 1000);
  }
  assert.equal(await fileHash(root, 'assets/intro.mp4'), before); assert.equal(await fileHash(root, 'tsugite.yaml'), configHash);
  await choice(root, inspected, { frames: [] }); await assert.rejects(selectGuidance(root, 'assets/guide-choice.json'), /every sampled frame/);
  await choice(root, inspected); await fs.appendFile(path.join(root, 'assets/intro.mp4'), 'changed');
  await assert.rejects(selectGuidance(root, 'assets/guide-choice.json'), /Inspected source changed/);
});
test('explicit no-text instruction wins over an explain preset, invalidates the old plan, and preserves approval files', async t => {
  const { root } = await fixture(t); await settings(root, { captions: [{ start: 0, end: 2, text: 'Existing caption' }] });
  await plan(root); const ui = await page(t, root); await ui.submit('approve', { stage: 'plan' });
  const approval = await fileHash(root, '.tsugite/approvals/plan.json'), inspected = await inspectGuidance(root);
  await choice(root, inspected, { preset: 'explain', intent: '今回はテロップ不要', overrides: { captions: 'keep', music: 'none' } });
  const result = await selectGuidance(root, 'assets/guide-choice.json'); assert.equal(result.preset, 'clean'); assert.equal(result.overrides.captions, 'none');
  const config = parse(await read(root, 'tsugite.yaml')); assert.deepEqual(config.captions, []); assert.ok(config.knowledge.includes(result.knowledge));
  assert.equal(await fileHash(root, '.tsugite/approvals/plan.json'), approval);
  await assert.rejects(make(root), /Plan no longer matches/);
  await assert.rejects(selectGuidance(root, 'assets/guide-choice.json'), /inspection is stale/);
});
test('private profile uses only selected curated notes, reads original sections without copying them, and detects changes', async t => {
  const { root, home } = await fixture(t), directory = path.join(home, 'private-guidance'); await fs.mkdir(directory);
  await fs.writeFile(path.join(directory, 'source.md'), 'PRIVATE ORIGINAL PROMPT NEVER COPY\nsource section two\n');
  const profile = { version: 1, source: 'source.md', common: { range: [1, 1], notes: ['Check the actual subject first.'] }, presets: { clean: { range: [2, 2], notes: ['Keep this local edit restrained.'] } } };
  const privateFile = path.join(directory, 'profile.json'); await fs.writeFile(privateFile, JSON.stringify(profile));
  const inspected = await inspectGuidance(root); await choice(root, inspected);
  const result = await selectGuidance(root, 'assets/guide-choice.json', { privateGuide: privateFile });
  assert.equal(result.privateGuidanceUsed, true); const knowledge = await read(root, result.knowledge);
  assert.match(knowledge, /Keep this local edit restrained/); assert.doesNotMatch(knowledge, /PRIVATE ORIGINAL|source section two/);
  const selection = await read(root, result.selection); assert.doesNotMatch(selection, /PRIVATE ORIGINAL|source section two/);
  await fs.appendFile(path.join(directory, 'source.md'), 'changed\n'); await assert.rejects(previewGuidance(root), /Private guidance changed/);
});
test('guide rejects traversal, symlink evidence, oversized requests, conflicting graphics, and generation tasks', async t => {
  const { root, home } = await fixture(t), inspected = await inspectGuidance(root); await choice(root, inspected);
  await assert.rejects(selectGuidance(root, '../choice.json'), /must be in assets/);
  await assert.rejects(selectGuidance(root, 'assets/../choice.json'), /Unsafe/);
  await write(root, 'assets/too-large.json', ' '.repeat(65537)); await assert.rejects(selectGuidance(root, 'assets/too-large.json'), /64 KiB/);
  await fs.symlink(path.join(root, 'assets/guide-choice.json'), path.join(root, 'assets/link.json')); await assert.rejects(selectGuidance(root, 'assets/link.json'), /Symlinks/);
  const dir = path.join(home, 'private'); await fs.mkdir(dir); await fs.writeFile(path.join(dir, 'bad.json'), JSON.stringify({ version: 1, source: '../source.md', common: { range: [1,1], notes: ['Unsafe'] }, presets: {} }));
  await assert.rejects(selectGuidance(root, 'assets/guide-choice.json', { privateGuide: path.join(dir, 'bad.json') }), /Unsafe/);
  await settings(root, { renderer_options: {} }); const changed = await inspectGuidance(root); await choice(root, changed);
  await assert.rejects(selectGuidance(root, 'assets/guide-choice.json'), /conflicts with renderer graphics/);
  await settings(root, { renderer_options: undefined, make: [{ id: 'paid', with: 'pixverse', prompt: 'must not run', seconds: 1 }] });
  await assert.rejects(inspectGuidance(root), /existing local media only/);
});
test('opening preview is separate, bounded, zero-generation, and requires normal page approvals', async t => {
  const { root } = await selected(t, undefined, { name: 'A'.repeat(200) }), before = await fileHash(root, 'assets/intro.mp4');
  await assert.rejects(previewGuidance(root, 11), /zero and ten/);
  const preview = await previewGuidance(root, 2); assert.equal(preview.rendered, false); assert.equal(preview.approvals, 'not-granted');
  assert.equal(preview.next[0].project, await fs.realpath(path.join(root, preview.project)));
  const config = parse(await read(path.join(root, preview.project), 'tsugite.yaml'));
  assert.equal(config.length, 2); assert.equal(config.export, 'local'); assert.equal(config.execution, 'offline'); assert.equal(config.checks.auto_clips, false);
  assert.deepEqual(config.budget, {}); assert.equal(config.make, undefined); assert.equal(config.use[0].seconds, 2);
  assert.ok(config.name.length <= 200); await plan(path.join(root, preview.project));
  assert.equal(await fileHash(root, 'assets/intro.mp4'), before);
  await assert.rejects(reviewGuidance(root), /page-approved opening preview/);
  await write(root, '.tsugite/operation.lock', '{}'); await assert.rejects(previewGuidance(root), /Project busy/); await fs.unlink(path.join(root, '.tsugite/operation.lock'));
});
test('real exported preview QA remains pending without frame observations and never grants final approval', async t => {
  const { root, project } = await rendered(t), first = await reviewGuidance(root);
  assert.ok(Object.values(first.technical).every(Boolean)); assert.equal(first.output.metadata.width, 360); assert.equal(first.output.metadata.height, 640);
  assert.ok(Math.abs(first.output.metadata.seconds - 2) < 0.15); assert.equal(first.visual.status, 'pending'); assert.equal(first.readyForHumanFinalReview, false);
  const observations = { version: 1, outputSha256: first.output.sha256, frames: first.output.frames.map(f => ({ path: f.path, sha256: f.sha256, observation: 'Automated fixture attestation only; full human watch is still required.' })), audio: { status: 'not-listened', observation: 'Muted synthetic fixture, no audible content intended.' } };
  await write(root, 'assets/guide-review.json', { ...observations, outputSha256: '0'.repeat(64) }); await assert.rejects(reviewGuidance(root, 'assets/guide-review.json'), /stale/);
  // A failed observation attempt must not move the current-review pointer.
  await write(root, 'assets/guide-review.json', observations); const reviewed = await reviewGuidance(root, 'assets/guide-review.json');
  assert.equal(reviewed.readyForHumanFinalReview, true); assert.equal(reviewed.visual.status, 'reported-reviewed'); assert.equal(reviewed.finalApproval, 'not-granted');
  assert.deepEqual(reviewed.visual.observations.map(o => o.path), reviewed.output.frames.map(f => f.path));
  assert.deepEqual(reviewed.output.frames, first.output.frames);
  assert.notEqual((await status(project)).checks.final, 'approved');
  assert.deepEqual((await readJSON(project, '.tsugite/state.json')).ledger.entries, []);
  await fs.appendFile(path.join(project, 'out/final.mp4'), 'tampered'); await assert.rejects(reviewGuidance(root), /page-approved opening preview/);
});
test('added-music override removes only planned BGM and retains explicit source audio', async t => {
  const { root } = await fixture(t);
  await command('ffmpeg', ['-nostdin','-v','error','-f','lavfi','-i','sine=frequency=440:duration=3','-c:a','pcm_s16le',path.join(root,'assets/music.wav')]);
  await settings(root, { audio: [{ path: 'assets/music.wav', seconds: 3, kind: 'bgm' }] });
  const inspected = await inspectGuidance(root); assert.equal(inspected.audio.length, 1); assert.equal(inspected.audio[0].silent, false);
  await choice(root, inspected); await selectGuidance(root, 'assets/guide-choice.json');
  assert.deepEqual(parse(await read(root, 'tsugite.yaml')).audio, []);
});
test('CLI exposes guide preparation without approval flags or mock inspection shortcuts', async t => {
  const { root } = await fixture(t);
  const result = JSON.parse((await exec(process.execPath, [cli,'plugin','guide','inspect','--project',root])).stdout);
  assert.equal(result.ok, true); assert.equal(result.result.semanticReview, 'pending');
  await assert.rejects(exec(process.execPath, [cli,'plugin','guide','inspect','--mock','--project',root]), /Unsupported guide option/);
  await assert.rejects(exec(process.execPath, [cli,'plugin','guide','inspect','--approve','--project',root]), /Unknown option/);
  await assert.rejects(exec(process.execPath, [cli,'plugin','list','--seconds','1','--project',root]), /Guidance options require/);
});
test('guide refuses oversized sparse media before probing or hashing it', async t => {
  const { root } = await fixture(t);
  await fs.truncate(path.join(root, 'assets/intro.mp4'), 512 * 1024 * 1024 + 1);
  await assert.rejects(inspectGuidance(root), /limited to 512 MiB/);
});
test('QA with intended sound keeps listening pending and rejects altered audio evidence', async t => {
  const { root } = await fixture(t);
  await command('ffmpeg', ['-nostdin','-v','error','-f','lavfi','-i','sine=frequency=330:duration=3','-c:a','pcm_s16le',path.join(root,'assets/voice.wav')]);
  await settings(root, { audio: [{ path: 'assets/voice.wav', seconds: 3, kind: 'narration' }] });
  const inspected = await inspectGuidance(root); await choice(root, inspected); await selectGuidance(root, 'assets/guide-choice.json');
  const preview = await previewGuidance(root, 2), project = path.join(root, preview.project);
  await plan(project); const ui = await page(t, project); await ui.submit('approve', { stage: 'plan' }); await make(project); await ui.refresh(); await ui.submit('approve', { stage: 'clips' }); await exportVideo(project);
  const report = await reviewGuidance(root);
  const observed = { version: 1, outputSha256: report.output.sha256, frames: report.output.frames.map(f => ({ path: f.path, sha256: f.sha256, observation: 'Fixture-only frame attestation.' })), audio: { status: 'not-listened', observation: 'No actual listening was performed by this automated test.' } };
  await write(root, 'assets/quality.json', observed); const result = await reviewGuidance(root, 'assets/quality.json');
  assert.equal(result.technical.intendedSoundPresent, true); assert.equal(result.readyForHumanFinalReview, false);
  const current = await readJSON(root, '.tsugite/guidance/current-review.json'), evidence = await readJSON(root, current.report);
  await fs.appendFile(path.join(root, evidence.audio.path), 'changed');
  await write(root, 'assets/quality.json', { ...observed, frames: evidence.output.frames.map(f => ({ path: f.path, sha256: f.sha256, observation: 'Fixture-only frame attestation.' })) });
  await assert.rejects(reviewGuidance(root, 'assets/quality.json'), /Quality audio evidence changed/);
});
test('real silent PCM does not pass the intended narration check even with a finite volume floor', async t => {
  const { root } = await fixture(t);
  await command('ffmpeg', ['-nostdin','-v','error','-f','lavfi','-i','anullsrc=r=16000:cl=mono','-t','3','-c:a','pcm_s16le',path.join(root,'assets/silent-narration.wav')]);
  await settings(root, { audio: [{ path: 'assets/silent-narration.wav', seconds: 3, kind: 'narration' }] });
  const inspected = await inspectGuidance(root); assert.equal(inspected.audio[0].silent, true);
  await choice(root, inspected); await selectGuidance(root, 'assets/guide-choice.json');
  const preview = await previewGuidance(root, 2), project = path.join(root, preview.project);
  await plan(project); const ui = await page(t, project); await ui.submit('approve', { stage: 'plan' }); await make(project); await ui.refresh(); await ui.submit('approve', { stage: 'clips' }); await exportVideo(project);
  const report = await reviewGuidance(root);
  assert.equal(report.audio.silent, true); assert.equal(report.technical.intendedSoundPresent, false); assert.equal(report.readyForHumanFinalReview, false);
});
test('late narration in a ten-second opening is inspected beyond the first three seconds', async t => {
  const { root } = await fixture(t);
  await command('ffmpeg', ['-nostdin','-v','error','-f','lavfi','-i','sine=frequency=660:duration=1','-c:a','pcm_s16le',path.join(root,'assets/late.wav')]);
  await settings(root, { length: 10, audio: [{ path: 'assets/late.wav', kind: 'narration', start: 5, seconds: 1 }] });
  const inspected = await inspectGuidance(root); await choice(root, inspected); await selectGuidance(root, 'assets/guide-choice.json');
  const preview = await previewGuidance(root, 10), project = path.join(root, preview.project);
  await plan(project); const ui = await page(t, project); await ui.submit('approve', { stage: 'plan' }); await make(project); await ui.refresh(); await ui.submit('approve', { stage: 'clips' }); await exportVideo(project);
  const report = await reviewGuidance(root);
  assert.equal(report.technical.intendedSoundPresent, true); assert.equal(report.audio.silent, false);
  assert.equal(report.readyForHumanFinalReview, false); assert.equal(report.listening.status, 'not-listened');
});
test('missing planned soft subtitle track cannot pass output quality review', async t => {
  const { root, project } = await rendered(t, { intent: 'Keep verified subtitles.', overrides: { captions: 'keep', music: 'none' } }, { captions: [{ start: 0, end: 1.5, text: 'Verified caption' }] });
  const { digest } = await currentPlan(project), state = await readJSON(project, '.tsugite/state.json');
  await command('ffmpeg', ['-nostdin','-v','error','-i',path.join(project,'out/final.mp4'),'-map','0:v:0','-map','0:a:0','-c','copy','-sn',path.join(project,'out/missing-subs.mp4')]);
  // Owned fixture only: simulate a renderer that registers a bad subtitle-free
  // export as successful. The QA must inspect the actual media independently.
  const bytes = await fs.readFile(path.join(project, 'out/missing-subs.mp4'));
  await fs.writeFile(path.join(project, 'out/final.mp4'), bytes); await fs.writeFile(path.join(project, state.renders[digest].path), bytes);
  state.renders[digest].hash = await fileHash(project, 'out/final.mp4'); await write(project, '.tsugite/state.json', state);
  const first = await reviewGuidance(root); assert.equal(first.output.metadata.hasCaptions, false);
  await write(root, 'assets/missing-subs-review.json', { version: 1, outputSha256: first.output.sha256, frames: first.output.frames.map(f => ({ path: f.path, sha256: f.sha256, observation: 'Fixture frame report; soft subtitle visibility requires stream inspection.' })), audio: { status: 'not-listened', observation: 'Muted fixture.' } });
  const reviewed = await reviewGuidance(root, 'assets/missing-subs-review.json');
  assert.equal(reviewed.readyForHumanFinalReview, false); assert.equal(Object.values(reviewed.technical).every(Boolean), false);
});
test('looped ranges inspect real frames after wrapping to the beginning of the source', async t => {
  const { root } = await fixture(t);
  await command('ffmpeg', ['-nostdin','-v','error','-f','lavfi','-i','color=blue:s=64x64:r=10:d=5','-f','lavfi','-i','color=red:s=64x64:r=10:d=5','-filter_complex','[0:v][1:v]concat=n=2:v=1:a=0','-c:v','libx264','-pix_fmt','yuv420p','-threads','2',path.join(root,'assets/loop.mp4')]);
  await settings(root, { length: 6, format: '1:1', use: [{ path: 'assets/loop.mp4', start: 9, seconds: 6, loop: true }] });
  const report = await inspectGuidance(root), frames = report.sources[0].frames, colors = [];
  for (const frame of frames) {
    const { stdout } = await command('ffmpeg', ['-nostdin','-v','error','-i',path.join(root,frame.path),'-vf','scale=1:1','-frames:v','1','-f','rawvideo','-pix_fmt','rgb24','-'], { encoding: 'buffer' }); colors.push([...stdout]);
  }
  assert.ok(colors[0][0] > 200 && colors[0][2] < 20, 'first frame is in the red source tail');
  assert.ok(colors.slice(1).every(c => c[2] > 200 && c[0] < 20), 'later frames show the blue material after the loop');
});

test('looped clip and track audio evidence includes the wrap and exact-end offsets', async t => {
  const { root } = await fixture(t);
  await command('ffmpeg', ['-nostdin','-v','error','-f','lavfi','-i','color=blue:s=64x64:r=10:d=10','-f','lavfi','-i','sine=frequency=440:duration=10','-af',"volume=0:enable='gte(t,9)'",'-c:v','libx264','-c:a','pcm_s16le','-threads','2',path.join(root,'assets/loop-audio.mkv')]);
  await settings(root, { length: 2, use: [{ path: 'assets/loop-audio.mkv', start: 9.9, seconds: 2, loop: true, audio: true }], audio: [{ path: 'assets/loop-audio.mkv', offset: 10, seconds: 2, loop: true, kind: 'narration' }] });
  const report = await inspectGuidance(root); assert.equal(report.audio.length, 2);
  for (const audio of report.audio) {
    const { stdout } = await command('ffprobe', ['-v','error','-show_entries','format=duration','-of','default=nw=1:nk=1',path.join(root,audio.path)]);
    assert.ok(Math.abs(Number(stdout) - 2) < 0.04, 'sample includes the full selected two-second playback');
    assert.equal(audio.silent, false, 'wrapped sample contains tone from the source beginning');
  }
});
