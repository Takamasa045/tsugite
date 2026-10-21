import fs from 'node:fs/promises';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {channel} from './http.mjs';
const MODELS=new Set(['eleven_multilingual_v2','eleven_turbo_v2_5','eleven_flash_v2_5','eleven_v3']);
const SETTING=[['stability',0,1],['similarity_boost',0,1],['style',0,1],['speed',0.7,1.2]];
export function payload(task){
  const o=task.options??{},model=o.model??'eleven_multilingual_v2';
  if(typeof task.prompt!=='string'||!task.prompt.trim()||task.prompt.length>10000||typeof o.voice_id!=='string'||!/^[-a-zA-Z0-9_]{1,128}$/.test(o.voice_id)||!MODELS.has(model))throw new Error('Select a voice and a documented speech model');
  const settings={};
  for(const [key,min,max] of SETTING){
    if(o[key]===undefined)continue;
    if(!Number.isFinite(o[key])||o[key]<min||o[key]>max)throw new Error('Invalid voice setting');
    settings[key]=o[key];
  }
  if(o.use_speaker_boost!==undefined){
    if(typeof o.use_speaker_boost!=='boolean')throw new Error('Invalid speaker boost');
    settings.use_speaker_boost=o.use_speaker_boost;
  }
  if(o.language_code!==undefined&&!/^[a-z]{2}$/.test(o.language_code))throw new Error('Language code must be ISO 639-1');
  if(o.apply_text_normalization!==undefined&&!['auto','on','off'].includes(o.apply_text_normalization))throw new Error('Unsupported text normalization');
  return {
    text:task.prompt,
    model_id:model,
    ...(o.seed===undefined?{}:{seed:o.seed}),
    ...(Object.keys(settings).length?{voice_settings:settings}:{}),
    ...(o.language_code?{language_code:o.language_code}:{}),
    ...(o.apply_text_normalization?{apply_text_normalization:o.apply_text_normalization}:{})
  };
}
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
