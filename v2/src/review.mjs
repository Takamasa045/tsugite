import http from 'node:http';
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { currentPlan, state, checkScope, requireApproval, status, cleanPreview, saveState, plan } from './core.mjs';
import { inside, locked, readJSON, write, fail } from './files.mjs';
import { addNote, candidates, decideRule, ruleResult, retireRule, tasteHome, evaluateChecks } from './taste.mjs';

const escape = value => String(value).replace(/[&<>"']/g, ch => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[ch]));
const hidden = (name, value) => `<input type="hidden" name="${escape(name)}" value="${escape(value)}">`;
const headers = {
  'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; media-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'"
};
function form(token, digest, action, fields, label, disabled = false) {
  return `<form method="post" action="/action">${hidden('csrf', token)}${hidden('digest', digest)}${hidden('action', action)}${Object.entries(fields).map(([k,v]) => hidden(k,v)).join('')}<button ${disabled ? 'disabled' : ''}>${escape(label)}</button></form>`;
}
async function html(root, token) {
  const info = await status(root), s = await state(root), p = info.plan;
  let checks = '';
  for (const stage of ['plan','clips','final']) {
    let scope;
    try { scope = await checkScope(root, stage, p, info.digest, s); } catch {}
    const preceding = stage === 'clips' ? info.checks.plan === 'approved' : stage === 'final' ? info.checks.clips === 'approved' : true;
    checks += `<section><h2>${stage[0].toUpperCase() + stage.slice(1)} check</h2><p>${escape(info.checks[stage])}</p>${form(token, info.digest, 'approve', { stage, scope: scope ?? '' }, `Approve ${stage}`, !scope || !preceding || info.checks[stage] === 'approved')}</section>`;
  }
  let clipsScope; try { clipsScope = await checkScope(root, 'clips', p, info.digest, s); } catch {}
  let clean; try { clean = await cleanPreview(root); } catch {}
  const habits = info.checks.final === 'approved' ? await candidates(root) : [];
  const stats = [...Object.entries(await readJSON(root, 'taste/stats.json', {})).map(([key,r])=>({key,...r,tasteScope:'project'})),...Object.entries(await readJSON(tasteHome(),'taste/stats.json',{})).map(([key,r])=>({key,...r,tasteScope:'global'}))].filter(r=>!r.retired);
  const rows = p.timeline.clips.map((clip, i) => `<li><h3>${escape(clip.id)} · ${clip.seconds.toFixed(2)}s</h3><video controls preload="metadata" src="/media/${i}"></video><p>${escape(p.tasks.find(x => x.id === clip.id)?.prompt || clip.path)}</p>${clip.taskKey && clipsScope ? form(token, info.digest, 'retry', { id: clip.id, scope: clipsScope }, 'Remake this clip (new plan review required)') : ''}</li>`).join('');
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>継手 · ${escape(p.name)}</title><style>body{font:17px system-ui;max-width:1000px;margin:40px auto;padding:0 24px;color:#193a35;background:#f4f3eb}h1{font-size:40px}section{border-top:1px solid #97aaa3;padding:20px 0}button{background:#15594a;color:white;border:0;border-radius:5px;padding:12px 18px;cursor:pointer}button:disabled{opacity:.4;cursor:default}video{max-width:100%;height:220px;background:#10251f}ol{display:flex;flex-wrap:wrap;gap:24px;padding-left:24px}li{width:280px}pre{white-space:pre-wrap;overflow-wrap:anywhere}input[type=text]{padding:12px;max-width:80%}form{margin:12px 0}</style><header><p>継手 / Tsugite · local confirmation</p><h1>${escape(p.name)}</h1><p>${escape(p.format)} · ${p.seconds}s · ${escape(p.renderer)} renderer</p></header><section><h2>Plan & storyboard</h2><ol>${rows}</ol><h3>Credits by service</h3><pre>${escape(JSON.stringify({ limits: p.budget, estimated: p.tasks.map(t => ({ clip: t.id, ...t.quote })), ledger: info.budget }, null, 2))}</pre><p>Local sample: 0 provider credits. Different services are never added together.</p><h3>Preferences & knowledge</h3><pre>${escape(JSON.stringify({ taste: p.taste, knowledge: p.knowledge },null,2))}</pre></section><section><h2>Automatic preference checks</h2><pre>${escape(JSON.stringify(evaluateChecks(p.taste,info.output),null,2))}</pre><p>Preference results are advisory. Review any missed preference before the final check.</p></section>${checks}${info.output?.status === 'done' ? '<section><h2>Final preview</h2><video controls src="/media/final"></video><p>out/final.mp4 · Check picture, timing and sound before approving.</p></section>' : ''}<section><h2>Leave a note</h2><form method="post" action="/action">${hidden('csrf',token)}${hidden('digest',info.digest)}${hidden('action','note')}<input name="text" type="text" required maxlength="2000" aria-label="Taste note"><button>Save note</button></form><p>Notes become context for the next plan. Similar wording can be grouped explicitly with --group.</p></section>${habits.map(h => `<section><h2>Make this habit a rule?</h2><p>${escape(h.text)}</p>${form(token,info.digest,'rule',{key:h.key,accept:'yes',tasteScope:h.tasteScope},'Use as a rule')}${form(token,info.digest,'rule',{key:h.key,accept:'no',tasteScope:h.tasteScope},'Keep as a note')}</section>`).join('')}${stats.map(r => `<section><p>${escape(r.text)} · helped ${r.effective}, missed ${r.missed}</p>${form(token,info.digest,'result',{key:r.key,effective:'yes',tasteScope:r.tasteScope},'This rule helped')}${form(token,info.digest,'result',{key:r.key,effective:'no',tasteScope:r.tasteScope},'This rule missed')}${r.consecutiveMisses >= 2 ? `<p>Missed twice in a row.</p>${form(token,info.digest,'retire',{key:r.key,tasteScope:r.tasteScope},'Retire this rule')}` : ''}</section>`).join('')}${clean ? `<section><h2>Clean preview</h2><pre>${escape(JSON.stringify(clean.files,null,2))}</pre><p>Only recorded older generated media will move to project trash. Originals and final output stay.</p>${form(token,info.digest,'clean',{preview:clean.previewDigest},'Move these files to trash',!clean.files.length)}</section>` : ''}<footer><p>This page prevents accidental approvals. An agent with the same OS account can access it or edit the files; it is not a security isolation boundary. Review installed plugin code and keep budgets conservative.</p><small>Plan ${escape(info.digest)}</small></footer></html>`;
}
export async function review(root, { port = 0 } = {}) {
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
        return respond(200, await html(root, csrf), 'text/html; charset=utf-8');
      }
      if (req.method === 'GET' && /^\/media\/(\d+|final)$/.test(req.url)) {
        if (!authenticated) return respond(403,'Session required');
        const { plan: p, digest } = await currentPlan(root), s = await state(root), id = req.url.slice(7);
        const relative = id === 'final' ? s.renders[digest]?.path : p.timeline.clips[Number(id)]?.path;
        if (!relative) return respond(404,'No media');
        const target = await inside(root, relative), stat = await fs.stat(target);
        const range = req.headers.range?.match(/^bytes=(\d+)-(\d*)$/);
        const start = range ? Number(range[1]) : 0, end = range?.[2] ? Number(range[2]) : stat.size - 1;
        if (start > end || end >= stat.size) return respond(416,'Invalid range');
        res.writeHead(range ? 206 : 200, { ...headers, 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes', 'Content-Length': end-start+1, ...(range ? {'Content-Range': `bytes ${start}-${end}/${stat.size}`} : {}) });
        createReadStream(target, { start, end }).on('error', () => res.destroy()).pipe(res); return;
      }
      if (req.method !== 'POST' || req.url !== '/action') return respond(404,'Not found');
      if (!authenticated || req.headers.origin !== origin || req.headers['content-type'] !== 'application/x-www-form-urlencoded') return respond(403,'Invalid confirmation-page request');
      let body = '';
      for await (const chunk of req) { body += chunk; if (body.length > 16000) return respond(413,'Request too large'); }
      const fields = new URLSearchParams(body);
      if (fields.get('csrf') !== csrf) return respond(403,'Invalid page token');
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
          await write(root, `.tsugite/approvals/${stage}.json`, { stage, digest, scope, source: 'confirmation-page', at: new Date().toISOString(), ...(stage==='final'?{preferenceChecks:evaluateChecks(p.taste,s.renders[digest])}:{}) });
          await saveState(root, s, { action: 'approved', stage, digest });
        } else if (action === 'retry') {
          await requireApproval(root, 'plan', p, digest, s);
          if (await checkScope(root, 'clips', p, digest, s) !== fields.get('scope')) fail('Stale clips');
          const task = p.tasks.find(x => x.id === fields.get('id'));
          if (!task || s.jobs[task.key]?.status !== 'done') fail('Only a completed clip can be remade');
          const retries = await readJSON(root, '.tsugite/retries.json', {});
          retries[task.id] = (retries[task.id] ?? 0) + 1;
          await write(root, '.tsugite/retries.json', retries); replan = true;
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
    } catch (e) { respond(409, e.message); }
  });
  server.requestTimeout = 10000; server.headersTimeout = 10000;
  await new Promise((resolve,reject) => { server.once('error',reject); server.listen(port,'127.0.0.1',resolve); });
  origin = `http://127.0.0.1:${server.address().port}`;
  return { server, url: origin + '/', close: () => new Promise(resolve => { server.close(resolve); server.closeIdleConnections(); }) };
}
