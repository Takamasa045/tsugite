import fs from 'node:fs/promises';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const escape=value=>String(value).replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
export function document(timeline,audioNames){
  const width=timeline.format==='9:16'?360:640,height=timeline.format==='16:9'?360:640;let cursor=0;
  const video=timeline.clips.map((clip,i)=>{const start=cursor;cursor+=clip.seconds;return `<video id="video-${i}" class="clip" src="clip-${i}.mp4" data-start="${start}" data-duration="${clip.seconds}" data-media-start="${clip.start??0}" data-track-index="0" data-volume="${clip.audio?clip.volume:0}" ${clip.audio?'':'muted'} ${clip.loop?'loop':''}></video>`;}).join('\n');
  const audio=(timeline.audio??[]).map((track,i)=>`<audio id="audio-${i}" src="${escape(audioNames[i])}" data-start="${track.start}" data-duration="${track.seconds}" data-media-start="${track.offset}" data-track-index="${i+1}" data-volume="${track.volume}" ${track.loop?'loop':''}></audio>`).join('\n');
  const captions=(timeline.captions??[]).map((cue,i)=>`<div id="caption-${i}" class="clip caption" data-start="${cue.start}" data-duration="${cue.end-cue.start}" data-track-index="40">${escape(cue.text)}</div>`).join('\n');
  return `<!doctype html><html><head><meta charset="utf-8"><script src="gsap.min.js"></script><style>html,body{margin:0;width:${width}px;height:${height}px;background:black}#root{position:relative;width:100%;height:100%;overflow:hidden}video{position:absolute;inset:0;width:100%;height:100%;object-fit:contain}.caption{position:absolute;left:5%;right:5%;bottom:5%;color:white;background:#000a;text-align:center;white-space:pre-line;font:28px sans-serif}</style></head><body><div id="root" data-composition-id="tsugite" data-width="${width}" data-height="${height}" data-duration="${timeline.seconds}">${video}${audio}${captions}</div><script>window.__timelines["tsugite"]=gsap.timeline({paused:true});</script></body></html>`;
}
export default {quote:()=>({service:'hyperframes',credits:0}),async render({timeline,inputs,audio=[],output,scratch}){
  const cli=process.env.TSUGITE_HYPERFRAMES,gsap=process.env.TSUGITE_GSAP,browser=process.env.TSUGITE_BROWSER;
  for(const file of [cli,gsap,browser]){if(!file||!path.isAbsolute(file))throw new Error('Select existing HyperFrames CLI, GSAP and browser explicitly; no downloads are attempted');await fs.access(file);}
  const run=promisify(execFile),env={...process.env,HYPERFRAMES_BROWSER_PATH:browser,DO_NOT_TRACK:'1'};
  const version=await run(process.execPath,[cli,'--version'],{env});if(version.stdout.trim().replace(/^v/,'')!=='0.8.24')throw new Error('This contract targets HyperFrames 0.8.24; verify another runtime separately');
  for(let i=0;i<inputs.length;i++)await fs.copyFile(inputs[i],path.join(scratch,`clip-${i}.mp4`));
  const names=audio.map((file,i)=>`audio-${i}${path.extname(file)}`);for(let i=0;i<audio.length;i++)await fs.copyFile(audio[i],path.join(scratch,names[i]));
  await fs.copyFile(gsap,path.join(scratch,'gsap.min.js'));await fs.writeFile(path.join(scratch,'index.html'),document(timeline,names));
  await run(process.execPath,[cli,'render','--output',output,'--fps',String(timeline.fps??24),'--quality','standard'],{cwd:scratch,env,timeout:600000,maxBuffer:2000000,windowsHide:true});return {credits:0};
}};
