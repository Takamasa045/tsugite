import {randomUUID} from 'node:crypto';
import fs from 'node:fs/promises';
import {channel,jobId} from './http.mjs';
export function payload(task){
  const o=task.options??{},model=o.model??'v6',quality=o.quality??'360p',aspect=o.aspect??'16:9';
  if(model!=='v6'||!Number.isInteger(task.seconds)||task.seconds<1||task.seconds>15||!['360p','540p','720p','1080p'].includes(quality)||!['16:9','9:16','1:1'].includes(aspect)||typeof task.prompt!=='string'||!task.prompt.trim())throw new Error('Unsupported PixVerse V6 text request');
  return {model,prompt:task.prompt,duration:task.seconds,quality,aspect_ratio:aspect,...(o.seed===undefined?{}:{seed:o.seed})};
}
export function createTransport(settings){
  const http=channel({...settings,header:'API-KEY'}),wait=settings.wait??(ms=>new Promise(resolve=>setTimeout(resolve,ms)));
  const api=async(path,body)=>{const r=await http.json(path,body,{'Ai-trace-id':randomUUID()});if(r.ErrCode!==0||!r.Resp)throw new Error('PixVerse business error; reconcile outcome');return r.Resp;};
  async function inspect(id){const r=await api('/openapi/v2/video/result/'+jobId(id));if(r.id!==undefined&&jobId(r.id)!==String(id))throw new Error('Mismatched provider task');return {providerJobId:String(id),status:r.status===1?'completed':r.status===5?'pending':[7,8].includes(r.status)?'failed':'unknown',url:r.url??null,credits:null};}
  async function resume({providerJobId,output,maxPolls=120}){const id=jobId(providerJobId);if(!Number.isInteger(maxPolls)||maxPolls<1||maxPolls>120)throw new Error('Invalid poll bound');for(let n=0;n<maxPolls;n++){const r=await inspect(id);if(r.status==='completed'){await fs.writeFile(output,await http.media(r.url),{flag:'wx'});return {credits:null,providerJobId:id};}if(r.status!=='pending')throw new Error('PixVerse task failed or unknown; verify billing before retry');if(n+1<maxPolls)await wait(3000);}throw new Error('PixVerse polling expired; retain task and reservation');}
  return {inspect,resume,async make({task,output,onSubmitted}){const body=payload(task);if(typeof onSubmitted!=='function')throw new Error('Durable submission callback required');const r=await api('/openapi/v2/video/text/generate',body),id=jobId(r.video_id);await onSubmitted({providerJobId:id});return resume({providerJobId:id,output});}};
}
