import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { read, readJSON, write, exists, fail, hash } from './files.mjs';
export const tasteHome = () => path.resolve(process.env.TSUGITE_HOME || path.join(os.homedir(), '.tsugite'));
const normalize = text => text.normalize('NFKC').toLowerCase().replace(/[\p{P}\p{Z}\s]/gu, '');
function fingerprint(text){
  const words=text.normalize('NFKC').toLowerCase().match(/[a-z]+|\d+(?:\.\d+)?/g);
  if(!words||/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(text))return normalize(text);
  const stop=new Set(['please','the','a','an','is','are','be','should','keep','make','it']);
  return words.filter(word=>!stop.has(word)).map(word=>word.length>4?word.replace(/(ing|er|s)$/,''):word).sort().join(' ');
}
export async function taste(root) {
  const local = await readJSON(root, 'taste/notes.json', []);
  const global = path.resolve(root) === tasteHome() ? [] : await readJSON(tasteHome(),'taste/notes.json',[]);
  let rules = '', globalRules = '';
  try { rules = await read(root, 'taste/rules.md'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  if (await exists(tasteHome())) {
    try { globalRules = await read(tasteHome(), 'taste/rules.md'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
  const checks=[...await readJSON(root,'taste/checks.json',[]),...await readJSON(tasteHome(),'taste/checks.json',[])];
  for(const check of checks) if(!check || !['max_duration','min_width','min_height','max_bgm_start'].includes(check.kind) || !Number.isFinite(check.value) || check.value<0)fail('Invalid machine-checkable taste condition');
  return { notes: local.map(x => ({ text: x.text, key: x.key, stage: x.stage })), globalNotes: global.map(x=>({text:x.text,key:x.key,stage:x.stage})), rules, globalRules,checks };
}
export function evaluateChecks(preferences,output,timeline={}) {
  if(!output || output.status!=='done')return [];
  return preferences.checks.map(check=>{
    const bgm=(timeline.audio??[]).filter(track=>track.kind==='bgm'&&track.volume>0).map(track=>track.start);
    const actual=check.kind==='max_duration'?output.seconds:check.kind==='min_width'?output.width:check.kind==='max_bgm_start'?(bgm.length?Math.min(...bgm):null):output.height;
    return {...check,actual,source:check.kind==='max_bgm_start'?'approved timeline schedule':'rendered media',passed:actual!==null&&(check.kind==='max_duration'||check.kind==='max_bgm_start'?actual<=check.value:actual>=check.value)};
  });
}
export async function addNote(root, text, group) {
  if (typeof text !== 'string' || !text.trim() || text.length > 2000 || /[\r\n]/.test(text)) fail('Note must be a single line of 1–2000 characters');
  const notes = await readJSON(root, 'taste/notes.json', []);
  // Conservative local wording normalization; numeric values and negation stay.
  // Explicit groups let the human handle concepts beyond lexical similarity.
  const literal=hash(normalize(group||text)),matching=group?notes.find(n=>hash(normalize(n.text))===literal):notes.slice(-200).find(n=>fingerprint(n.text)===fingerprint(text));
  const key=matching?.key??literal;
  notes.push({ text: text.trim(), key, stage: 'observation', at: new Date().toISOString() });
  if (notes.filter(x => x.key === key).length >= 3) for (const n of notes.filter(x => x.key === key)) if (n.stage !== 'rule') n.stage = 'habit';
  await write(root, 'taste/notes.json', notes);
  return { text, key, count: notes.filter(x => x.key === key).length };
}
async function scopeCandidates(root, tasteScope) {
  const notes = await readJSON(root, 'taste/notes.json', []), decisions = await readJSON(root, 'taste/decisions.json', {});
  return [...new Set(notes.filter(x => x.stage === 'habit').map(x => x.key))].filter(k => !decisions[k]).map(key => ({ key, text: notes.find(x => x.key === key).text, tasteScope }));
}
export async function candidates(root) {
  return [...await scopeCandidates(root,'project'),...await scopeCandidates(tasteHome(),'global')];
}
export async function decideRule(root, key, accept, tasteScope = 'project') {
  if(!['project','global'].includes(tasteScope))fail('Invalid taste scope');
  if(tasteScope==='global')root=tasteHome();
  const candidate = (await scopeCandidates(root,tasteScope)).find(x => x.key === key);
  if (!candidate) fail('No pending habit');
  const decisions = await readJSON(root, 'taste/decisions.json', {});
  decisions[key] = { accepted: accept, at: new Date().toISOString() };
  if (accept) {
    let rules = ''; try { rules = await read(root, 'taste/rules.md'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    await write(root, 'taste/rules.md', rules + '- ' + candidate.text + '\n');
    const stats = await readJSON(root, 'taste/stats.json', {});
    stats[key] = { text: candidate.text, effective: 0, missed: 0, consecutiveMisses: 0 };
    await write(root, 'taste/stats.json', stats);
  }
  await write(root, 'taste/decisions.json', decisions);
}
export async function ruleResult(root, key, effective, digest) {
  const stats = await readJSON(root, 'taste/stats.json', {}), entry = stats[key];
  if (!entry || entry.retired) fail('Unknown or retired rule');
  if(typeof digest!=='string'||!/^[a-f0-9]{64}$/.test(digest))fail('Rule result needs a completed plan identity');
  entry.results??=[];
  const previous=entry.results.find(result=>result.digest===digest);
  if(previous) { if(previous.effective!==effective)fail('Outcome already recorded for this final');return entry; }
  entry.results.push({digest,effective});
  entry[effective ? 'effective' : 'missed']++;
  entry.consecutiveMisses = effective ? 0 : entry.consecutiveMisses + 1;
  await write(root, 'taste/stats.json', stats);
  return entry;
}
export async function retireRule(root,key) {
  const stats=await readJSON(root,'taste/stats.json',{}),entry=stats[key];
  if(!entry || entry.retired || entry.consecutiveMisses<2)fail('Rule is not a retirement candidate');
  const rules=await read(root,'taste/rules.md');
  await write(root,'taste/rules.md',rules.split('\n').filter(line=>line!==`- ${entry.text}`).join('\n'));
  entry.retired=true;await write(root,'taste/stats.json',stats);
}
export async function pack(root) { const value=await taste(root);return { version: 1, kind: 'taste', notes:value.notes,rules:value.rules }; }
export async function importPack(root, data) {
  if (data.version !== 1 || data.kind !== 'taste' || typeof data.rules !== 'string' || data.rules.length > 100000 || !Array.isArray(data.notes) || data.notes.length > 1000) fail('Invalid taste pack');
  // Imported rules remain suggestions until the user promotes them in the page.
  for (const line of data.rules.split('\n').map(x => x.replace(/^[-*] /, '').trim()).filter(Boolean)) await addNote(root, line);
  for (const note of data.notes) await addNote(root, note.text);
  return { imported: true, rulesAreSuggestions: true };
}
