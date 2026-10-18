import fs from 'node:fs/promises';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

// Kept inside each standalone renderer package; no implicit core/v1 dependency.
export async function muxSoftCaptions({timeline,output,scratch}){
  if(timeline.captionMode==='burn'||!timeline.captions?.length)return;
  const stamp=seconds=>{const ms=Math.round(seconds*1000);return `${String(Math.floor(ms/3600000)).padStart(2,'0')}:${String(Math.floor(ms/60000)%60).padStart(2,'0')}:${String(Math.floor(ms/1000)%60).padStart(2,'0')},${String(ms%1000).padStart(3,'0')}`;};
  const captions=path.join(scratch,'soft-captions.srt'),muxed=path.join(scratch,'soft-captioned.mp4');
  await fs.writeFile(captions,timeline.captions.map((cue,i)=>`${i+1}\n${stamp(cue.start)} --> ${stamp(cue.end)}\n${cue.text}\n`).join('\n'));
  await promisify(execFile)(process.env.TSUGITE_FFMPEG||'ffmpeg',['-nostdin','-v','error','-n','-protocol_whitelist','file,pipe','-i',output,'-protocol_whitelist','file,pipe','-f','srt','-i',captions,'-map','0:v:0','-map','0:a?','-map','1:0','-c','copy','-c:s','mov_text','-disposition:s:0','default','-movflags','+faststart',muxed],{timeout:120000,maxBuffer:2000000,windowsHide:true});
  await fs.rename(muxed,output);
}
