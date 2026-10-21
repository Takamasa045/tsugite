import {createTransport,payload} from './transport.mjs';
import definition from './contract.json' with {type:'json'};
const OPTION_KEYS=['model','aspect','quality','seed','voice_id','max_credits','mode','audio'];
const MODES=['text','image','transition','extend','upscale','modify','reference'];
const GENERATE=['text','image','transition','extend','reference'];
const RATES={off:{'360p':5,'540p':7,'720p':9,'1080p':18},on:{'360p':7,'540p':9,'720p':12,'1080p':23}};
const MODIFY={'360p':8,'540p':10,'720p':12};
export function inputPath(value){return typeof value==='string'?value:value?.path;}
export function imageInput(value){
  const media=inputPath(value);
  if(typeof media!=='string'||!media.startsWith('assets/')||media.includes('..')||!/\.(png|jpe?g|webp)$/i.test(media))throw new Error('Image source must be a local PNG, JPEG or WebP under assets/');
  return media;
}
export function videoInput(value){
  const media=inputPath(value);
  if(typeof media!=='string'||!media.startsWith('assets/')||media.includes('..')||!/\.(mp4|mov|webm)$/i.test(media))throw new Error('Video source must be a local MP4, MOV or WebM under assets/');
  return media;
}
function mediaBytes(file,limit,label){
  if(typeof file==='object'&&Number.isFinite(file.bytes)&&file.bytes>limit)throw new Error(label);
}
function sourceSeconds(file){return typeof file==='object'&&Number.isFinite(file.seconds)?file.seconds:null;}
export function request(task) {
  if(typeof task.prompt!=='string'||!task.prompt.trim()||!Number.isFinite(task.seconds)||task.seconds<=0)throw new Error('Invalid source request');
  if((task.kind??'video')!==definition.kind)throw new Error('Unsupported media kind');
  const options=task.options??{};
  if(!options||typeof options!=='object'||Array.isArray(options)||Object.keys(options).some(k=>!OPTION_KEYS.includes(k)))throw new Error('Unsupported source options (credentials never belong in a project)');
  for(const key of ['model','voice_id'])if(options[key]!==undefined&&(typeof options[key]!=='string'||!options[key].trim()||options[key].length>128))throw new Error('Invalid model or voice identity');
  if(options.max_credits!==undefined&&(!Number.isFinite(options.max_credits)||options.max_credits<0))throw new Error('Invalid service credit maximum');
  if(options.aspect&&!['16:9','9:16','1:1'].includes(options.aspect))throw new Error('Unsupported aspect');
  if(options.seed!==undefined&&(!Number.isInteger(options.seed)||options.seed<0||options.seed>2147483647))throw new Error('Invalid seed');
  if(options.audio!==undefined&&typeof options.audio!=='boolean')throw new Error('Invalid audio switch');
  const mode=options.mode??'text';
  if(!MODES.includes(mode))throw new Error('Unsupported PixVerse mode');
  if(options.audio&&!['text','image','transition','reference'].includes(mode))throw new Error('This PixVerse mode does not generate audio');
  if(mode==='modify'&&options.quality&&!MODIFY[options.quality])throw new Error('Modify does not support 1080p');
  const files=task.inputs??[];
  if(mode==='text'&&files.length)throw new Error('Text generation does not take local media inputs');
  if(mode==='image'){if(files.length!==1)throw new Error('Image-to-video needs exactly one local image input');imageInput(files[0]);}
  if(mode==='transition'){if(files.length!==2)throw new Error('Transition needs first and last local image inputs');files.forEach(imageInput);}
  if(mode==='extend'||mode==='upscale'){if(files.length!==1)throw new Error('This PixVerse mode needs exactly one local video input');videoInput(files[0]);}
  if(mode==='modify'){
    if(!files.length||files.length>4)throw new Error('Modify needs one local video and up to three optional images');
    videoInput(files[0]);files.slice(1).forEach(imageInput);
  }
  if(mode==='reference'){
    if(!files.length||files.length>8)throw new Error('Reference-to-video needs 1–8 local image inputs');
    files.forEach(imageInput);
  }
  for(const file of files){
    if(/\.(png|jpe?g|webp)$/i.test(inputPath(file))){
      imageInput(file);
      mediaBytes(file,20*1024*1024,'PixVerse image exceeds the 20 MB upload limit');
    }else{
      videoInput(file);
      mediaBytes(file,32*1024*1024,'PixVerse video exceeds the 32 MB planning limit');
    }
  }
  if(GENERATE.includes(mode)&&definition.durations&&!definition.durations.includes(task.seconds))throw new Error('Unsupported duration');
  if((mode==='upscale'||mode==='modify')&&(!Number.isInteger(task.seconds)||task.seconds<1||task.seconds>30))throw new Error('Unsupported duration');
  const source=sourceSeconds(files[0]);
  if(mode==='extend'&&source!==null&&(source>30||source+task.seconds>40))throw new Error('Extended video would exceed the 40 second source limit');
  if((mode==='upscale'||mode==='modify')&&source!==null){
    if(source<=0||source>30)throw new Error('Source video exceeds the 30 second limit');
    if(task.seconds>source+0.02)throw new Error('Requested duration exceeds the source video');
  }
  if(mode==='upscale'){
    const file=files[0],width=typeof file==='object'?file.width:undefined,height=typeof file==='object'?file.height:undefined;
    if((Number.isInteger(width)&&width>=3840)||(Number.isInteger(height)&&height>=2160))throw new Error('Already-4K sources are not submitted');
  }
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
function estimate(task){
  const t=normalize(task),mode=t.options.mode??'text',source=sourceSeconds((t.inputs??[])[0]);
  if(mode==='upscale'){
    if(!Number.isFinite(source)||source<=0)throw new Error('Upscale needs a finite local video duration');
    return 5*Math.ceil(source);
  }
  if(mode==='modify'){
    if(!Number.isFinite(source)||source<=0)throw new Error('Modify needs a finite local video duration');
    const rate=MODIFY[t.options.quality];if(!rate)throw new Error('Modify does not support 1080p');
    return rate*Math.ceil(source);
  }
  return RATES[t.options.audio?'on':'off'][t.options.quality]*t.seconds;
}
const implementation={normalize,quote(task){const expected=estimate(task),maximum=normalize(task).options.max_credits??expected;if(maximum<expected)throw new Error('Credit maximum is below the documented estimate');return {service:'pixverse',credits:maximum,estimate:expected,pricingAsOf:'2026-10-18'};},connect(connection){return {...implementation,async make(args){return createTransport({...connection,key:connection.credential(),fetch:globalThis.fetch}).make(args);}};},async make(){throw new Error('Live execution is disabled without an explicit configured connection');}};
export default implementation;
