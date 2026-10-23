import {createTransport,payload} from './transport.mjs';
import definition from './contract.json' with {type:'json'};
const OPTION_KEYS=['model','aspect','quality','seed','voice_id','max_credits','stability','similarity_boost','style','speed','use_speaker_boost','language_code','apply_text_normalization','mode','force_instrumental','prompt_influence','loop'];
const SPEECH=['stability','similarity_boost','style','speed','use_speaker_boost','language_code','apply_text_normalization'];
export function request(task) {
  if(typeof task.prompt!=='string'||!task.prompt.trim()||!Number.isFinite(task.seconds)||task.seconds<=0)throw new Error('Invalid source request');
  if((task.kind??'video')!==definition.kind)throw new Error('Unsupported media kind');
  const options=task.options??{};
  if(!options||typeof options!=='object'||Array.isArray(options)||Object.keys(options).some(k=>!OPTION_KEYS.includes(k)))throw new Error('Unsupported source options (credentials never belong in a project)');
  for(const key of ['model','voice_id'])if(options[key]!==undefined&&(typeof options[key]!=='string'||!options[key].trim()||options[key].length>128))throw new Error('Invalid model or voice identity');
  if(options.max_credits!==undefined&&(!Number.isFinite(options.max_credits)||options.max_credits<0))throw new Error('Invalid service credit maximum');
  if(options.aspect&&!['16:9','9:16','1:1'].includes(options.aspect))throw new Error('Unsupported aspect');
  if(options.seed!==undefined&&(!Number.isInteger(options.seed)||options.seed<0||options.seed>4294967295))throw new Error('Invalid seed');
  const mode=options.mode??'speech';
  if(!['speech','music','sfx'].includes(mode))throw new Error('Unsupported ElevenLabs mode');
  if(mode==='speech'){
    if(definition.kind==='audio'&&typeof options.voice_id!=='string')throw new Error('Choose a voice_id explicitly');
    if(options.force_instrumental!==undefined||options.prompt_influence!==undefined||options.loop!==undefined)throw new Error('Speech does not take music or sound-effect options');
  }else{
    if(options.voice_id)throw new Error('Music and sound effects do not take a voice_id');
    if(SPEECH.some(key=>options[key]!==undefined))throw new Error('Music and sound effects do not take speech voice settings');
  }
  if(mode==='music'){
    if(!Number.isInteger(task.seconds)||task.seconds<3||task.seconds>600)throw new Error('Music length must be 3–600 seconds');
    if(task.prompt.length>4100)throw new Error('Music prompt exceeds 4100 characters');
    if(options.force_instrumental!==undefined&&typeof options.force_instrumental!=='boolean')throw new Error('Invalid instrumental switch');
    if(options.seed!==undefined)throw new Error('Music seed cannot be combined with a prompt');
    if(options.prompt_influence!==undefined||options.loop!==undefined)throw new Error('Music does not take sound-effect options');
  }
  if(mode==='sfx'){
    if(task.seconds<0.5||task.seconds>30)throw new Error('Sound effects must be 0.5–30 seconds');
    if(options.prompt_influence!==undefined&&(!Number.isFinite(options.prompt_influence)||options.prompt_influence<0||options.prompt_influence>1))throw new Error('Prompt influence must be 0–1');
    if(options.loop!==undefined&&typeof options.loop!=='boolean')throw new Error('Invalid sound-effect loop');
    if(options.force_instrumental!==undefined||options.seed!==undefined)throw new Error('Sound effects do not take music options');
  }
  if(mode==='speech'&&definition.durations&&!definition.durations.includes(task.seconds))throw new Error('Unsupported duration');
  return {service:definition.id,kind:definition.kind,prompt:task.prompt,seconds:task.seconds,options};
}
// This is the Tsugite receipt contract, not an undocumented upstream payload.
export function reconcile(receipt) {
  if(!receipt||typeof receipt.provider_job_id!=='string'||!['pending','completed','failed','unknown'].includes(receipt.status))throw new Error('Invalid provider receipt');
  const known=Number.isFinite(receipt.credits_charged)&&receipt.credits_charged>=0;
  return {providerJobId:receipt.provider_job_id,status:receipt.status,actualCredits:known?receipt.credits_charged:null,releaseReservation:receipt.status==='failed'&&known&&receipt.credits_charged===0};
}
export function normalize(task,{format='16:9',defaults={}}={}){
  const mode=task.options?.mode??defaults.mode??'speech';
  const model=mode==='music'?'music_v2_5':mode==='sfx'?'eleven_text_to_sound_v2':'eleven_multilingual_v2';
  const options={model,...defaults,...task.options,mode};
  const track=mode==='sfx'?'sfx':mode==='music'?'bgm':'narration';
  if(task.track!==undefined&&task.track!==track)throw new Error('Audio track does not match ElevenLabs mode');
  const value={...task,options,track};request(value);payload(value);return value;
}
const implementation={normalize,quote(task){const t=normalize(task),maximum=t.options.max_credits;if(!Number.isFinite(maximum)||maximum<=0)throw new Error('An explicit positive provider credit maximum is required');return {service:'elevenlabs',credits:maximum};},connect(connection){if(connection.transport==='cli')throw new Error('This plugin has no CLI subscription connection');return {...implementation,async make(args){return createTransport({...connection,key:connection.credential(),fetch:globalThis.fetch}).make(args);}};},async make(){throw new Error('Live execution is disabled without an explicit configured connection');}};
export default implementation;
