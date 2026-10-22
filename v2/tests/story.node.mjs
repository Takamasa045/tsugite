import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { main } from '../src/cli.mjs';
import { plan, make } from '../src/core.mjs';
import { read, write } from '../src/files.mjs';
import { consult, loadStoryCatalog, validateStoryPlan, checkStoryFile, bindStory } from '../src/story.mjs';
import { parse } from 'yaml';
import { fixture, settings, page } from './helpers.mjs';

const samplePath = fileURLToPath(new URL('../packs/examples/story-plan-platform.json', import.meta.url));
const quietRequest = '60秒の静かな自然映像。ドラマ・CTA不要';
const banned = new Set(['three-act', 'generalized-beat-sheet', 'hero-journey', 'freytag-pyramid', 'seven-point-story', 'story-circle', 'five-act-tv', 'documentary-character-quest', 'hook-value-proof-cta', 'aida', 'problem-solution', 'pas', 'four-ps', 'before-after-bridge', 'golden-circle']);

test('quiet nature consult does not force character growth, an ad close, or directorial defaults', async () => {
  const result = await consult({ request: quietRequest, seconds: 60 });
  assert.equal(banned.has(result.recommendation.primary.id), false);
  assert.equal(result.recommendation.primary.id, 'jo-ha-kyu');
  assert.equal(result.draft.modules.character.status, 'not_applicable');
  assert.equal(result.draft.modules.plants.length, 0);
  assert.ok(result.recommendation.allocation.phases.every(phase => !/CTA|申込み/.test(phase.role)));
  for (const beat of result.draft.beats) {
    assert.equal(beat.visible_action.status, 'undecided');
    assert.equal(Object.hasOwn(beat.visible_action, 'text'), false);
    assert.deepEqual(beat.shot_refs, []);
  }
  const hook = result.direction.find(item => item.id === 'one-second-hook');
  const saturation = result.direction.find(item => item.id === 'saturation-rise');
  assert.equal(hook.status, 'exception');
  assert.ok(hook.applies_when.length && hook.exceptions.length);
  assert.equal(saturation.status, 'exception');
  const drama = result.recommendation.rejected.find(item => item.id === 'three-act');
  const cta = result.recommendation.rejected.find(item => item.id === 'hook-value-proof-cta');
  assert.match(drama.reason, /ドラマ/);
  assert.match(cta.reason, /CTA/);
  assert.notEqual(drama.reason, cta.reason);
  assert.equal(result.recommendation.score_meaning, 'ranking_weight');
  assert.equal(Object.hasOwn(result.recommendation, 'quality_probability'), false);
  assert.equal(result.questions.length <= 3, true);
});

test('story consult finishes with no media, API key, FFmpeg, approval, or generation', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tsugite-story-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const before = await fs.readdir(root);
  const result = await consult({ request: quietRequest, seconds: 60, root });
  assert.deepEqual(await fs.readdir(root), before);
  assert.deepEqual(result.inputs.consult.not_required, ['画像', 'APIキー', 'FFmpeg', '確認ページの承認', 'tsugite.yaml', '課金']);
  assert.equal(result.generated, false);
  assert.equal(result.approval, 'not-requested');
  assert.equal(result.external_send, false);
  assert.equal(result.inputs.produce.not_required_during_consult.includes('FFmpeg'), true);
  const source = await fs.readFile(fileURLToPath(new URL('../src/story.mjs', import.meta.url)), 'utf8');
  assert.doesNotMatch(source, /child_process|spawn\(|ffprobe|execFile/);
  const stdout = [];
  const writeOut = process.stdout.write.bind(process.stdout);
  process.stdout.write = chunk => { stdout.push(String(chunk)); return true; };
  t.after(() => { process.stdout.write = writeOut; });
  await main(['plugin', 'story', 'consult', '--request', quietRequest, '--seconds', '60', '--project', root]);
  const payload = JSON.parse(stdout.join(''));
  assert.equal(payload.ok, true);
  assert.equal(payload.result.generated, false);
  assert.equal(await fs.readdir(root).then(names => names.length), 0);
});

test('duration allocations for 20, 45, 72 and 180 seconds sum to the requested length', async () => {
  for (const seconds of [20, 45, 72, 180]) {
    const result = await consult({ request: `${seconds}秒の説明`, seconds });
    assert.equal(result.recommendation.allocation.sum_milliseconds, seconds * 1000);
    assert.equal(result.recommendation.allocation.phases.reduce((sum, phase) => sum + phase.milliseconds, 0), seconds * 1000);
  }
});

test('an unconfirmed song does not receive invented lyric times', async () => {
  const result = await consult({ request: '90秒のMV。曲はまだ聴いていない。歌詞の時刻は不明。', seconds: 90 });
  assert.equal(result.draft.music.status, 'unknown');
  assert.equal(result.draft.music.cues, undefined);
  assert.equal(JSON.stringify(result.draft.music).includes('"start"'), false);
  assert.ok(result.draft.beats.every(beat => beat.lyric_refs.length === 0));
  assert.equal(result.direction.find(item => item.id === 'cut-on-beat').status, 'exception');
  const invented = structuredClone(result.draft);
  invented.music = { status: 'unknown', cues: [{ id: 'c-chorus', text: 'サビ', start: 12, end: 20 }] };
  const catalog = await loadStoryCatalog();
  const issues = validateStoryPlan(invented, null, catalog);
  assert.ok(issues.some(issue => issue.code === 'fabricated_music_timing'));
  assert.equal(issues.some(issue => issue.code === 'quality_probability'), false);
});

test('an intentional mystery is not the same defect as a missed payoff', async () => {
  const catalog = await loadStoryCatalog();
  const sample = JSON.parse(await fs.readFile(samplePath, 'utf8'));
  assert.deepEqual(validateStoryPlan(sample, { seconds: 20, clipIds: ['input-0'], taskIds: [] }, catalog), []);
  const missed = structuredClone(sample);
  missed.modules.plants[1] = { id: 'p-letter', plant_beat: 'b-clock', payoff_beat: null, status: 'missed' };
  const missedIssues = validateStoryPlan(missed, { seconds: 20, clipIds: ['input-0'], taskIds: [] }, catalog);
  assert.ok(missedIssues.some(issue => issue.code === 'recovery_missed'));
  assert.equal(missedIssues.some(issue => issue.code === 'intentionally_unrecovered'), false);
  const kept = structuredClone(sample);
  assert.equal(validateStoryPlan(kept, { seconds: 20, clipIds: ['input-0'], taskIds: [] }, catalog).some(issue => issue.code === 'recovery_missed'), false);
  const broken = structuredClone(sample);
  broken.beats[0].shot_refs = ['scene-platform'];
  broken.beats[1].id = broken.beats[0].id;
  assert.ok(validateStoryPlan(broken, { seconds: 20, clipIds: ['input-0'], taskIds: [] }, catalog).some(issue => issue.code === 'shot_ref_missing' || issue.code === 'duplicate_id'));
  const placed = structuredClone(sample);
  placed.beats[0].scene_id = 'station';
  assert.ok(validateStoryPlan(placed, null, catalog).some(issue => issue.code === 'beat_field'));
});

test('catalog counts and missing citations come from the data', async () => {
  const catalog = await loadStoryCatalog();
  const result = await consult({ request: quietRequest, seconds: 60 });
  assert.equal(catalog.frameworks.length, 34);
  assert.equal(catalog.principles.length, 36);
  assert.equal(result.catalog.framework_count, 34);
  assert.equal(result.catalog.principle_count, 36);
  assert.equal(result.catalog.frameworks_without_source, 26);
  assert.equal(result.catalog.principles_without_source, 19);
});

test('a project without a story plan keeps the previous plan path', async t => {
  const { root } = await fixture(t);
  const first = await plan(root);
  assert.equal(first.plan.story, null);
  assert.deepEqual(first.storyReconfirm, []);
  const ui = await page(t, root);
  assert.match(ui.html, /No story plan is bound/);
  assert.equal((await ui.submit('approve', { stage: 'plan' })).status, 303);
  const made = await make(root);
  assert.equal(made.made, 0);
});

test('changing the ending rechecks related plants and shots and blocks the old approval', async t => {
  const { root } = await fixture(t);
  const sample = await fs.readFile(samplePath, 'utf8');
  await write(root, 'story/plan.json', sample);
  await settings(root, { length: '20s', lang: 'ja' });
  const bound = await bindStory(root, 'story/plan.json');
  assert.equal(bound.generated, false);
  assert.equal(bound.approval, 'not-requested');
  assert.equal(parse(await read(root, 'tsugite.yaml')).story, 'story/plan.json');
  assert.equal(await fs.access(path.join(root, '.tsugite/approvals/plan.json')).then(() => true, () => false), false);
  const first = await plan(root);
  assert.equal(first.plan.story.form.id, 'three-act');
  assert.deepEqual(first.storyReconfirm, []);
  const ui = await page(t, root);
  assert.match(ui.html, /構成の狙い/);
  assert.match(ui.html, /b-clock/);
  assert.match(ui.html, /input-0/);
  assert.equal((await ui.submit('approve', { stage: 'plan' })).status, 303);
  const edited = JSON.parse(sample);
  edited.ending_intention = { status: 'known', text: '振り返らず去る', source: 'author' };
  await write(root, 'story/plan.json', edited);
  await assert.rejects(make(root), /no longer matches/);
  const second = await plan(root);
  assert.ok(second.storyReconfirm.some(item => item.reason === 'ending_changed' && item.beat === 'b-clock' && item.shot_refs.includes('input-0')));
  assert.ok(second.storyReconfirm.some(item => item.reason === 'ending_changed' && item.beat === 'b-stay' && item.shot_refs.includes('input-0')));
  assert.equal(second.plan.tasks.length, first.plan.tasks.length);
  await assert.rejects(make(root), /Waiting for plan/);
  const media = path.join(root, '.tsugite', 'media');
  assert.equal(await fs.access(media).then(() => true, () => false), false);
  const reviewed = await page(t, root);
  assert.match(reviewed.html, /構成変更後の再確認/);
  assert.match(reviewed.html, /ending_changed/);
  assert.match(reviewed.html, /自動では作り直しません/);
});

test('a decided framework is kept even when a keyword would rank something else', async () => {
  const adopted = await consult({ request: 'three-act を採用した構成', seconds: 20, entry: 'decided' });
  assert.equal(adopted.recommendation.primary.id, 'three-act');
  assert.equal(adopted.draft.form.id, 'three-act');
  const byName = await consult({ request: '三幕構成を映像にする', seconds: 20, entry: 'decided' });
  assert.equal(byName.draft.form.id, 'three-act');
  const refused = await consult({ request: 'three-act を採用した構成。ドラマにはしない', seconds: 20, entry: 'decided' });
  assert.notEqual(refused.draft.form.id, 'three-act');
});

test('generated video task ids are valid shot refs and audio tasks are not shots', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tsugite-story-shots-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const sample = JSON.parse(await fs.readFile(samplePath, 'utf8'));
  for (const beat of sample.beats) beat.shot_refs = ['shot-one'];
  sample.beats[0].generation_refs = ['shot-one', 'bed'];
  await fs.writeFile(path.join(root, 'tsugite.yaml'), 'length: 20s\nuse: []\nmake:\n  - id: shot-one\n    kind: video\n  - id: bed\n    kind: audio\n');
  await fs.writeFile(path.join(root, 'plan.json'), JSON.stringify(sample));
  const checked = await checkStoryFile(root, 'plan.json');
  assert.equal(checked.mechanical.ok, true);
  const audioShot = structuredClone(sample);
  audioShot.beats[0].shot_refs = ['bed'];
  await fs.writeFile(path.join(root, 'plan.json'), JSON.stringify(audioShot));
  const rejected = await checkStoryFile(root, 'plan.json');
  assert.equal(rejected.mechanical.ok, false);
  assert.ok(rejected.mechanical.issues.some(issue => issue.code === 'shot_ref_missing' && issue.id === 'bed'));
});

test('the worked example and request guide stay machine-checkable', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tsugite-story-example-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'story-plan-platform.json'), await fs.readFile(samplePath));
  const checked = await checkStoryFile(root, 'story-plan-platform.json');
  assert.equal(checked.mechanical.ok, true);
  assert.equal(checked.meaning_review, 'not_automated');
  assert.equal(checked.generated, false);
  const doc = await fs.readFile(fileURLToPath(new URL('../docs/story-consult.ja.md', import.meta.url)), 'utf8');
  for (const marker of ['初稿', '診断', '改稿', 'ショット対応', 'intentionally', '60秒の静かな自然映像', '曲はまだ聴いていない', '民話', '採用した構成メモ']) assert.match(doc, new RegExp(marker));
});
