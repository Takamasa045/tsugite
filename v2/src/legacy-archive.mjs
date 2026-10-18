import fs from 'node:fs/promises';
import path from 'node:path';
import {inside,read,fileHash,write,fail,hash} from './files.mjs';
// Data preservation only: archived editor graphs are never executed or made
// authoritative plans. The selected v1 config/keys/state/approvals stay behind.
export async function archiveLegacy(source,destination,manifestPath){
  const raw=await read(source,manifestPath),manifestHash=hash(raw);if(Buffer.byteLength(raw)>2000000)fail('Legacy manifest exceeds archive limit');const original=JSON.parse(raw),files=new Map(),omitted=[];
  async function queue(value){
    const absolute=await inside(source,value),stat=await fs.stat(absolute);if(!stat.isFile())fail('Legacy archive references must be regular files');if(stat.size>512*1024*1024||files.size>=100&&!files.has(value))fail('Legacy archive exceeds media limits');
    if(files.has(value))return files.get(value).path;
    const extension=path.extname(value);if(!/^\.[a-zA-Z0-9]{1,12}$/.test(extension))fail('Unsupported legacy asset extension');const relative='assets/legacy-v1/source/'+value;
    if(extension.toLowerCase()==='.json'){
      if(stat.size>2000000)fail('Legacy JSON asset exceeds archive limit');
      const inspect=value=>{if(value&&typeof value==='object')for(const [key,item] of Object.entries(value)){if(/^(?:api_?key|token|secret|password|credential[s]?|auth(?:orization)?)$/i.test(key))fail('Credential fields cannot be copied in a legacy JSON asset');inspect(item);}};
      inspect(JSON.parse(await read(source,value)));
    }
    files.set(value,{source:value,path:relative,bytes:stat.size,hash:await fileHash(source,value)});
    if(path.basename(value)==='character-lock.json'){
      const lock=JSON.parse(await read(source,value));if(lock.schema_version!==1||!Array.isArray(lock.files)||!lock.files.length||lock.files.length>100)fail('Invalid character snapshot lock');
      for(const item of lock.files){if(typeof item.path!=='string'||!item.path||typeof item.sha256!=='string'||!/^[a-f0-9]{64}$/.test(item.sha256))fail('Invalid character snapshot file identity');const parent=path.posix.dirname(value),nested=(parent==='.'?'':parent+'/')+item.path;await inside(source,nested);if(await fileHash(source,nested)!==item.sha256)fail('Character snapshot hash does not match lock');await queue(nested);}
    }
    return relative;
  }
  async function collect(value,key='',trail=''){
    if(Array.isArray(value))return Promise.all(value.map((item,i)=>collect(item,key,trail+'/'+i)));
    if(value&&typeof value==='object'){const result=Object.create(null);for(const [name,item] of Object.entries(value)){if(/^(?:api_?key|token|secret|password|credential[s]?|auth(?:orization)?|approvals?|execution_state|run_log)$/i.test(name)){omitted.push(trail+'/'+name);continue;}result[name]=await collect(item,name,trail+'/'+name);}return result;}
    if(typeof value==='string'&&/(?:src|path|file|url|uri)$/i.test(key)&&value){
      if(/^[a-z][a-z0-9+.-]*:/i.test(value))fail('Legacy archive only accepts project-local references');
      const absolute=await inside(source,value);let stat;try{stat=await fs.stat(absolute);}catch(error){if(error.code==='ENOENT'){omitted.push(trail);return '[unresolved local reference omitted]';}throw error;}
      return queue(value);
    }
    return value;
  }
  const manifest=await collect(original);if([...files.values()].reduce((n,f)=>n+f.bytes,0)>2*1024*1024*1024)fail('Legacy archive total exceeds 2 GiB');
  const folder=await inside(destination,'assets/legacy-v1');await fs.mkdir(folder,{recursive:false});
  for(const file of files.values()){const target=await inside(destination,file.path);await fs.mkdir(path.dirname(target),{recursive:true});await fs.copyFile(await inside(source,file.source),target);if(await fileHash(source,file.source)!==file.hash||await fileHash(destination,file.path)!==file.hash)fail('Legacy source changed during archive copy');}
  if(await fileHash(source,manifestPath)!==manifestHash)fail('Legacy manifest changed during archive copy');
  const archive={version:1,kind:'legacy-data-archive',executionSupported:false,approvalsImported:false,manifest,files:[...files.values()],omittedFields:omitted};await write(destination,'assets/legacy-v1/archive.json',archive);
  return {path:'assets/legacy-v1/archive.json',manifestHash,files:files.size,omittedFields:omitted.length};
}
