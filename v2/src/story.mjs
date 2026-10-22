import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { parse, stringify } from 'yaml';
import { fail, hash, json, locked, read, write } from './files.mjs';

// Reads the catalog shipped in this package. It does not import v1 code,
// search parent directories, call FFmpeg, send requests, or approve a check.
const DRAMA = new Set(['three-act', 'generalized-beat-sheet', 'hero-journey', 'freytag-pyramid', 'seven-point-story', 'story-circle', 'five-act-tv', 'documentary-character-quest']);
const CTA = new Set(['hook-value-proof-cta', 'aida', 'problem-solution', 'pas', 'four-ps', 'before-after-bridge', 'golden-circle']);
const DISCLOSURE = new Set(['mystery-question-clue-answer', 'tension-escalation-reveal', 'open-loop-reveal']);
const STATUSES = new Set(['known', 'undecided', 'unknown', 'not_applicable']);
const SOURCES = new Set(['author', 'request', 'framework-flow']);
const ID = /^[a-z][a-z0-9-]{0,40}$/;
const ENTRIES = new Set(['idea', 'script', 'material', 'decided']);
const negation = () => /([^。！？\n]{0,32}?)(にはしない|はしない|しない|不要|いらない|使わない|無し|なし)/g;
const ADVICE = [
  { id: 'one-second-hook', advice: '冒頭1秒以内に主役の姿か音を出す', applies_when: ['縦型の広告', '強いフックが目的の短尺', 'ループ再生'], exceptions: ['静かな観察', '余韻から入る作品', '続きもので文脈が既にあるとき'] },
  { id: 'alternate-shot-size', advice: '隣接ショットで寄りと引きを交互にする', applies_when: ['対話', 'パフォーマンス', '説明の手順'], exceptions: ['同じ場所を長く見る観察', 'ワンシーンの固定カメラ'] },
  { id: 'saturation-rise', advice: '山場で彩度とコントラストを一段上げる', applies_when: ['広告の締め', '感情の山場を強調する物語'], exceptions: ['静かな観察', '色を動かさない記録', 'すでに彩度が設計されている素材'] },
  { id: 'motif-three', advice: '色・ポーズ・小物・台詞の反復は3回までにし、3回目で変化させる', applies_when: ['モチーフを繰り返すMV', '三段のコメディ'], exceptions: ['反復モチーフがない', '一回きりの観察'] },
  { id: 'cut-on-beat', advice: 'カットを、確認できた楽曲の拍か台詞の句点に合わせる', applies_when: ['拍が確認できた楽曲', '台詞の区切り'], exceptions: ['曲が未確認', '環境音だけの映像', '台詞がない'] }
];

let catalogCache;
export async function loadStoryCatalog() {
  if (catalogCache && !process.env.TSUGITE_STORY_CATALOG) return catalogCache;
  const file = await catalogPath();
  const parsed = parse(await fs.readFile(file, 'utf8'), { maxAliasCount: 0 });
  if (!parsed || parsed.kind !== 'story-framework-guide' || !Array.isArray(parsed.frameworks) || !Array.isArray(parsed.principles) || !Array.isArray(parsed.duration_presets)) fail('Story catalog is not readable');
  const ids = [];
  for (const item of [...parsed.frameworks, ...parsed.principles]) {
    if (!item || typeof item.id !== 'string') fail('Story catalog item is missing an id');
    item.source_ids ??= [];
    ids.push(item.id);
  }
  if (new Set(ids).size !== ids.length) fail('Story catalog ids are not unique');
  if (!process.env.TSUGITE_STORY_CATALOG) catalogCache = parsed;
  return parsed;
}

function bundledStoryCatalogPath() {
  return fileURLToPath(new URL('../knowledge/story-frameworks/catalog.yaml', import.meta.url));
}

async function catalogPath() {
  if (process.env.TSUGITE_STORY_CATALOG) return process.env.TSUGITE_STORY_CATALOG;
  const bundled = bundledStoryCatalogPath();
  try {
    await fs.access(bundled);
    return bundled;
  } catch {
    fail('Story catalog was not found. Expected knowledge/story-frameworks/catalog.yaml in this package');
  }
}

function exclusionTopics(request) {
  const topics = new Set();
  for (const match of request.normalize('NFKC').matchAll(negation())) {
    const window = match[1];
    if (/ドラマ|成長物語|人物の成長|主人公の成長/.test(window)) topics.add('drama');
    if (/cta|行動喚起|広告締め|申込み|申し込み/i.test(window)) topics.add('cta');
  }
  return topics;
}

function positiveText(request) {
  const stripped = request.normalize('NFKC').replace(negation(), ' ');
  let extra = '';
  if (/静か/.test(stripped)) extra += ' 静けさ 余白 余韻';
  if (/自然|風景|観察/.test(stripped)) extra += ' イメージ 詩的 世界観';
  if (/説明|解説/.test(stripped)) extra += ' 解説 ポイント 手順';
  if (/民話|昔話/.test(stripped)) extra += ' 余韻 世界観 起承転結';
  return (stripped + extra).toLowerCase();
}

function excludedReason(framework, topics) {
  if (topics.has('drama') && DRAMA.has(framework.id)) return `依頼はドラマにしないと指定している。${framework.name}（${framework.family}）は人物の変化を主軸にするため不採用。`;
  if (topics.has('cta') && CTA.has(framework.id)) return `依頼はCTAを不要としている。${framework.name}は「${framework.flow.at(-1)}」で行動喚起に着地するため不採用。`;
  return null;
}

function phaseWeight(range) {
  const percent = String(range).match(/(\d+(?:\.\d+)?)\s*%/);
  if (percent) return Number(percent[1]);
  const span = String(range).match(/(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)/);
  if (span) return Math.max(0.001, Number(span[2]) - Number(span[1]));
  return 1;
}

export function allocateDuration(seconds, phases, topics = new Set()) {
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 3600) fail('duration must be a positive number');
  const totalMs = Math.round(seconds * 1000);
  const weights = phases.map(phase => phaseWeight(phase.range));
  const weightSum = weights.reduce((sum, weight) => sum + weight, 0);
  const raw = weights.map(weight => totalMs * weight / weightSum);
  const floors = raw.map(value => Math.floor(value));
  let remain = totalMs - floors.reduce((sum, value) => sum + value, 0);
  const order = raw.map((value, index) => ({ index, frac: value - floors[index] })).sort((a, b) => b.frac - a.frac || a.index - b.index);
  for (let n = 0; n < remain; n++) floors[order[n % order.length].index] += 1;
  let cursor = 0;
  const allocated = phases.map((phase, index) => {
    const milliseconds = floors[index];
    const startMs = cursor;
    cursor += milliseconds;
    return { role: displayRole(phase.role, topics), start_ms: startMs, end_ms: cursor, milliseconds, start: startMs / 1000, end: cursor / 1000, seconds: milliseconds / 1000 };
  });
  if (cursor !== totalMs) fail('duration allocation does not match the requested length');
  return { seconds, sum_milliseconds: cursor, sum: cursor / 1000, phases: allocated };
}

function displayRole(role, topics) {
  let text = String(role);
  if (topics.has('cta')) {
    text = text.replace(/CTA/gi, '').replace(/・{2,}/g, '・').replace(/^・|・$/g, '').trim();
    if (!text || /行動|申込|購入/.test(text)) text = '余韻';
  }
  if (topics.has('drama')) text = text.replaceAll('山場', '見どころ');
  return text || '余韻';
}

function presetFor(catalog, seconds) {
  const presets = catalog.duration_presets;
  return presets.find(preset => preset.id !== 'long-form' && seconds <= preset.max_seconds) ?? presets.find(preset => preset.id === 'long-form') ?? presets.at(-1);
}

function inferEntry(request, entry) {
  if (entry) {
    if (!ENTRIES.has(entry)) fail('Story entry must be idea, script, material, or decided');
    return entry;
  }
  if (/台本|脚本|セリフを直|台詞を直/.test(request)) return 'script';
  if (/歌詞|サビ|楽曲|曲|mv|素材/i.test(request)) return 'material';
  if (/採用|決めた構成|構成を映像/.test(request)) return 'decided';
  return 'idea';
}

function recommend(catalog, request, seconds, entry, topics) {
  const positive = positiveText(request);
  const ranked = catalog.frameworks.map((framework, order) => {
    const matched = framework.keywords.filter(keyword => positive.includes(String(keyword).toLowerCase()));
    const term = seconds == null ? 0 : seconds <= 45 ? framework.short_form_score : framework.long_form_score;
    const reason = excludedReason(framework, topics);
    const reasons = [];
    if (matched.length) reasons.push(`依頼の「${matched.slice(0, 3).join('・')}」が${framework.name}（${framework.family}）の適性と一致`);
    if (seconds != null) reasons.push(`${seconds}秒では${framework.family}の${seconds <= 45 ? '短尺' : '長尺'}の並び重みは ${term}`);
    if (!reasons.length) reasons.push(`${framework.name}は依頼の語句と一致しない。流れは${framework.flow.join('→')}、注意は「${framework.caution}」`);
    return { framework, order, matched, ranking_weight: reason ? -1000 : matched.length * 4 + term, reasons, excluded: Boolean(reason), reason };
  }).sort((a, b) => b.ranking_weight - a.ranking_weight || a.order - b.order);
  const available = ranked.filter(item => !item.excluded);
  const matchedPool = available.filter(item => item.matched.length);
  const neutral = new Set(['prep', 'tutorial', 'kishotenketsu', 'jo-ha-kyu', 'inverted-pyramid', 'montage-association']);
  let pool = matchedPool.length ? matchedPool : available.filter(item => neutral.has(item.framework.id));
  if (!pool.length) pool = available;
  if (entry === 'decided') {
    const named = available
      .map(item => ({ item, specificity: frameworkMention(request, item.framework) }))
      .filter(candidate => candidate.specificity > 0)
      .sort((a, b) => b.specificity - a.specificity || b.item.ranking_weight - a.item.ranking_weight || a.item.order - b.item.order)[0]?.item;
    if (named) pool = [named, ...pool.filter(item => item !== named)];
  }
  const chosen = pool[0] ?? ranked[0];
  const secondary = pool.filter(item => item !== chosen && item.ranking_weight > 0).slice(0, 2);
  const rejected = [
    ...ranked.filter(item => item.excluded).map(item => ({ id: item.framework.id, name: item.framework.name, reason: item.reason })),
    ...ranked.filter(item => !item.excluded && item !== chosen && !secondary.includes(item)).slice(-3).map(item => ({ id: item.framework.id, name: item.framework.name, reason: `${item.framework.name}（${item.framework.family}）は、依頼にある目的より「${item.framework.keywords.slice(0, 3).join('・')}」への寄りが弱い。${item.framework.caution}` }))
  ];
  const present = frameworkView(chosen);
  return {
    score_meaning: 'ranking_weight',
    score_note: 'ranking_weight は候補を並べる重みです。出来の確率でも、採用の自動決定でもありません。',
    primary: present,
    secondary: secondary.map(frameworkView),
    rejected,
    principles: principlesFor(catalog, present.id)
  };
}

function frameworkMention(request, framework) {
  const escaped = framework.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const idHit = new RegExp(`(?:^|[^a-z0-9-])${escaped}(?=$|[^a-z0-9-])`, 'i').test(request);
  const nameHit = Boolean(framework.name) && request.includes(framework.name);
  if (!idHit && !nameHit) return 0;
  return Math.max(idHit ? framework.id.length : 0, nameHit ? framework.name.length : 0);
}

function frameworkView(item) {
  const framework = item.framework;
  return { id: framework.id, name: framework.name, family: framework.family, flow: framework.flow, caution: framework.caution, reasons: item.reasons, ranking_weight: item.ranking_weight };
}

function principlesFor(catalog, primaryId) {
  const wanted = new Set(['one-shot-one-role', 'start-end-state', 'motivated-cut', 'visual-hierarchy']);
  if (DRAMA.has(primaryId)) ['setup-payoff', 'escalation'].forEach(id => wanted.add(id));
  if (DISCLOSURE.has(primaryId)) ['setup-payoff', 'hold-before-after'].forEach(id => wanted.add(id));
  if (primaryId.startsWith('music-')) ['color-motif', 'sonic-motif', 'pace-contrast'].forEach(id => wanted.add(id));
  if (primaryId === 'montage-association' || primaryId === 'jo-ha-kyu' || primaryId === 'kishotenketsu') ['pace-contrast', 'hold-before-after'].forEach(id => wanted.add(id));
  return catalog.principles.filter(principle => wanted.has(principle.id)).map(principle => ({ id: principle.id, instruction: principle.instruction, rationale: principle.rationale, source_ids: principle.source_ids }));
}

function directionFor(request, topics) {
  const quiet = /静か|観察|余白|自然映像|風景/.test(request);
  const music = /曲|歌詞|mv|サビ|楽曲/i.test(request);
  const flags = {
    quiet,
    music,
    musicUnknown: music && /まだ|未|不明|聴いていない|聞いていない/.test(request),
    dialogue: /台詞|セリフ|会話|対談/.test(request),
    ad: !topics.has('cta') && /広告|申込み|申し込み|cta/i.test(request),
    drama: !topics.has('drama') && /物語|主人公|ドラマ/.test(positiveText(request))
  };
  return ADVICE.map(item => ({ ...item, status: adviceStatus(item.id, flags) }));
}

function adviceStatus(id, flags) {
  if (id === 'one-second-hook') return flags.quiet ? 'exception' : flags.ad ? 'advised' : 'not_applicable';
  if (id === 'saturation-rise') return flags.quiet ? 'exception' : flags.ad || flags.drama ? 'advised' : 'not_applicable';
  if (id === 'alternate-shot-size') return flags.quiet ? 'exception' : flags.dialogue || flags.music ? 'advised' : 'not_applicable';
  if (id === 'motif-three') return flags.quiet && !flags.music ? 'not_applicable' : flags.music ? 'advised' : 'not_applicable';
  if (id === 'cut-on-beat') return flags.musicUnknown || (flags.music && !flags.dialogue) ? 'exception' : !flags.music && !flags.dialogue ? 'not_applicable' : 'advised';
  return 'not_applicable';
}

function constraintsFrom(request) {
  return [...new Set([...request.normalize('NFKC').matchAll(negation())].map(match => (match[1] + match[2]).trim()).filter(Boolean))].slice(0, 8);
}

function draftPlan(catalog, request, seconds, entry, topics, recommendation, allocation) {
  const sentence = request.split(/[。．\n]/)[0].slice(0, 160);
  const musicMentioned = /曲|歌詞|mv|サビ|楽曲/i.test(request);
  const dramaForm = DRAMA.has(recommendation.primary.id) && !topics.has('drama');
  const beats = recommendation.primary.flow.map((step, index) => ({
    id: `b${index + 1}`,
    purpose: { status: 'known', text: step, source: 'framework-flow' },
    before: { status: 'undecided' },
    visible_action: { status: 'undecided' },
    after: { status: 'undecided' },
    caused_by: { status: 'undecided' },
    shot_refs: [],
    lyric_refs: [],
    generation_refs: []
  }));
  const open = [];
  if (seconds == null) open.push('長さは未定');
  const protectedElements = constraintsFrom(request);
  if (!protectedElements.length) open.push('残したいものは未定');
  if (musicMentioned) open.push('曲の拍と歌詞時刻は未確認。確認できるまで入れない');
  const plan = {
    version: 1,
    catalog_revision: catalog.revision,
    form: { id: recommendation.primary.id, scope: sentence },
    audience_experience: { status: 'known', text: sentence, source: 'request' },
    protected_elements: protectedElements,
    ending_intention: { status: 'undecided' },
    selected_frameworks: [recommendation.primary, ...recommendation.secondary].map(item => ({ id: item.id, reason: item.reasons.join('。') })),
    beats,
    open_questions: open.slice(0, 8),
    modules: {
      character: dramaForm ? { status: 'undecided' } : { status: 'not_applicable' },
      disclosure: DISCLOSURE.has(recommendation.primary.id) ? { status: 'undecided' } : { status: 'not_applicable' },
      plants: []
    },
    music: { status: musicMentioned ? 'unknown' : 'not_applicable' }
  };
  if (allocation) plan.allocation = allocation;
  plan.entry = entry;
  return plan;
}

function questionsFor(request, seconds, protectedElements) {
  const questions = [];
  if (!request.trim()) questions.push('何を残したいか');
  if (seconds == null && !/\d+\s*(秒|分)/.test(request)) questions.push('長さは何秒ですか');
  if (!protectedElements.length) questions.push('残したいものは何ですか');
  return questions.slice(0, 3);
}

export async function consult(options = {}) {
  const request = typeof options.request === 'string' ? options.request.trim() : '';
  if (!request) fail('Story consult needs a request');
  if (request.length > 10000) fail('Story request is too long');
  const seconds = options.seconds == null ? undefined : Number(options.seconds);
  if (options.seconds != null && (!Number.isFinite(seconds) || seconds <= 0 || seconds > 3600)) fail('duration must be a positive number');
  const catalog = await loadStoryCatalog();
  const entry = inferEntry(request, options.entry);
  const topics = exclusionTopics(request);
  const recommendation = recommend(catalog, request, seconds, entry, topics);
  const allocation = seconds == null ? null : allocateDuration(seconds, presetFor(catalog, seconds).phases, topics);
  const draft = draftPlan(catalog, request, seconds, entry, topics, recommendation, allocation);
  const issues = validateStoryPlan(draft, null, catalog);
  if (issues.length) fail('Story draft failed its own check: ' + issues[0].message);
  const result = {
    scope: 'story-consult',
    generated: false,
    approval: 'not-requested',
    external_send: false,
    entry,
    catalog: provenance(catalog),
    inputs: inputSplit(entry),
    questions: questionsFor(request, seconds, draft.protected_elements),
    recommendation: allocation ? { ...recommendation, allocation } : recommendation,
    direction: directionFor(request, topics),
    draft,
    meaning_review: 'not_automated',
    wrote: null
  };
  if (options.output) {
    if (!options.root) fail('Story consult --output needs a directory');
    if (typeof options.output !== 'string' || !options.output.endsWith('.json') || options.output.startsWith('.tsugite/')) fail('Story draft must be a project JSON file');
    await write(options.root, options.output, draft);
    result.wrote = options.output;
  }
  return result;
}

function provenance(catalog) {
  return {
    revision: catalog.revision,
    catalog_id: catalog.catalog_id,
    framework_count: catalog.frameworks.length,
    principle_count: catalog.principles.length,
    frameworks_without_source: catalog.frameworks.filter(item => !item.source_ids.length).length,
    principles_without_source: catalog.principles.filter(item => !item.source_ids.length).length,
    note: 'source_ids が空の項目は、カタログに出典が記録されていません。空欄を出典ありとは扱いません。'
  };
}

function inputSplit(entry) {
  const later = {
    idea: ['形式', '採用した構成', '映像または生成タスク', '確認ページでの承認'],
    script: ['直した台本', '採用した構成', '対応するショット', '確認ページでの承認'],
    material: ['確認できた曲・歌詞・素材', '採用した構成', '映像または生成タスク', '確認ページでの承認'],
    decided: ['採用した構成メモ', '映像または生成タスク', '尺と形式', '確認ページでの承認']
  };
  return {
    consult: {
      ask: ['何を残したいか', '長さ', '残したいもの'],
      not_required: ['画像', 'APIキー', 'FFmpeg', '確認ページの承認', 'tsugite.yaml', '課金']
    },
    produce: { needed_later: later[entry], not_required_during_consult: ['画像', 'APIキー', 'FFmpeg', '課金', 'Gate承認'] }
  };
}

function issue(issues, code, message, id) {
  issues.push({ code, message, ...(id ? { id } : {}) });
}

function slot(value, label, issues) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return issue(issues, 'slot', `${label} は未定・不明・適用外・本文のいずれかで書きます`);
  if (!STATUSES.has(value.status)) issue(issues, 'slot_status', `${label} の状態が不正です`);
  const extra = Object.keys(value).filter(key => !['status', 'text', 'source'].includes(key));
  if (extra.length) issue(issues, 'slot_field', `${label} に使えない項目があります`);
  if (value.status === 'known') {
    if (typeof value.text !== 'string' || !value.text.trim()) issue(issues, 'known_empty', `${label} は本文が空です`);
    if (value.source !== undefined && !SOURCES.has(value.source)) issue(issues, 'slot_source', `${label} の出所が不正です`);
  } else if ('text' in value || 'source' in value) issue(issues, 'filled_blank', `${label} は${value.status}なので本文を入れません`);
}

export function validateStoryPlan(plan, context, catalog) {
  const issues = [];
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) return [{ code: 'plan', message: '構成メモがJSONオブジェクトではありません' }];
  for (const key of ['score', 'quality', 'probability', 'quality_probability']) if (key in plan) issue(issues, 'meaning_score_forbidden', '意味の採点は構成メモに入れません');
  const allowed = ['version', 'catalog_revision', 'form', 'audience_experience', 'protected_elements', 'ending_intention', 'selected_frameworks', 'beats', 'open_questions', 'modules', 'music', 'allocation', 'entry'];
  for (const key of Object.keys(plan)) if (!allowed.includes(key)) issue(issues, 'field', `使えない項目です: ${key}`);
  if (plan.version !== 1) issue(issues, 'version', '構成メモの version は 1 です');
  if (!catalog || plan.catalog_revision !== catalog.revision) issue(issues, 'catalog_revision', 'カタログの revision が一致しません');
  const frameworkIds = new Set(catalog?.frameworks.map(item => item.id) ?? []);
  if (!plan.form || typeof plan.form !== 'object' || typeof plan.form.scope !== 'string' || !plan.form.scope.trim()) issue(issues, 'form', '形式と今回の範囲がありません');
  else if (plan.form.id !== 'custom' && !frameworkIds.has(plan.form.id)) issue(issues, 'form', '形式の id がカタログにありません');
  slot(plan.audience_experience, 'audience_experience', issues);
  slot(plan.ending_intention, 'ending_intention', issues);
  if (!Array.isArray(plan.protected_elements) || plan.protected_elements.some(item => typeof item !== 'string' || !item.trim())) issue(issues, 'protected_elements', '残す要素は空でない文字列の配列です');
  if (!Array.isArray(plan.open_questions) || plan.open_questions.some(item => typeof item !== 'string')) issue(issues, 'open_questions', '未決事項は文字列の配列です');
  if (!Array.isArray(plan.selected_frameworks) || !plan.selected_frameworks.length) issue(issues, 'selected_frameworks', '採用した構成と理由がありません');
  else for (const item of plan.selected_frameworks) {
    if (!item || !frameworkIds.has(item.id) || typeof item.reason !== 'string' || !item.reason.trim()) issue(issues, 'selected_frameworks', '採用理由は構成ごとの具体的な文です', item?.id);
  }
  if (!Array.isArray(plan.beats) || !plan.beats.length) issue(issues, 'beats', '意味のビートがありません');
  const beatIds = new Set();
  const spans = [];
  for (const beat of plan.beats ?? []) {
    if (!beat || typeof beat !== 'object') { issue(issues, 'beat', 'ビートが不正です'); continue; }
    for (const key of ['scene', 'scene_id', 'location', 'place', 'musical_beat', 'bar']) if (key in beat) issue(issues, 'beat_field', '意味ビートに場所や拍の欄は使えません', beat.id);
    if (!ID.test(beat.id ?? '') || beatIds.has(beat.id)) issue(issues, 'duplicate_id', 'ビート id が空か重複しています', beat.id);
    beatIds.add(beat.id);
    for (const key of ['purpose', 'before', 'visible_action', 'after', 'caused_by']) slot(beat[key], `${beat.id}.${key}`, issues);
    for (const key of ['shot_refs', 'lyric_refs', 'generation_refs']) {
      if (beat[key] === undefined) continue;
      if (!Array.isArray(beat[key]) || beat[key].some(id => typeof id !== 'string' || !ID.test(id))) issue(issues, 'ref', `${key} は id の配列です`, beat.id);
    }
    if (beat.span !== undefined) {
      const start = Number(beat.span?.start), end = Number(beat.span?.end);
      if (!beat.span || Object.keys(beat.span).some(key => !['start', 'end'].includes(key)) || !Number.isFinite(start) || !Number.isFinite(end) || end <= start) issue(issues, 'span', 'ビート区間が不正です', beat.id);
      else spans.push({ id: beat.id, startMs: Math.round(start * 1000), endMs: Math.round(end * 1000) });
    }
  }
  for (const beat of plan.beats ?? []) {
    const cause = beat?.caused_by;
    if (cause?.status === 'known' && ID.test(cause.text ?? '') && !beatIds.has(cause.text)) issue(issues, 'cause_missing', 'caused_by の参照先がありません', beat.id);
  }
  spans.sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
  for (let i = 1; i < spans.length; i++) if (spans[i].startMs < spans[i - 1].endMs) issue(issues, 'span_overlap', 'ビート区間が重なっています', spans[i].id);
  const lengthMs = context?.seconds == null ? (plan.allocation ? Math.round(plan.allocation.seconds * 1000) : null) : Math.round(context.seconds * 1000);
  if (lengthMs != null) for (const span of spans) if (span.startMs < 0 || span.endMs > lengthMs) issue(issues, 'span_outside', 'ビート区間が尺の外です', span.id);
  checkRefs(plan, context, issues);
  checkModules(plan, beatIds, issues);
  checkMusic(plan, issues);
  checkAllocation(plan, context, issues);
  return issues;
}

function checkRefs(plan, context, issues) {
  if (!context) return;
  const clips = new Set(context.clipIds ?? []);
  const tasks = new Set(context.taskIds ?? []);
  for (const beat of plan.beats ?? []) {
    for (const id of beat.shot_refs ?? []) if (!clips.has(id)) issue(issues, 'shot_ref_missing', 'shot_refs はタイムラインのクリップ id です。場所や拍ではありません', id);
    for (const id of beat.generation_refs ?? []) if (!tasks.has(id)) issue(issues, 'generation_ref_missing', 'generation_refs は生成タスクの id です', id);
  }
}

function checkModules(plan, beatIds, issues) {
  if (plan.modules === undefined) return;
  if (!plan.modules || typeof plan.modules !== 'object') return issue(issues, 'modules', '任意モジュールが不正です');
  for (const key of Object.keys(plan.modules)) if (!['character', 'disclosure', 'plants'].includes(key)) issue(issues, 'modules', `未知のモジュールです: ${key}`);
  const character = plan.modules.character;
  if (character) {
    if (!['not_applicable', 'undecided', 'used'].includes(character.status)) issue(issues, 'character', '人物モジュールの状態が不正です');
    const fields = ['choice', 'obstacle', 'cost', 'result'];
    if (character.status === 'used') for (const field of fields) slot(character[field], `character.${field}`, issues);
    else if (fields.some(field => field in character)) issue(issues, 'filled_blank', '使わない人物モジュールに選択や結果を入れません');
  }
  const disclosure = plan.modules.disclosure;
  if (disclosure) {
    if (!['not_applicable', 'undecided', 'used'].includes(disclosure.status)) issue(issues, 'disclosure', '情報開示モジュールの状態が不正です');
    if (disclosure.status === 'used') {
      if (!Array.isArray(disclosure.items) || !disclosure.items.length) issue(issues, 'disclosure', '情報開示の対応がありません');
      for (const item of disclosure.items ?? []) {
        if (!item || !ID.test(item.id ?? '') || typeof item.who !== 'string' || typeof item.fact !== 'string' || !beatIds.has(item.when_beat)) issue(issues, 'disclosure', '情報開示の id・誰が・いつ・何が不足しています', item?.id);
      }
    } else if ('items' in disclosure) issue(issues, 'filled_blank', '使わない情報開示に項目を入れません');
  }
  if (plan.modules.plants === undefined) return;
  if (!Array.isArray(plan.modules.plants)) return issue(issues, 'plants', '仕込みは配列です');
  const plantIds = new Set();
  for (const plant of plan.modules.plants) {
    if (!plant || !ID.test(plant.id ?? '') || plantIds.has(plant.id)) issue(issues, 'duplicate_id', '仕込み id が空か重複しています', plant?.id);
    plantIds.add(plant.id);
    if (!beatIds.has(plant.plant_beat)) issue(issues, 'plant_beat_missing', '仕込みビートがありません', plant.id);
    if (plant.status === 'recovered') {
      if (!plant.payoff_beat || !beatIds.has(plant.payoff_beat) || plant.payoff_beat === plant.plant_beat) issue(issues, 'payoff_link_broken', '回収先のビートがつながっていません', plant.id);
    } else if (plant.status === 'intentionally_unrecovered') {
      if (plant.payoff_beat) issue(issues, 'intentional_has_payoff', '意図的に残す謎に回収先は入れません', plant.id);
      if (typeof plant.reason !== 'string' || !plant.reason.trim()) issue(issues, 'intentional_reason_missing', '意図的に残す謎には作者の理由が必要です', plant.id);
    } else if (plant.status === 'missed') issue(issues, 'recovery_missed', '回収漏れです。意図して残す場合は intentionally_unrecovered と理由を書きます', plant.id);
    else if (plant.status === 'planted') { if (plant.payoff_beat) issue(issues, 'planted_already_linked', '未回収の仕込みに回収先は入れません', plant.id); }
    else issue(issues, 'plant_status', '仕込みの状態が不正です', plant.id);
  }
}

function checkMusic(plan, issues) {
  const music = plan.music;
  if (music === undefined) {
    for (const beat of plan.beats ?? []) if ((beat.lyric_refs ?? []).length) issue(issues, 'lyric_ref_missing', '歌詞 cue が定義されていません', beat.id);
    return;
  }
  if (!music || !['known', 'unknown', 'not_applicable'].includes(music.status)) return issue(issues, 'music', '曲の状態は known・unknown・not_applicable です');
  if (music.status !== 'known') {
    if ('cues' in music || JSON.stringify(music).includes('"start"') || JSON.stringify(music).includes('"end"')) issue(issues, 'fabricated_music_timing', '曲を未確認または適用外とするとき、拍や歌詞時刻は入れません');
    for (const beat of plan.beats ?? []) if ((beat.lyric_refs ?? []).length) issue(issues, 'fabricated_music_timing', '曲を未確認または適用外とするとき、歌詞 cue は参照しません', beat.id);
    return;
  }
  if (!Array.isArray(music.cues)) return issue(issues, 'music', '確認できた曲には cue の配列が必要です');
  const cueIds = new Set();
  for (const cue of music.cues) {
    if (!cue || !ID.test(cue.id ?? '') || typeof cue.text !== 'string' || !cue.text.trim() || cueIds.has(cue.id)) issue(issues, 'lyric_cue', '歌詞 cue の id か本文が不正です', cue?.id);
    cueIds.add(cue.id);
    const timed = cue.start !== undefined || cue.end !== undefined;
    if (timed && (!Number.isFinite(cue.start) || !Number.isFinite(cue.end) || cue.end <= cue.start)) issue(issues, 'lyric_timing', '歌詞 cue の区間が不正です', cue.id);
    for (const key of Object.keys(cue)) if (!['id', 'text', 'start', 'end'].includes(key)) issue(issues, 'lyric_cue', '歌詞 cue に使えない項目があります', cue.id);
  }
  for (const beat of plan.beats ?? []) for (const id of beat.lyric_refs ?? []) if (!cueIds.has(id)) issue(issues, 'lyric_ref_missing', '歌詞 cue の参照先がありません', id);
}

function checkAllocation(plan, context, issues) {
  if (plan.allocation === undefined) return;
  const allocation = plan.allocation;
  if (!allocation || !Number.isFinite(allocation.seconds) || !Array.isArray(allocation.phases) || !allocation.phases.length) return issue(issues, 'allocation', '尺配分が不正です');
  let cursor = 0;
  for (const phase of allocation.phases) {
    if (!phase || !Number.isInteger(phase.milliseconds) || phase.milliseconds < 0 || phase.start_ms !== cursor || phase.end_ms !== cursor + phase.milliseconds) issue(issues, 'allocation', '尺配分の区間が連続していません');
    cursor += phase.milliseconds ?? 0;
  }
  if (cursor !== Math.round(allocation.seconds * 1000) || allocation.sum_milliseconds !== cursor) issue(issues, 'duration_mismatch', '尺配分の合計が指定尺と一致しません');
  if (context?.seconds != null && Math.round(context.seconds * 1000) !== Math.round(allocation.seconds * 1000)) issue(issues, 'duration_mismatch', '構成メモの尺が案件の長さと一致しません');
}

export function reconfirmAgainst(previous, next) {
  if (!previous || !next) return [];
  const targets = [];
  const previousBeats = new Map((previous.beats ?? []).map(beat => [beat.id, beat]));
  const nextBeats = new Map((next.beats ?? []).map(beat => [beat.id, beat]));
  const push = (beat, reason, plant) => targets.push({ beat: beat?.id ?? beat, shot_refs: beat?.shot_refs ?? [], lyric_refs: beat?.lyric_refs ?? [], generation_refs: beat?.generation_refs ?? [], reason, ...(plant ? { plant } : {}) });
  for (const beat of next.beats ?? []) {
    const old = previousBeats.get(beat.id);
    if (!old) push(beat, 'beat_added');
    else if (json(old) !== json(beat)) push(beat, 'beat_changed');
  }
  for (const beat of previous.beats ?? []) if (!nextBeats.has(beat.id)) push(beat, 'beat_removed');
  if (json(previous.ending_intention ?? null) !== json(next.ending_intention ?? null)) {
    for (const plant of next.modules?.plants ?? []) for (const id of [plant.plant_beat, plant.payoff_beat]) if (id) push(nextBeats.get(id) ?? { id, shot_refs: [] }, 'ending_changed', plant.id);
  }
  const seen = new Set();
  return targets.filter(item => {
    const key = json(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function projectContext(root) {
  let raw;
  try { raw = await read(root, 'tsugite.yaml'); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  const config = parse(raw, { maxAliasCount: 0 });
  if (!config || typeof config !== 'object') return null;
  const seconds = typeof config.length === 'number' ? config.length : typeof config.length === 'string' && /^\d+(\.\d+)?s$/.test(config.length) ? Number(config.length.slice(0, -1)) : null;
  const tasks = Array.isArray(config.make) ? config.make.filter(task => typeof task?.id === 'string') : [];
  const clipIds = [
    ...(Array.isArray(config.use) ? config.use.map((_, index) => `input-${index}`) : []),
    ...tasks.filter(task => (task.kind ?? 'video') !== 'audio').map(task => task.id)
  ];
  return { seconds, clipIds, taskIds: tasks.map(task => task.id) };
}

async function readStory(root, relative) {
  const raw = await read(root, relative);
  if (Buffer.byteLength(raw) > 256000) fail('Story plan is too large');
  return raw;
}

export async function checkStoryFile(root, relative) {
  const plan = JSON.parse(await readStory(root, relative));
  const catalog = await loadStoryCatalog();
  const issues = validateStoryPlan(plan, await projectContext(root), catalog);
  return { mechanical: { ok: issues.length === 0, issues }, meaning_review: 'not_automated', generated: false, approval: 'not-requested' };
}

export async function projectStory(root, relative, context) {
  const raw = await readStory(root, relative);
  const plan = JSON.parse(raw);
  const catalog = await loadStoryCatalog();
  const issues = validateStoryPlan(plan, context, catalog);
  if (issues.length) fail(`Story plan: ${issues[0].code}: ${issues[0].message}`);
  return { ...plan, source_hash: hash(raw) };
}

export async function bindStory(root, relative) {
  return locked(root, async () => {
    const checked = await checkStoryFile(root, relative);
    if (!checked.mechanical.ok) fail(`Story plan: ${checked.mechanical.issues[0].code}: ${checked.mechanical.issues[0].message}`);
    const config = parse(await read(root, 'tsugite.yaml'), { maxAliasCount: 0 });
    if (!config || typeof config !== 'object') fail('Invalid project');
    config.story = relative;
    await write(root, 'tsugite.yaml', stringify(config));
    return { bound: relative, catalog_revision: JSON.parse(await readStory(root, relative)).catalog_revision, generated: false, approval: 'not-requested' };
  });
}
