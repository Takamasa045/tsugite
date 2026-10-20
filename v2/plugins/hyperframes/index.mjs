import fs from 'node:fs/promises';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';
import {muxSoftCaptions} from './subtitles.mjs';
// Current HyperFrames splits the executable into lazy-loaded chunks. Bind all
// runtime files to the reviewed plan, rather than just its small entry module.
async function runtimeDigest(directory){
  const hash=createHash('sha256');
  async function visit(relative=''){
    for(const entry of (await fs.readdir(path.join(directory,relative),{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){
      const name=path.join(relative,entry.name),file=path.join(directory,name);
      if(entry.isSymbolicLink())throw new Error('HyperFrames runtime must not contain symlinks');
      if(entry.isDirectory())await visit(name);
      else if(entry.isFile()){hash.update(name.split(path.sep).join('/')+'\0');hash.update(await fs.readFile(file));hash.update('\0');}
    }
  }
  await visit();return hash.digest('hex');
}
export async function runtime(){
  const cli=process.env.TSUGITE_HYPERFRAMES,gsap=process.env.TSUGITE_GSAP,browser=process.env.TSUGITE_BROWSER;
  for(const file of [cli,gsap,browser])if(!file||!path.isAbsolute(file)||!(await fs.stat(file)).isFile())throw new Error('Select existing HyperFrames CLI, GSAP and browser explicitly; no downloads are attempted');
  const pkg=JSON.parse(await fs.readFile(path.resolve(path.dirname(cli),'../package.json'),'utf8'));if(pkg.name!=='hyperframes'||pkg.version!=='0.8.173')throw new Error('This adapter requires verified HyperFrames 0.8.173');
  const digest=async file=>createHash('sha256').update(await fs.readFile(file)).digest('hex'),binary=await fs.stat(browser);
  return {version:pkg.version,cliSha256:await digest(cli),runtimeSha256:await runtimeDigest(path.resolve(path.dirname(cli),'../dist')),gsapSha256:await digest(gsap),browser:{path:await fs.realpath(browser),bytes:binary.size,modified:binary.mtimeMs}};
}
const escape=value=>String(value).replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
export function document(timeline,audioNames){
  const width=timeline.format==='9:16'?360:640,height=timeline.format==='16:9'?360:640;let cursor=0;
  const video=timeline.clips.map((clip,i)=>{const start=cursor;cursor+=clip.seconds;return `<video id="video-${i}" class="clip" src="clip-${i}.mp4" data-start="${start}" data-duration="${clip.seconds}" data-media-start="${clip.start??0}" data-track-index="0" data-volume="${clip.audio?clip.volume:0}" ${clip.audio?'':'muted'} ${clip.loop?'loop':''}></video>`;}).join('\n');
  const audio=(timeline.audio??[]).map((track,i)=>`<audio id="audio-${i}" src="${escape(audioNames[i])}" data-start="${track.start}" data-duration="${track.seconds}" data-media-start="${track.offset}" data-track-index="${i+1}" data-volume="${track.volume}" ${track.loop?'loop':''}></audio>`).join('\n');
  const burned=timeline.captionMode==='burn'?(timeline.captions??[]):[];
  const captions=burned.map((cue,i)=>`<div id="caption-${i}" class="clip caption" data-start="${cue.start}" data-duration="${cue.end-cue.start}" data-track-index="40">${escape(cue.text)}</div>`).join('\n');
  let start=0;const cues=timeline.clips.map((clip,i)=>{const from=start;start+=clip.seconds;return `tl.set('#video-${i}',{autoAlpha:1},${from}).set('#video-${i}',{autoAlpha:0},${start});`;}).join('')+burned.map((cue,i)=>`tl.set('#caption-${i}',{autoAlpha:1},${cue.start}).set('#caption-${i}',{autoAlpha:0},${cue.end});`).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><script src="gsap.min.js"></script><style>html,body{margin:0;width:${width}px;height:${height}px;background:black}#root{position:relative;width:100%;height:100%;overflow:hidden}video{position:absolute;inset:0;width:100%;height:100%;object-fit:contain}.caption{position:absolute;left:5%;right:5%;bottom:5%;color:white;background:#000a;text-align:center;white-space:pre-line;font:28px sans-serif}</style></head><body><div id="root" data-composition-id="tsugite" data-width="${width}" data-height="${height}" data-duration="${timeline.seconds}">${video}${audio}${captions}</div><script>window.__timelines=window.__timelines||{};gsap.set(".clip",{autoAlpha:0});const tl=gsap.timeline({paused:true});${cues}window.__timelines["tsugite"]=tl;</script></body></html>`;
}
export default {runtime,quote:()=>({service:'hyperframes',credits:0}),async render({timeline,inputs,audio=[],output,scratch}){
  await runtime();
  const cli=process.env.TSUGITE_HYPERFRAMES,gsap=process.env.TSUGITE_GSAP,browser=process.env.TSUGITE_BROWSER;
  for(const file of [cli,gsap,browser]){if(!file||!path.isAbsolute(file))throw new Error('Select existing HyperFrames CLI, GSAP and browser explicitly; no downloads are attempted');await fs.access(file);}
  const run=promisify(execFile),env={...process.env,HYPERFRAMES_BROWSER_PATH:browser,DO_NOT_TRACK:'1',HYPERFRAMES_NO_TELEMETRY:'1',HYPERFRAMES_NO_UPDATE_CHECK:'1',HYPERFRAMES_NO_AUTO_INSTALL:'1',HYPERFRAMES_EXTRACT_CACHE_DIR:path.join(scratch,'extract-cache')};
  const version=await run(process.execPath,[cli,'--version'],{env});if(version.stdout.trim().replace(/^v/,'')!=='0.8.173')throw new Error('This contract targets HyperFrames 0.8.173; verify another runtime separately');
  for(let i=0;i<inputs.length;i++)await fs.copyFile(inputs[i],path.join(scratch,`clip-${i}.mp4`));
  const names=audio.map((file,i)=>`audio-${i}${path.extname(file)}`);for(let i=0;i<audio.length;i++)await fs.copyFile(audio[i],path.join(scratch,names[i]));
  await fs.copyFile(gsap,path.join(scratch,'gsap.min.js'));await fs.writeFile(path.join(scratch,'index.html'),document(timeline,names));
  await run(process.execPath,[cli,'render','--output',output,'--fps',String(timeline.fps??24),'--quality','standard','--workers','1','--no-browser-gpu','--no-experimental-fast-capture','--no-best-effort'],{cwd:scratch,env,timeout:600000,maxBuffer:2000000,windowsHide:true});await muxSoftCaptions({timeline,output,scratch});return {credits:0};
}};
