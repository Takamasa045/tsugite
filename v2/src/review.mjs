import http from 'node:http';
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import {settle,units} from './budget.mjs';
import {fileHash,read,hash} from './files.mjs';
import {probe} from '../plugins/local/index.mjs';
import { currentPlan, state, checkScope, requireApproval, status, cleanPreview, saveState, plan } from './core.mjs';
import { inside, locked, readJSON, write, fail } from './files.mjs';
import { addNote, candidates, decideRule, ruleResult, retireRule, tasteHome, evaluateChecks } from './taste.mjs';
import { parse } from 'yaml';
import { createTranslator, resolveLanguageFromEnvironment } from './i18n.mjs';
import { reviewStyle } from './review-style.mjs';

const escape = value => String(value).replace(/[&<>"']/g, ch => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[ch]));
function slotText(value, tr) {
  if (!value || typeof value !== 'object') return '';
  if (value.status === 'known') return String(value.text ?? '');
  if (value.status === 'undecided') return tr('review.story_undecided');
  if (value.status === 'unknown') return tr('review.story_unknown');
  if (value.status === 'not_applicable') return tr('review.story_na');
  return '';
}
function storySection(plan, tr, targets) {
  if (!plan.story) return `<section><h2>${tr('review.story_intent')}</h2><p>${tr('review.story_none')}</p></section>`;
  const story = plan.story;
  const frameworks = (story.selected_frameworks ?? []).map(item => `<li>${escape(item.id)}: ${escape(item.reason)}</li>`).join('');
  const beats = (story.beats ?? []).map(beat => `<li><strong>${escape(beat.id)}</strong> ${escape(slotText(beat.purpose, tr))} — ${escape(slotText(beat.visible_action, tr))}<br>${tr('review.story_shots')} ${escape((beat.shot_refs ?? []).join(', ') || '—')}</li>`).join('');
  const again = targets.length ? `<h3>${tr('review.story_reconfirm')}</h3><ul>${targets.map(item => `<li>${escape(item.beat)} · ${escape(item.reason)} · ${escape((item.shot_refs ?? []).join(', ') || '—')}</li>`).join('')}</ul><p>${tr('review.story_reconfirm_note')}</p>` : '';
  return `<section><h2>${tr('review.story_intent')}</h2><p>${tr('review.story_experience')}: ${escape(slotText(story.audience_experience, tr))}</p><h3>${tr('review.story_frameworks')}</h3><ul>${frameworks}</ul><h3>${tr('review.story_beats')}</h3><ol>${beats}</ol>${again}</section>`;
}
const hidden = (name, value) => `<input type="hidden" name="${escape(name)}" value="${escape(value)}">`;
const headers = {
  'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
  // no-referrer turns native form POST Origin into null. Keep cross-origin
  // referrers private while allowing our exact same-origin POST guard to work.
  'Referrer-Policy': 'same-origin', 'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; media-src 'self'; img-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'"
};
function form(token, digest, action, fields, label, disabled = false) {
  return `<form method="post" action="/action">${hidden('csrf', token)}${hidden('digest', digest)}${hidden('action', action)}${Object.entries(fields).map(([k,v]) => hidden(k,v)).join('')}<button type="submit" ${disabled ? 'disabled' : ''}>${escape(label)}</button></form>`;
}
async function projectLang(root) {
  try {
    const parsed = parse(await read(root, 'tsugite.yaml'), { maxAliasCount: 0 });
    return typeof parsed?.lang === 'string' ? parsed.lang : undefined;
  } catch {
    return undefined;
  }
}

async function html(root, token, lang) {
  const tr = createTranslator(lang);
  const info = await status(root), s = await state(root), p = info.plan;
  const stages = ['plan', 'clips', 'final'];
  const active = stages.find(stage => info.checks[stage] !== 'approved');
  const reconfirm = await readJSON(root, '.tsugite/story-reconfirm.json', { targets: [] });
  const storyHtml = storySection(p, tr, Array.isArray(reconfirm.targets) ? reconfirm.targets : []);
  const checks = [];
  for (const stage of stages) {
    let scope;
    try { scope = await checkScope(root, stage, p, info.digest, s); } catch { /* Not ready yet. */ }
    const preceding = stage === 'clips' ? info.checks.plan === 'approved' : stage === 'final' ? info.checks.clips === 'approved' : true;
    const approved = info.checks[stage] === 'approved';
    checks.push({ stage, approved, ready: Boolean(scope && preceding && !approved), form: form(token, info.digest, 'approve', { stage, scope: scope ?? '' }, tr('review.approve_' + stage), !scope || !preceding || approved) });
  }
  let clipsScope; try { clipsScope = await checkScope(root, 'clips', p, info.digest, s); } catch {}
  let clean; try { clean = await cleanPreview(root); } catch {}
  const habits = info.checks.final === 'approved' ? await candidates(root) : [];
  const stats = [...Object.entries(await readJSON(root, 'taste/stats.json', {})).map(([key,r])=>({key,...r,tasteScope:'project'})),...Object.entries(await readJSON(tasteHome(),'taste/stats.json',{})).map(([key,r])=>({key,...r,tasteScope:'global'}))].filter(r=>!r.retired);
  const media = (clip, i, final = false) => {
    const label = final ? tr('review.final_preview') : tr('review.clip_number', { number: i + 1 });
    if (!final && clip?.taskKey && s.jobs[clip.taskKey]?.status !== 'done') return `<p class="empty">${tr('review.preview_pending')}</p>`;
    if (clip?.still && !final) return `<img src="/media/${i}" alt="${escape(label)}">`;
    const fragment = final ? '' : `#t=${clip.start ?? 0},${(clip.start ?? 0) + clip.seconds}`;
    const subtitles = final && p.timeline.captionMode !== 'burn' && p.timeline.captions?.length ? `<track kind="captions" src="/captions.vtt" label="${escape(tr('review.captions_label'))}" default>` : '';
    return `<video controls playsinline preload="metadata" aria-label="${escape(label)}" src="/media/${final ? 'final' : i}${fragment}" ${!final && clip.loop ? 'loop' : ''} ${!final && !clip.audio ? 'muted' : ''}>${subtitles}</video>`;
  };
  const clipMeta = clip => tr('review.clip_meta', { start: clip.start ?? 0, loop: clip.loop ? tr('review.loop_on') : tr('review.loop_off'), sound: clip.audio ? tr('review.sound_on') : tr('review.sound_off') });
  const hasFinal = info.output?.status === 'done';
  const first = p.timeline.clips[0];
  const preview = hasFinal || first ? `<div class="screen">${media(first, 0, hasFinal)}</div>` : `<p class="empty">${tr('review.preview_pending')}</p>`;
  const rows = p.timeline.clips.map((clip, i) => `<li><h3>${tr('review.clip_number', { number: i + 1 })} <span class="subtle">${clip.seconds.toFixed(2)}s</span></h3>${media(clip, i)}<p>${escape(clipMeta(clip))}</p><p>${escape(p.tasks.find(x => x.id === clip.id)?.prompt || clip.path)}</p>${clip.taskKey && clipsScope ? form(token, info.digest, 'retry', { id: clip.id, scope: clipsScope }, tr('review.remake')) : ''}</li>`).join('');
  const recovery = p.tasks.filter(task=>{const job=s.jobs[task.key],entry=s.ledger.entries.find(e=>e.id===task.key);return job?.status==='failed'||job?.status==='uncertain'||entry?.status==='uncertain';}).map(task=>s.jobs[task.key]?.status==='failed'?`<section class="recovery"><h2>${tr('review.failed_title', { id: escape(task.id) })}</h2>${form(token,info.digest,'retry-failed',{key:task.key},tr('review.retry_failed'))}</section>`:`<section class="recovery"><h2>${tr('review.reconcile_title', { id: escape(task.id) })}</h2><p>${tr('review.reconcile_body')}</p><form method="post" action="/action">${hidden('csrf',token)}${hidden('digest',info.digest)}${hidden('action','reconcile')}${hidden('key',task.key)}<input name="receipt" type="text" required aria-label="${escape(tr('review.receipt_label'))}" placeholder="assets/receipt.json"><button type="submit">${tr('review.reconcile_button')}</button></form></section>`).join('');
  const audioSection = (p.timeline.audio ?? []).map((track, i) => `<div class="audio-tracks"><h3>${escape(track.id)} <span class="subtle">${escape(track.kind)} · ${track.seconds}s</span></h3><audio controls preload="metadata" aria-label="${escape(track.id)}" src="/media/audio-${i}"></audio></div>`).join('');
  const stepper = `<nav aria-label="${escape(tr('review.progress'))}"><ol class="steps">${checks.map((item, i) => `<li class="${item.approved ? 'complete' : active === item.stage ? 'active' : ''}"><a href="#stage-${item.stage}" ${active === item.stage ? 'aria-current="step"' : ''}><span class="step-number" aria-hidden="true">${item.approved ? '✓' : i + 1}</span><span>${tr('review.step_' + item.stage)}<small class="step-state">${tr('review.check_' + (item.approved ? 'approved' : 'waiting'))}</small></span></a></li>`).join('')}</ol></nav>`;
  // Only add credits within one service; distinct service units never mix.
  const costs = new Map();
  for (const task of p.tasks) costs.set(task.quote.service, (costs.get(task.quote.service) ?? 0) + task.quote.credits);
  const noCost = [...costs.values()].every(value => value === 0);
  const cost = `<div class="cost"><p class="cost-label">${tr('review.cost_label')}</p>${noCost ? `<p class="cost-value">0<span>credits</span></p>` : `<ul>${[...costs].map(([service, amount]) => `<li><strong>${escape(service)}</strong> ${amount} credits</li>`).join('')}</ul>`}<p class="subtle">${tr(p.tasks.length ? 'review.generation_count' : 'review.no_generation', { count: p.tasks.length })}</p></div>`;
  const current = checks.find(item => item.stage === active);
  const decision = `<aside class="decision" aria-label="${escape(tr('review.decision_label'))}"><span class="state-label ${active ? '' : 'done'}">${tr(active ? 'review.stage_check_' + active : 'review.all_checked')}</span><h2>${tr(active ? 'review.decision_' + active : 'review.complete_title')}</h2><p class="decision-copy">${tr(active ? 'review.decision_copy_' + active : 'review.complete_copy')}</p>${cost}${current ? `<section id="stage-${active}">${current.ready ? '' : `<p class="subtle">${tr('review.preparing_stage')}</p>`}${current.form}<p class="next-copy">${tr('review.next_' + active)}</p></section>` : `<p class="decision-status" role="status">${tr('review.all_checked')}</p>`}<dl><div><dt>${tr('review.duration_label')}</dt><dd>${tr('review.duration_value', { seconds: p.seconds })}</dd></div><div><dt>${tr('review.clips_label')}</dt><dd>${tr('review.clips_value', { count: p.timeline.clips.length })}</dd></div><div><dt>${tr('review.format_label')}</dt><dd>${escape(p.format)}</dd></div><div><dt>${tr('review.sound_label')}</dt><dd>${tr(p.timeline.clips.some(c => c.audio) || p.timeline.audio?.length ? 'review.sound_present' : 'review.sound_absent')}</dd></div></dl><details class="stage-history"><summary>${tr('review.other_checks')}</summary>${checks.filter(item => item.stage !== active).map(item => `<section id="stage-${item.stage}" class="secondary"><h3>${tr('review.stage_check_' + item.stage)}</h3><p>${tr('review.check_' + (item.approved ? 'approved' : 'waiting'))}</p>${item.form}</section>`).join('')}</details></aside>`;
  const technical = (label, value) => `<details><summary>${tr(label)}</summary><pre>${escape(JSON.stringify(value, null, 2))}</pre></details>`;
  const details = technical('review.source_requests', p.tasks.map(({id,with:provider,kind,prompt,seconds,options,quote})=>({id,provider,kind:kind??'video',prompt,seconds,options,quote}))) + technical('review.connections', Object.fromEntries(Object.entries(p.plugins).map(([id,m])=>[id,m.settings?.connection??null]))) + technical('review.renderer_options', p.timeline.rendererOptions ?? {}) + technical('review.caption_timing', p.timeline.captions ?? []) + technical('review.credits', { limits: p.budget, estimated: p.tasks.map(t => ({ clip: t.id, ...t.quote })), ledger: info.budget }) + technical('review.preferences', { taste: p.taste, knowledge: p.knowledge }) + technical('review.auto_checks', evaluateChecks(p.taste, info.output, p.timeline));
  const auxiliary = habits.map(h => `<section><h2>${tr('review.habit_title')}</h2><p>${escape(h.text)}</p>${form(token,info.digest,'rule',{key:h.key,accept:'yes',tasteScope:h.tasteScope},tr('review.use_rule'))}${form(token,info.digest,'rule',{key:h.key,accept:'no',tasteScope:h.tasteScope},tr('review.keep_note'))}</section>`).join('') + stats.map(r => `<section><p>${tr('review.rule_stats', { text: escape(r.text), effective: r.effective, missed: r.missed })}</p>${form(token,info.digest,'result',{key:r.key,effective:'yes',tasteScope:r.tasteScope},tr('review.rule_helped'))}${form(token,info.digest,'result',{key:r.key,effective:'no',tasteScope:r.tasteScope},tr('review.rule_missed'))}${r.consecutiveMisses >= 2 ? `<p>${tr('review.missed_twice')}</p>${form(token,info.digest,'retire',{key:r.key,tasteScope:r.tasteScope},tr('review.retire'))}` : ''}</section>`).join('');
  return `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>継手 · ${escape(p.name)}</title><style>${reviewStyle}</style></head><body><a class="skip-link" href="#preview">${tr('review.skip_review')}</a><div class="shell"><header class="topbar"><div class="brand"><svg class="brand-mark" viewBox="0 0 32 32" aria-hidden="true"><path fill="currentColor" d="M3 5h11v7H9v8H3zM18 12h11v15H18v-7h5v-2h-5zM11 14h10v4H11z"/></svg><span>継手</span></div><span class="local-label">${tr('review.local_private')}</span></header><div class="project-head"><h1>${escape(p.name)}</h1><div class="project-meta"><span>${escape(p.format)}</span><span>${tr('review.duration_value', { seconds: p.seconds })}</span><span>${tr('review.clips_value', { count: p.timeline.clips.length })}</span></div>${['mock','live'].includes(p.execution) ? `<p class="mode-notice">${tr('review.' + p.execution)}</p>` : ''}</div>${stepper}${recovery}<main class="workspace"><div class="review-main"><section id="preview"><div class="section-heading"><h2>${tr(hasFinal ? 'review.final_preview' : 'review.plan_storyboard')}</h2><span class="subtle">${tr(hasFinal ? 'review.output_ready' : 'review.source_preview')}</span></div>${preview}<div class="screen-caption"><p>${hasFinal ? tr('review.final_note') : first ? escape(clipMeta(first)) : ''}</p><span>${escape(p.renderer)}</span></div>${p.timeline.clips.length > 1 || hasFinal ? `<ol class="clip-grid">${rows}</ol>` : first?.taskKey && clipsScope ? form(token, info.digest, 'retry', { id: first.id, scope: clipsScope }, tr('review.remake')) : ''}${audioSection}</section>${p.story ? `<div class="story-panel">${storyHtml}</div>` : ''}<section class="note-panel"><h2>${tr('review.leave_note')}</h2><form method="post" action="/action">${hidden('csrf',token)}${hidden('digest',info.digest)}${hidden('action','note')}<label class="subtle" for="review-note">${tr('review.note_prompt')}</label><textarea id="review-note" name="text" rows="2" required maxlength="2000" aria-label="${tr('review.note_aria')}"></textarea><button type="submit">${tr('review.save_note')}</button></form><small>${tr('review.note_help')}</small></section></div>${decision}</main><div class="details-area"><details><summary>${tr('review.details_label')}</summary><div class="technical-grid">${details}</div>${!p.story ? storyHtml : ''}<p class="subtle">${tr('review.checks_note')}</p></details>${auxiliary ? `<details><summary>${tr('review.habits_label')}</summary><div class="auxiliary secondary">${auxiliary}</div></details>` : ''}${clean ? `<details><summary>${tr('review.clean_title')}</summary><pre>${escape(JSON.stringify(clean.files,null,2))}</pre><p class="subtle">${tr('review.clean_help')}</p><div class="secondary">${form(token,info.digest,'clean',{preview:clean.previewDigest},tr('review.clean_button'),!clean.files.length)}</div></details>` : ''}</div><footer class="footer"><p>${tr('review.footer')}</p><small>${tr('review.plan_digest', { digest: escape(info.digest) })}</small></footer></div></body></html>`;
}

function errorHtml(message, lang) {
  const tr = createTranslator(lang);
  return `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${tr('review.error_title')} · 継手</title><style>${reviewStyle}</style></head><body><main class="error-shell"><span class="state-label">${tr('review.not_saved')}</span><h1>${tr('review.error_title')}</h1><p>${tr('review.error_help')}</p><details><summary>${tr('review.error_details')}</summary><pre>${escape(message)}</pre></details><p><a class="return-link" href="/">${tr('review.return_review')}</a></p></main></body></html>`;
}

export async function review(root, { port = 0, lang } = {}) {
  const language = resolveLanguageFromEnvironment({
    cliLang: lang,
    projectLang: await projectLang(root)
  }).language;
  const csrf = randomBytes(32).toString('hex'), cookie = randomBytes(32).toString('hex');
  const cookieName = 'tsugite_' + randomBytes(8).toString('hex');
  let origin;
  const server = http.createServer(async (req, res) => {
    const respond = (code, text, type = 'text/plain; charset=utf-8') => { res.writeHead(code, { ...headers, 'Content-Type': type }); res.end(text); };
    try {
      if (req.headers.host !== new URL(origin).host) return respond(403, 'Invalid host');
      if (req.headers['sec-fetch-site'] && !['same-origin','none'].includes(req.headers['sec-fetch-site'])) return respond(403, 'Cross-site request denied');
      const authenticated = req.headers.cookie?.split(';').some(x => x.trim() === `${cookieName}=${cookie}`);
      if (req.method === 'GET' && req.url === '/') {
        res.setHeader('Set-Cookie', `${cookieName}=${cookie}; HttpOnly; SameSite=Strict; Path=/`);
        return respond(200, await html(root, csrf, language), 'text/html; charset=utf-8');
      }
      if(req.method==='GET'&&req.url==='/captions.vtt'){
        if(!authenticated)return respond(403,'Session required');
        const {plan:p}=await currentPlan(root);
        const stamp=s=>new Date(Math.round(s*1000)).toISOString().slice(11,23);
        return respond(200,'WEBVTT\n\n'+(p.timeline.captions??[]).map(c=>stamp(c.start)+' --> '+stamp(c.end)+'\n'+c.text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')+'\n').join('\n'),'text/vtt; charset=utf-8');
      }
      if (req.method === 'GET' && /^\/media\/(\d+|audio-\d+|final)$/.test(req.url)) {
        if (!authenticated) return respond(403,'Session required');
        const { plan: p, digest } = await currentPlan(root), s = await state(root), id = req.url.slice(7);
        const relative = id === 'final' ? s.renders[digest]?.path : id.startsWith('audio-') ? p.timeline.audio?.[Number(id.slice(6))]?.path : p.timeline.clips[Number(id)]?.path;
        if (!relative) return respond(404,'No media');
        const target = await inside(root, relative), stat = await fs.stat(target);
        const range = req.headers.range?.match(/^bytes=(\d+)-(\d*)$/);
        const start = range ? Number(range[1]) : 0, end = range?.[2] ? Number(range[2]) : stat.size - 1;
        if (start > end || end >= stat.size) return respond(416,'Invalid range');
        res.writeHead(range ? 206 : 200, { ...headers, 'Content-Type': id.startsWith('audio-')?({'.mp3':'audio/mpeg','.ogg':'audio/ogg','.flac':'audio/flac','.m4a':'audio/mp4'}[path.extname(relative).toLowerCase()]??'audio/wav'):({'.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp'}[path.extname(relative).toLowerCase()]??'video/mp4'), 'Accept-Ranges': 'bytes', 'Content-Length': end-start+1, ...(range ? {'Content-Range': `bytes ${start}-${end}/${stat.size}`} : {}) });
        createReadStream(target, { start, end }).on('error', () => res.destroy()).pipe(res); return;
      }
      if (req.method !== 'POST' || req.url !== '/action') return respond(404,'Not found');
      if (!authenticated || req.headers.origin !== origin || !/^application\/x-www-form-urlencoded(?:\s*;\s*charset=utf-8)?$/i.test(req.headers['content-type'] ?? '')) return respond(403, errorHtml('Invalid confirmation-page request', language), 'text/html; charset=utf-8');
      let body = '';
      for await (const chunk of req) { body += chunk; if (body.length > 16000) return respond(413,'Request too large'); }
      const fields = new URLSearchParams(body);
      if (fields.get('csrf') !== csrf) return respond(403, errorHtml('Invalid page token', language), 'text/html; charset=utf-8');
      let replan = false;
      await locked(root, async () => {
        const { plan: p, digest } = await currentPlan(root), s = await state(root), action = fields.get('action');
        if (digest !== fields.get('digest')) fail('Stale page; reload the current plan');
        if (action === 'approve') {
          const stage = fields.get('stage');
          if (stage !== 'plan') await requireApproval(root, 'plan', p, digest, s);
          if (stage === 'final') await requireApproval(root, 'clips', p, digest, s);
          const scope = await checkScope(root, stage, p, digest, s);
          if (scope !== fields.get('scope')) fail('Stale check contents');
          await write(root, `.tsugite/approvals/${stage}.json`, { stage, digest, scope, source: 'confirmation-page', at: new Date().toISOString(), ...(stage==='final'?{preferenceChecks:evaluateChecks(p.taste,s.renders[digest],p.timeline)}:{}) });
          await saveState(root, s, { action: 'approved', stage, digest });
        } else if (action === 'retry') {
          await requireApproval(root, 'plan', p, digest, s);
          if (await checkScope(root, 'clips', p, digest, s) !== fields.get('scope')) fail('Stale clips');
          const task = p.tasks.find(x => x.id === fields.get('id'));
          if (!task || s.jobs[task.key]?.status !== 'done') fail('Only a completed clip can be remade');
          const retries = await readJSON(root, '.tsugite/retries.json', {});
          retries[task.id] = (retries[task.id] ?? 0) + 1;
          await write(root, '.tsugite/retries.json', retries); replan = true;
        } else if(action==='reconcile'||action==='retry-failed'){
          await requireApproval(root,'plan',p,digest,s);
          const task=p.tasks.find(t=>t.key===fields.get('key')),job=task&&s.jobs[task.key],entry=task&&s.ledger.entries.find(e=>e.id===task.key);
          if(!task||!job||!entry)fail('Unknown reconciliation task');
          if(action==='retry-failed'){
            if(job.status!=='failed'||entry.status!=='settled')fail('Only a settled failed task can be retried');
            const retries=await readJSON(root,'.tsugite/retries.json',{});retries[task.id]=(retries[task.id]??0)+1;await write(root,'.tsugite/retries.json',retries);replan=true;
          }else{
            if(entry.status!=='uncertain'||!['uncertain','done'].includes(job.status))fail('Task is not uncertain');
            const file=fields.get('receipt');if(!file?.startsWith('assets/')||!file.endsWith('.json'))fail('Receipt must be a project-local JSON file');
            const stat=await fs.stat(await inside(root,file));if(stat.size>100000)fail('Receipt too large');
            const raw=await read(root,file);if(raw.length>100000)fail('Receipt too large');const receipt=JSON.parse(raw);
            if(receipt.version!==1||receipt.task_key!==task.key||receipt.service!==entry.service||job.providerJobId&&receipt.provider_job_id!==job.providerJobId||!['failed','completed'].includes(receipt.outcome)||units(receipt.credits)>units(entry.credits))fail('Receipt identity or credit amount does not match reservation');
            if(receipt.outcome==='completed'){await probe(await inside(root,job.path),task.kind==='audio'?'audio':'video');job.hash=await fileHash(root,job.path);}
            entry.status='started';settle(s.ledger,task.key,receipt.credits);entry.receiptHash=hash(raw);entry.reconciledBy='confirmation-page';job.status=receipt.outcome==='completed'?'done':'failed';
            await saveState(root,s,{action:'manual-reconciliation',id:task.id,receiptHash:entry.receiptHash});
          }
        } else if (action === 'note') {
          await addNote(root, fields.get('text'));
          replan = true;
        } else if (action === 'rule' || action === 'result' || action === 'retire') {
          await requireApproval(root, 'final', p, digest, s);
          const scope=fields.get('tasteScope') || 'project';
          if(!['project','global'].includes(scope))fail('Invalid taste scope');
          const target=scope==='global'?tasteHome():root;
          const update=async()=>{
            if (action === 'rule') { await decideRule(root, fields.get('key'), fields.get('accept') === 'yes',scope); replan = true; }
            else if(action==='retire') { await retireRule(target,fields.get('key'));replan=true; }
            else await ruleResult(target, fields.get('key'), fields.get('effective') === 'yes',digest);
          };
          if(scope==='global')await locked(target,update);else await update();
        } else if (action === 'clean') {
          const preview = await cleanPreview(root);
          if (fields.get('preview') !== preview.previewDigest) fail('Clean preview changed');
          for (const file of preview.files) {
            const target = `.tsugite/trash/${randomBytes(8).toString('hex')}.mp4`;
            const destination = await inside(root, target); await fs.mkdir(path.dirname(destination), { recursive: true });
            // Record each move before mutating so an interruption remains recoverable.
            await saveState(root, s, { action: 'trash-intent', from: file.path, to: target, hash: file.hash });
            await fs.rename(await inside(root, file.path), destination);
            for (const job of Object.values(s.jobs)) if (job.path === file.path) job.status = 'trashed';
            for (const render of Object.values(s.renders)) if (render.path === file.path) render.status = 'trashed';
            await saveState(root, s, { action: 'trashed', from: file.path, to: target });
          }
        } else fail('Unknown page action');
      });
      if (replan) await plan(root);
      res.writeHead(303, { ...headers, Location: '/' }); res.end();
    } catch (e) { respond(409, errorHtml(e.message, language), 'text/html; charset=utf-8'); }
  });
  server.requestTimeout = 10000; server.headersTimeout = 10000;
  await new Promise((resolve,reject) => { server.once('error',reject); server.listen(port,'127.0.0.1',resolve); });
  origin = `http://127.0.0.1:${server.address().port}`;
  return { server, url: origin + '/', close: () => new Promise(resolve => { server.close(resolve); server.closeIdleConnections(); }) };
}
