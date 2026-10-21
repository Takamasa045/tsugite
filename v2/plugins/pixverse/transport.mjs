import {randomUUID} from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {channel,jobId} from './http.mjs';
const IMAGE_TYPE={'.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp'};
const VIDEO_TYPE={'.mp4':'video/mp4','.mov':'video/quicktime','.webm':'video/webm'};
const GENERATE=['text','image','transition','extend','reference'];
const QUALITY=['360p','540p','720p','1080p'];
export function payload(task){
  const o=task.options??{},model=o.model??'v6',quality=o.quality??'360p',aspect=o.aspect??'16:9',mode=o.mode??'text';
  if(model!=='v6'||typeof task.prompt!=='string'||!task.prompt.trim())throw new Error('Unsupported PixVerse V6 request');
  if(mode==='upscale'){
    if(!Number.isInteger(task.seconds)||task.seconds<1||task.seconds>30)throw new Error('Unsupported PixVerse V6 request');
    return {prompt:task.prompt};
  }
  if(mode==='modify'){
    if(!Number.isInteger(task.seconds)||task.seconds<1||task.seconds>30||!['360p','540p','720p'].includes(quality))throw new Error('Unsupported PixVerse V6 request');
    return {prompt:task.prompt,quality};
  }
  if(!GENERATE.includes(mode)||!Number.isInteger(task.seconds)||task.seconds<1||task.seconds>15||!QUALITY.includes(quality)||!['16:9','9:16','1:1'].includes(aspect))throw new Error('Unsupported PixVerse V6 request');
  return {model,prompt:task.prompt,duration:task.seconds,quality,...(o.seed===undefined?{}:{seed:o.seed})};
}
export function liveBody(task,ids=[]){
  const body=payload(task),mode=task.options?.mode??'text';
  const audio=task.options?.audio===true;
  if(mode==='text')return {...body,aspect_ratio:task.options?.aspect??'16:9',...(task.options?.audio===undefined?{}:{generate_audio_switch:audio})};
  if(mode==='image'){
    if(ids.length!==1)throw new Error('Image-to-video needs an uploaded image id');
    return {...body,img_id:Number(ids[0]),generate_audio_switch:task.options?.audio===true};
  }
  if(mode==='transition'){
    if(ids.length!==2)throw new Error('Transition needs uploaded first and last image ids');
    return {...body,first_frame_img:Number(ids[0]),last_frame_img:Number(ids[1]),generate_audio_switch:task.options?.audio===true};
  }
  if(mode==='extend'){
    if(ids.length!==1)throw new Error('Extend needs an uploaded video id');
    return {...body,video_media_id:Number(ids[0])};
  }
  if(mode==='upscale'){
    if(ids.length!==1)throw new Error('Upscale needs an uploaded video id');
    return {video_media_id:Number(ids[0])};
  }
  if(mode==='modify'){
    if(!ids.length)throw new Error('Modify needs an uploaded video id');
    return {...body,video_media_id:Number(ids[0]),...(ids.length>1?{img_ids:ids.slice(1).map(Number)}:{})};
  }
  if(!ids.length)throw new Error('Reference-to-video needs uploaded image ids');
  return {...body,aspect_ratio:task.options?.aspect??'16:9',image_references:ids.map(id=>({img_id:Number(id)})),...(task.options?.audio===undefined?{}:{generate_audio_switch:audio})};
}
export function generatePath(task){
  const mode=task.options?.mode??'text';
  return mode==='image'?'/openapi/v2/video/img/generate'
    :mode==='transition'?'/openapi/v2/video/transition/generate'
    :mode==='extend'?'/openapi/v2/video/extend/generate'
    :mode==='upscale'?'/openapi/v2/video/upscale/generate'
    :mode==='modify'?'/openapi/v2/video/modify/generate'
    :mode==='reference'?'/openapi/v2/video/fusion/generate'
    :'/openapi/v2/video/text/generate';
}
function imageFile(file){
  const type=IMAGE_TYPE[path.extname(file).toLowerCase()];
  if(!type)throw new Error('Unsupported image type');
  return type;
}
function videoFile(file){
  const type=VIDEO_TYPE[path.extname(file).toLowerCase()];
  if(!type)throw new Error('Unsupported video type');
  return type;
}
function needed(mode){
  if(mode==='image'||mode==='extend'||mode==='upscale')return {count:1,kind:'image'};
  if(mode==='transition')return {count:2,kind:'image'};
  if(mode==='modify')return {count:[1,4],kind:'mixed'};
  if(mode==='reference')return {count:[1,8],kind:'image'};
  return {count:0,kind:'none'};
}
export function createTransport(settings){
  const http=channel({...settings,header:'API-KEY'}),wait=settings.wait??(ms=>new Promise(resolve=>setTimeout(resolve,ms)));
  const api=async(path,body)=>{const r=await http.json(path,body,{'Ai-trace-id':randomUUID()});if(r.ErrCode!==0||!r.Resp)throw new Error('PixVerse business error; reconcile outcome');return r.Resp;};
  async function upload(file){
    const bytes=await fs.readFile(file);
    const r=await http.form('/openapi/v2/image/upload',{name:path.basename(file),type:imageFile(file),bytes},{'Ai-trace-id':randomUUID()});
    if(r.ErrCode!==0||r.Resp?.img_id===undefined)throw new Error('PixVerse image upload failed; reconcile outcome');
    return jobId(r.Resp.img_id);
  }
  async function uploadMedia(file){
    const bytes=await fs.readFile(file);
    const r=await http.form('/openapi/v2/media/upload',{name:path.basename(file),type:videoFile(file),bytes,field:'file',limit:32*1024*1024},{'Ai-trace-id':randomUUID()});
    if(r.ErrCode!==0||r.Resp?.media_id===undefined)throw new Error('PixVerse media upload failed; reconcile outcome');
    return jobId(r.Resp.media_id);
  }
  async function inspect(id){const r=await api('/openapi/v2/video/result/'+jobId(id));if(r.id!==undefined&&jobId(r.id)!==String(id))throw new Error('Mismatched provider task');return {providerJobId:String(id),status:r.status===1?'completed':r.status===5?'pending':[7,8].includes(r.status)?'failed':'unknown',url:r.url??null,credits:null};}
  async function resume({providerJobId,output,maxPolls=120}){const id=jobId(providerJobId);if(!Number.isInteger(maxPolls)||maxPolls<1||maxPolls>120)throw new Error('Invalid poll bound');for(let n=0;n<maxPolls;n++){const r=await inspect(id);if(r.status==='completed'){await fs.writeFile(output,await http.media(r.url),{flag:'wx'});return {credits:null,providerJobId:id};}if(r.status!=='pending')throw new Error('PixVerse task failed or unknown; verify billing before retry');if(n+1<maxPolls)await wait(3000);}throw new Error('PixVerse polling expired; retain task and reservation');}
  return {inspect,resume,upload,uploadMedia,async make({task,output,inputs=[],onSubmitted}){
    const mode=task.options?.mode??'text';
    const spec=needed(mode),count=(inputs??[]).length;
    if(Array.isArray(spec.count)?count<spec.count[0]||count>spec.count[1]:count!==spec.count)throw new Error(spec.count?'Local media inputs are required for this PixVerse mode':'Text generation does not take local media inputs');
    const ids=[];
    for(let i=0;i<count;i++)ids.push(await (mode==='extend'||mode==='upscale'||(mode==='modify'&&i===0)?uploadMedia:upload)(inputs[i]));
    const body=liveBody(task,ids);
    if(typeof onSubmitted!=='function')throw new Error('Durable submission callback required');
    const r=await api(generatePath(task),body),id=jobId(r.video_id);
    await onSubmitted({providerJobId:id});
    return resume({providerJobId:id,output});
  }};
}
