import fs from 'node:fs/promises';
export function compile(selection){
  if(selection?.version!==1||!Array.isArray(selection.segments)||!selection.segments.length||selection.segments.length>100||!['16:9','9:16','1:1'].includes(selection.format??'16:9'))throw new Error('Invalid edit selection');
  const use=selection.segments.map(segment=>{
    if(typeof segment.path!=='string'||!segment.path.startsWith('assets/')||segment.path.includes('\\')||segment.path.split('/').some(x=>x==='..'||x==='.')||!Number.isFinite(segment.start)||segment.start<0||!Number.isFinite(segment.end)||segment.end<=segment.start||segment.end>3600||segment.audio!==undefined&&typeof segment.audio!=='boolean')throw new Error('Invalid selected clip range');
    return {path:segment.path,start:segment.start,seconds:segment.end-segment.start,audio:segment.audio??false};
  });
  return {version:2,name:selection.name??'Edited video',format:selection.format??'16:9',length:use.reduce((s,c)=>s+c.seconds,0),use,export:'local',budget:{}};
}
export default {quote:()=>({service:'local',credits:0}),analyze:async({input})=>({format:'project-proposal',project:compile(JSON.parse(await fs.readFile(input,'utf8'))),applied:false})};
