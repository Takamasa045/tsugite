// Standalone plugin utility. No implicit endpoint, credentials or fetch binding.
export function channel({fetch:send,baseURL,origins,key,header}){
  if(typeof send!=='function'||typeof key!=='string'||!key||/[\r\n]/.test(key))throw new Error('Select a transport and credential explicitly');
  const base=new URL(baseURL);if(base.protocol!=='https:'||base.username||base.password||base.search||base.hash||base.pathname!=='/')throw new Error('Select an HTTPS API origin');
  const downloads=new Set(origins??[]);
  function url(value,media=false){const u=new URL(value,base);if(u.protocol!=='https:'||u.username||u.password||u.hash||(!media&&u.origin!==base.origin)||(media&&!downloads.has(u.origin)))throw new Error('Unapproved response origin');return u;}
  async function call(target,options={},media=false){
    const endpoint=url(target,media);let response;
    try{response=await send(endpoint.href,{...options,redirect:'error',credentials:'omit',signal:AbortSignal.timeout(30000),headers:media?{}:{'Content-Type':'application/json',[header]:key,...options.headers}});}catch{throw new Error('Provider request outcome unknown; do not resubmit automatically');}
    if(!response.ok)throw new Error('Provider HTTP '+response.status+'; outcome requires reconciliation');return response;
  }
  async function bytes(response,limit){if(Number(response.headers.get('content-length'))>limit)throw new Error('Provider response too large');let size=0;const chunks=[];for await(const chunk of response.body??[]){size+=chunk.length;if(size>limit)throw new Error('Provider response too large');chunks.push(Buffer.from(chunk));}return Buffer.concat(chunks);}
  return {async json(target,body,headers){const r=await call(target,{method:body===undefined?'GET':'POST',body:body===undefined?undefined:JSON.stringify(body),headers});try{return JSON.parse((await bytes(r,1024*1024)).toString('utf8'));}catch{throw new Error('Invalid or oversized provider JSON; reconcile outcome');}},async media(target){return bytes(await call(target,{},true),64*1024*1024);}};
}
export function jobId(value){if(!['string','number'].includes(typeof value)||!/^[-a-zA-Z0-9_]{1,128}$/.test(String(value))||(typeof value==='number'&&!Number.isSafeInteger(value)))throw new Error('Invalid provider job identity');return String(value);}
export function cost(value){const n=typeof value==='number'?value:typeof value==='string'&&/^\d+(?:\.\d{1,6})?$/.test(value)?Number(value):NaN;return Number.isFinite(n)&&n>=0&&Number.isSafeInteger(Math.round(n*1e6))&&Math.abs(n*1e6-Math.round(n*1e6))<1e-5?n:null;}
