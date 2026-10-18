import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { init } from '../src/core.mjs';
import { review } from '../src/review.mjs';
import { read,write } from '../src/files.mjs';
import { parse,stringify } from 'yaml';
export async function fixture(t) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(),'tsugite-v2-test-'));
  const root = path.join(home,'project');
  const previousTasteHome=process.env.TSUGITE_HOME;
  process.env.TSUGITE_HOME=path.join(home,'private-home');
  t.after(()=>fs.rm(home,{recursive:true,force:true}));
  t.after(()=>{if(previousTasteHome===undefined)delete process.env.TSUGITE_HOME;else process.env.TSUGITE_HOME=previousTasteHome;});
  await init(root); return {root,home};
}
export async function settings(root,update) {
  const c = parse(await read(root,'tsugite.yaml')); Object.assign(c,update);
  await write(root,'tsugite.yaml',stringify(c));
}
export async function page(t,root) {
  const server = await review(root); t.after(()=>server.close());
  return browser(server.url);
}
export async function browser(url) {
  const response = await fetch(url), cookie = response.headers.get('set-cookie').split(';')[0], html = await response.text();
  return {url,cookie,html, async refresh(){const r=await fetch(url,{headers:{Cookie:cookie}});this.html=await r.text();return this;}, async submit(action,fields={},options={}) {
    const csrf = this.html.match(/name="csrf" value="([^"]+)"/)[1];
    const digest = this.html.match(/name="digest" value="([^"]+)"/)[1];
    const form = [...this.html.matchAll(/<form[^>]*>([\s\S]*?)<\/form>/g)].find(x=>x[1].includes(`name="action" value="${action}"`) && (!fields.stage || x[1].includes(`name="stage" value="${fields.stage}"`)));
    const defaults = Object.fromEntries([...(form?.[1]||'').matchAll(/name="([^"]+)" value="([^"]*)"/g)].map(x=>[x[1],x[2]]));
    return fetch(url+'action',{method:'POST',redirect:'manual',headers:{Cookie:cookie,Origin:new URL(url).origin,'Content-Type':'application/x-www-form-urlencoded',...options.headers},body:new URLSearchParams({...defaults,csrf,digest,action,...fields})});
  }};
}
