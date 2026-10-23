import fs from 'node:fs/promises';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {channel} from './http.mjs';
const SPEECH=new Set(['eleven_multilingual_v2','eleven_turbo_v2_5','eleven_flash_v2_5','eleven_v3']);
const MUSIC=new Set(['music_v2_5','music_v2','music_v1']);
const SETTING=[['stability',0,1],['similarity_boost',0,1],['style',0,1],['speed',0.7,1.2]];
export function payload(task){
  const o=task.options??{},mode=o.mode??'speech';
  if(typeof task.prompt!=='string'||!task.prompt.trim()||task.prompt.length>10000)throw new Error('Select a documented ElevenLabs request');
  if(mode==='music'){
    const model=o.model??'music_v2_5';
    if(!MUSIC.has(model)||!Number.isInteger(task.seconds)||task.seconds<3||task.seconds>600)throw new Error('Select a documented music model and 3–600 second length');
    if(task.prompt.length>4100)throw new Error('Music prompt exceeds 4100 characters');
    return {prompt:task.prompt,model_id:model,music_length_ms:task.seconds*1000,...(o.force_instrumental===undefined?{}:{force_instrumental:o.force_instrumental===true})};
  }
  if(mode==='sfx'){
    const model=o.model??'eleven_text_to_sound_v2';
    if(model!=='eleven_text_to_sound_v2'||task.seconds<0.5||task.seconds>30)throw new Error('Select the documented sound-effect model and 0.5–30 second length');
    return {text:task.prompt,model_id:model,duration_seconds:task.seconds,...(o.prompt_influence===undefined?{}:{prompt_influence:o.prompt_influence}),...(o.loop===undefined?{}:{loop:o.loop===true})};
  }
  const model=o.model??'eleven_multilingual_v2';
  if(typeof o.voice_id!=='string'||!/^[-a-zA-Z0-9_]{1,128}$/.test(o.voice_id)||!SPEECH.has(model))throw new Error('Select a voice and a documented speech model');
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
export function requestTimeout(task){
  const mode=task.options?.mode??'speech';
  if(mode==='speech')return 30000;
  return Math.min(1_200_000,60_000+Math.ceil(task.seconds)*2_000);
}
async function convertMp3(settings,temporary,output){
  if(settings.convert)await settings.convert(temporary,output);
  else try{await promisify(execFile)(process.env.TSUGITE_FFMPEG||'ffmpeg',['-nostdin','-v','error','-n','-protocol_whitelist','file,pipe','-i',temporary,'-ac','1','-ar','48000','-c:a','pcm_s16le',output],{timeout:120000,windowsHide:true,maxBuffer:1000000});}catch{throw new Error('Audio received but local conversion failed; do not resubmit');}
}
async function writeAudio(settings,bytes,output){
  const temporary=path.join(path.dirname(output),path.basename(output)+'.mp3');
  try{
    await fs.writeFile(temporary,bytes,{flag:'wx'});
    await convertMp3(settings,temporary,output);
  }finally{await fs.rm(temporary,{force:true});}
}
export function createTransport(settings){
  const http=channel({...settings,header:'xi-api-key'});
  return {async make({task,output,onSubmitted}){
    const body=payload(task);if(typeof onSubmitted!=='function')throw new Error('Durable submission callback required');
    const mode=task.options?.mode??'speech';
    if(mode==='speech'){
      const r=await http.json('/v1/text-to-speech/'+encodeURIComponent(task.options.voice_id)+'/with-timestamps?output_format=mp3_44100_128',body);
      const b64=r.audio_base64;if(typeof b64!=='string'||b64.length>32*1024*1024||!b64.length||!/^[A-Za-z0-9+/]*={0,2}$/.test(b64))throw new Error('Invalid speech audio; reconcile outcome');
      await writeAudio(settings,Buffer.from(b64,'base64'),output);
      return {credits:null,alignment:r.alignment??null};
    }
    const pathName=mode==='music'?'/v1/music?output_format=mp3_44100_128':'/v1/sound-generation?output_format=mp3_44100_128';
    await writeAudio(settings,await http.binary(pathName,body,undefined,requestTimeout(task)),output);
    return {credits:null};
  }};
}
