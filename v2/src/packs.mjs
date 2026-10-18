import fs from 'node:fs/promises';
import path from 'node:path';
import {stringify,parse} from 'yaml';
import {currentPlan,init} from './core.mjs';
import {write,fail,read,inside,exists,locked} from './files.mjs';
export async function template(root){
  const {plan:p}=await currentPlan(root);
  return {version:1,kind:'template',name:p.name,format:p.format,seconds:p.seconds,fps:p.timeline.fps,slots:p.timeline.clips.map((c,i)=>({id:`slot-${i}`,seconds:c.seconds})),captions:p.timeline.captions};
}
export async function initTemplate(destination,pack){
  if(!pack||pack.version!==1||pack.kind!=='template'||!['16:9','9:16','1:1'].includes(pack.format)||!Number.isFinite(pack.seconds)||pack.seconds<=0||pack.seconds>3600||!Array.isArray(pack.slots)||!pack.slots.length||pack.slots.length>100)fail('Invalid template pack');
  if(!Number.isInteger(pack.fps)||pack.fps<1||pack.fps>60||pack.slots.some(c=>!Number.isFinite(c.seconds)||c.seconds<=0)||Math.abs(pack.slots.reduce((s,c)=>s+c.seconds,0)-pack.seconds)>0.02)fail('Template timing is inconsistent');
  if(!Array.isArray(pack.captions)||pack.captions.some(c=>typeof c.text!=='string'||!Number.isFinite(c.start)||!Number.isFinite(c.end)||c.start<0||c.end<=c.start||c.end>pack.seconds))fail('Invalid template captions');
  // Ignore all path/provider fields: templates are timing slots, never executable
  // code, credentials, approval records or an implicit generation instruction.
  await init(destination);
  await write(destination,'tsugite.yaml',stringify({version:2,name:typeof pack.name==='string'?pack.name.slice(0,200):'Template video',format:pack.format,length:pack.seconds,fps:pack.fps,use:pack.slots.map(c=>({path:'assets/intro.mp4',seconds:c.seconds,loop:true})),captions:pack.captions,export:'local',budget:{},checks:{auto_clips:true}}));
  return {project:destination,template:true,slots:pack.slots.length};
}
export async function installSkill(destination){
  const source=new URL('../skills/tsugite/SKILL.md',import.meta.url);
  await fs.mkdir(path.join(destination,'tsugite'),{recursive:true});
  await fs.copyFile(source,path.join(destination,'tsugite/SKILL.md'),fs.constants.COPYFILE_EXCL);
  return {installed:path.join(destination,'tsugite/SKILL.md'),scope:'only the explicitly selected client skills directory'};
}
export async function addKnowledge(root,source){
  return locked(root,async()=>{
    let text,name;
    const bundled=/^[a-z][a-z0-9-]{0,63}$/.test(source)?new URL(`../packs/knowledge/${source}.md`,import.meta.url):null;
    if(bundled&&await exists(bundled)){text=await fs.readFile(bundled,'utf8');name=source+'.md';}
    else {if(!source.endsWith('.md'))fail('Knowledge pack must be Markdown');text=await fs.readFile(source,'utf8');name=path.basename(source);}
    if(Buffer.byteLength(text)>256000)fail('Knowledge pack too large');
    const relative='knowledge/'+name;if(await exists(await inside(root,relative)))fail('Knowledge pack already exists');
    const c=parse(await read(root,'tsugite.yaml'),{maxAliasCount:0});if(!c||typeof c!=='object')fail('Invalid project');c.knowledge??=[];if(!Array.isArray(c.knowledge))fail('Invalid knowledge list');c.knowledge.push(relative);
    await write(root,relative,text);await write(root,'tsugite.yaml',stringify(c));return {installed:relative,next:'Create and review a new plan'};
  });
}
