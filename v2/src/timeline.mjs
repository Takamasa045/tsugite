import {fail,inside,fileHash,read} from './files.mjs';
import {probe} from '../plugins/local/index.mjs';

const number=(value,min,max,label)=>{if(!Number.isFinite(value)||value<min||value>max)fail('Invalid '+label);return value;};
const asset=async(root,p)=>{if(typeof p!=='string'||!p.startsWith('assets/'))fail('Media must be inside assets/');return inside(root,p);};
export async function inputClips(root,use) {
  const result=[];
  for(let i=0;i<use.length;i++){
    const value=use[i],c=typeof value==='string'?{path:value,loop:true}:value;
    if(!c||Object.keys(c).some(k=>!['path','start','seconds','loop','audio','volume'].includes(k)))fail('Invalid local clip');
    const metadata=await probe(await asset(root,c.path));
    const start=number(c.start??0,0,metadata.seconds,'clip start');
    if(c.seconds!==undefined)number(c.seconds,0.001,3600,'clip seconds');
    if(c.audio!==undefined&&typeof c.audio!=='boolean'||c.loop!==undefined&&typeof c.loop!=='boolean')fail('Invalid clip flags');
    if(c.audio&&!metadata.hasAudio)fail('Clip has no requested source audio');
    result.push({id:`input-${i}`,path:c.path,hash:await fileHash(root,c.path),...metadata,start,duration:c.seconds??null,loop:c.loop??false,audio:c.audio??false,volume:number(c.volume??1,0,4,'clip volume')});
  }
  return result;
}
export async function audioTracks(root,audio,total) {
  if(!Array.isArray(audio)||audio.length>32)fail('Audio must be a list of up to 32 tracks');
  const tracks=[];
  for(let i=0;i<audio.length;i++){
    const a=audio[i];if(!a||Object.keys(a).some(k=>!['path','start','offset','seconds','volume','loop','kind'].includes(k)))fail('Invalid audio track');
    const metadata=await probe(await asset(root,a.path),'audio');
    const start=number(a.start??0,0,total,'audio start'),offset=number(a.offset??0,0,metadata.seconds,'audio offset');
    const seconds=number(a.seconds??Math.min(metadata.seconds-offset,total-start),0.001,total-start,'audio seconds');
    if(a.loop!==undefined&&typeof a.loop!=='boolean')fail('Invalid audio loop');
    if(!a.loop&&seconds>metadata.seconds-offset+0.02)fail('Audio exceeds source duration');
    if(!['bgm','narration','sfx'].includes(a.kind??'bgm'))fail('Invalid audio kind');
    tracks.push({id:`audio-${i}`,path:a.path,hash:await fileHash(root,a.path),start,offset,seconds,volume:number(a.volume??1,0,4,'audio volume'),loop:a.loop??false,kind:a.kind??'bgm'});
  }
  return tracks;
}
const stamp=text=>{const match=text.match(/^(\d{2,}):(\d{2}):(\d{2})[,.](\d{3})$/);if(!match||Number(match[2])>59||Number(match[3])>59)fail('Invalid subtitle timestamp');return Number(match[1])*3600+Number(match[2])*60+Number(match[3])+Number(match[4])/1000;};
export function parseSRT(text) {
  return text.replace(/^\uFEFF/,'').replace(/\r/g,'').trim().split(/\n\s*\n/).filter(Boolean).map(block=>{
    const lines=block.split('\n');if(/^\d+$/.test(lines[0]))lines.shift();
    const times=lines.shift()?.split(/\s+-->\s+/);if(times?.length!==2)fail('Invalid SRT cue');
    return {start:stamp(times[0]),end:stamp(times[1]),text:lines.join('\n')};
  });
}
export async function captions(root,value,total) {
  let entries=value??[],source=null;
  if(typeof entries==='string'){
    if(!entries.endsWith('.srt'))fail('Subtitle file must be SRT');await asset(root,entries);
    source={path:entries,hash:await fileHash(root,entries)};entries=parseSRT(await read(root,entries));
  }
  if(!Array.isArray(entries)||entries.length>10000)fail('Invalid captions');
  for(const c of entries){
    if(!c||Object.keys(c).some(k=>!['start','end','text'].includes(k))||typeof c.text!=='string'||!c.text.trim()||c.text.length>2000)fail('Invalid caption');
    number(c.start,0,total,'caption start');number(c.end,c.start+0.001,total+0.02,'caption end');
  }
  return {entries,source};
}
export function arrange(inputs,tasks,total) {
  const videos=tasks.filter(t=>t.kind!=='audio');
  const fixed=inputs.reduce((s,c)=>s+(c.duration??0),0)+videos.reduce((s,t)=>s+t.seconds,0),flex=inputs.filter(c=>c.duration===null).length;
  if(fixed>total+0.001||(!flex&&Math.abs(fixed-total)>0.02))fail('Authored clip durations must fit requested length');
  const per=flex?(total-fixed)/flex:0;if(flex&&per<=0)fail('No time remains for local clips');
  const clips=inputs.map(c=>{
    const seconds=c.duration??per;if(!c.loop&&c.start+seconds>c.seconds+0.02)fail('Clip trim exceeds source duration');
    return {id:c.id,path:c.path,hash:c.hash,seconds,start:c.start,loop:c.loop,audio:c.audio,volume:c.volume};
  });
  for(const task of videos)clips.push({id:task.id,path:`.tsugite/media/${task.key}.mp4`,seconds:task.seconds,start:0,loop:false,audio:false,volume:1,taskKey:task.key});
  if(!clips.length)fail('Timeline needs at least one video clip');
  return clips;
}
