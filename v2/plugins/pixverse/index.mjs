import {createTransport,payload} from './transport.mjs';
import definition from './contract.json' with {type:'json'};
const OPTION_KEYS=['model','aspect','quality','seed','voice_id','max_credits','mode','audio'];
export function inputPath(value){return typeof value==='string'?value:value?.path;}
export function imageInput(value){
  const media=inputPath(value);
  if(typeof media!=='string'||!media.startsWith('assets/')||media.includes('..')||!/\.(png|jpe?g|webp)$/i.test(media))throw new Error('Image source must be a local PNG, JPEG or WebP under assets/');
  return media;
}
export function request(task) {
  if(typeof task.prompt!=='string'||!task.prompt.trim()||!Number.isFinite(task.seconds)||task.seconds<=0)throw new Error('Invalid source request');
  if((task.kind??'video')!==definition.kind)throw new Error('Unsupported media kind');
  if(definition.durations&&!definition.durations.includes(task.seconds))throw new Error('Unsupported duration');
  const options=task.options??{};
  if(!options||typeof options!=='object'||Array.isArray(options)||Object.keys(options).some(k=>!OPTION_KEYS.includes(k)))throw new Error('Unsupported source options (credentials never belong in a project)');
  for(const key of ['model','voice_id'])if(options[key]!==undefined&&(typeof options[key]!=='string'||!options[key].trim()||options[key].length>128))throw new Error('Invalid model or voice identity');
  if(options.max_credits!==undefined&&(!Number.isFinite(options.max_credits)||options.max_credits<0))throw new Error('Invalid service credit maximum');
  if(options.aspect&&!['16:9','9:16','1:1'].includes(options.aspect))throw new Error('Unsupported aspect');
  if(options.seed!==undefined&&(!Number.isInteger(options.seed)||options.seed<0||options.seed>2147483647))throw new Error('Invalid seed');
  if(options.audio!==undefined&&typeof options.audio!=='boolean')throw new Error('Invalid audio switch');
  const mode=options.mode??'text';
  if(!['text','image','transition'].includes(mode))throw new Error('Unsupported PixVerse mode');
  const files=task.inputs??[];
  if(mode==='text'&&files.length)throw new Error('Text generation does not take local media inputs');
  if(mode==='image'){if(files.length!==1)throw new Error('Image-to-video needs exactly one local image input');imageInput(files[0]);}
  if(mode==='transition'){if(files.length!==2)throw new Error('Transition needs first and last local image inputs');files.forEach(imageInput);}
  if(definition.kind==='audio'&&typeof options.voice_id!=='string')throw new Error('Choose a voice_id explicitly');
  return {service:definition.id,kind:definition.kind,prompt:task.prompt,seconds:task.seconds,options};
}
// This is the Tsugite receipt contract, not an undocumented upstream payload.
export function reconcile(receipt) {
  if(!receipt||typeof receipt.provider_job_id!=='string'||!['pending','completed','failed','unknown'].includes(receipt.status))throw new Error('Invalid provider receipt');
  const known=Number.isFinite(receipt.credits_charged)&&receipt.credits_charged>=0;
  return {providerJobId:receipt.provider_job_id,status:receipt.status,actualCredits:known?receipt.credits_charged:null,releaseReservation:receipt.status==='failed'&&known&&receipt.credits_charged===0};
}
export function normalize(task,{format='16:9',defaults={}}={}){const options={model:'v6',quality:'360p',aspect:format,mode:'text',...defaults,...task.options};const value={...task,options};request(value);payload(value);return value;}
const implementation={normalize,quote(task){const t=normalize(task),expected=({'360p':5,'540p':7,'720p':9,'1080p':18})[t.options.quality]*t.seconds,maximum=t.options.max_credits??expected;if(maximum<expected)throw new Error('Credit maximum is below the documented estimate');return {service:'pixverse',credits:maximum,estimate:expected,pricingAsOf:'2026-10-18'};},connect(connection){return {...implementation,async make(args){return createTransport({...connection,key:connection.credential(),fetch:globalThis.fetch}).make(args);}};},async make(){throw new Error('Live execution is disabled without an explicit configured connection');}};
export default implementation;
