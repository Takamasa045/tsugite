import fs from 'node:fs/promises';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {channel} from './http.mjs';
export function payload(task){const o=task.options??{};if(typeof task.prompt!=='string'||!task.prompt.trim()||task.prompt.length>10000||typeof o.voice_id!=='string'||!/^[-a-zA-Z0-9_]{1,128}$/.test(o.voice_id)||typeof(o.model??'eleven_multilingual_v2')!=='string')throw new Error('Select a voice and valid speech text');return {text:task.prompt,model_id:o.model??'eleven_multilingual_v2',...(o.seed===undefined?{}:{seed:o.seed})};}
export function createTransport(settings){
  const http=channel({...settings,header:'xi-api-key'});
  return {async make({task,output,onSubmitted}){
    const body=payload(task);if(typeof onSubmitted!=='function')throw new Error('Durable submission callback required');
    const r=await http.json('/v1/text-to-speech/'+encodeURIComponent(task.options.voice_id)+'/with-timestamps?output_format=mp3_44100_128',body);
    // This synchronous endpoint does not document final charged credits. Do
    // not invent a charge from character count or assume an idempotency API.
    const b64=r.audio_base64;if(typeof b64!=='string'||b64.length>32*1024*1024||!b64.length||!/^[A-Za-z0-9+/]*={0,2}$/.test(b64))throw new Error('Invalid speech audio; reconcile outcome');
    const temporary=path.join(path.dirname(output),path.basename(output)+'.mp3');await fs.writeFile(temporary,Buffer.from(b64,'base64'),{flag:'wx'});
    if(settings.convert)await settings.convert(temporary,output);else try{await promisify(execFile)(process.env.TSUGITE_FFMPEG||'ffmpeg',['-nostdin','-v','error','-n','-protocol_whitelist','file,pipe','-i',temporary,'-ac','1','-ar','48000','-c:a','pcm_s16le',output],{timeout:120000,windowsHide:true,maxBuffer:1000000});}catch{throw new Error('Speech received but local conversion failed; do not resubmit');}
    return {credits:null,alignment:r.alignment??null};
  }};
}
