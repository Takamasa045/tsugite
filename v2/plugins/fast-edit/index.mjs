import fs from 'node:fs/promises';
import path from 'node:path';
import renderer from './renderer.mjs';
import {validate} from './validate.mjs';
import {synthesizeSfx} from './sfx.mjs';
export function compile(selection){
  if(selection?.version!==1||Object.keys(selection).some(k=>!['version','segments','format','name','fast_edit'].includes(k))||selection.name!==undefined&&(typeof selection.name!=='string'||!selection.name.trim()||selection.name.length>200)||!Array.isArray(selection.segments)||!selection.segments.length||selection.segments.length>100||!['16:9','9:16','1:1'].includes(selection.format??'16:9'))throw new Error('Invalid edit selection');
  const use=selection.segments.map(segment=>{
    if(Object.keys(segment).some(k=>!['path','start','end','audio'].includes(k))||typeof segment.path!=='string'||!segment.path.startsWith('assets/')||segment.path.includes('\\')||segment.path.split('/').some(x=>x==='..'||x==='.')||!Number.isFinite(segment.start)||segment.start<0||!Number.isFinite(segment.end)||segment.end<=segment.start||segment.end>3600||segment.audio!==undefined&&typeof segment.audio!=='boolean')throw new Error('Invalid selected clip range');
    return {path:segment.path,start:segment.start,seconds:segment.end-segment.start,audio:segment.audio??false};
  });
  const length=use.reduce((s,c)=>s+c.seconds,0);if(selection.fast_edit)validate(selection.fast_edit,length);
  return {version:2,name:selection.name??'Edited video',format:selection.format??'16:9',length,use,export:selection.fast_edit?'fast-edit':'local',...(selection.fast_edit?{renderer_options:selection.fast_edit}:{}),budget:{}};
}
export default {quote:()=>({service:'local',credits:0}),supportsOptions:true,migrateLegacy:validate,runtime:renderer.runtime,validate:timeline=>validate(timeline.rendererOptions,timeline.seconds),analyze:async({input})=>({format:'project-proposal',project:compile(JSON.parse(await fs.readFile(input,'utf8'))),applied:false}),async render(args){
  validate(args.timeline.rendererOptions,args.timeline.seconds);const timeline=structuredClone(args.timeline),audio=[...(args.audio??[])];
  for(const beat of timeline.rendererOptions.beats)if(beat.edit.sfx!=='none'){const file=path.join(args.scratch,beat.id+'.wav');await fs.writeFile(file,synthesizeSfx(beat.edit.sfx),{flag:'wx'});audio.push(file);timeline.audio.push({id:'fe-'+beat.id,start:beat.start,seconds:Math.min(0.32,timeline.seconds-beat.start),offset:0,volume:1,loop:false});}
  return renderer.render({...args,timeline,audio});
}};
