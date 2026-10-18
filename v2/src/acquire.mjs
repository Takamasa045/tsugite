import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {gunzipSync} from 'node:zlib';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {inside,fail,readJSON} from './files.mjs';
import {addPlugin} from './plugins.mjs';
const LIMIT=64*1024*1024,FILE_LIMIT=16*1024*1024;
const octal=buffer=>{const text=buffer.toString('ascii').replace(/\0.*$/s,'').trim();if(!/^[0-7]*$/.test(text))fail('Unsupported tar numeric field');return parseInt(text||'0',8);};
const field=buffer=>buffer.toString('utf8').replace(/\0.*$/s,'');
export function npmSpec(value){
  if(typeof value!=='string'||!/^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*@\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value))fail('Use an exact npm package@version, never a URL, tag or Git source');return value;
}
export async function unpack(buffer,destination){
  if(buffer.length>FILE_LIMIT)fail('Compressed plugin archive exceeds 16 MiB');
  const tar=gunzipSync(buffer,{maxOutputLength:LIMIT});let cursor=0,count=0,terminated=false;const names=new Set();
  // Deliberately bounded POSIX tar subset. Links, devices, GNU extensions and
  // PAX are rejected rather than interpreted incompletely. No shell tar runs.
  while(cursor+512<=tar.length){
    const header=tar.subarray(cursor,cursor+512);cursor+=512;
    if(header.every(byte=>byte===0)){if(tar.subarray(cursor).some(byte=>byte!==0))fail('Unexpected trailing tar data');terminated=true;break;}
    const checksum=header.reduce((sum,byte,i)=>sum+(i>=148&&i<156?32:byte),0);if(checksum!==octal(header.subarray(148,156)))fail('Invalid tar checksum');
    const name=[field(header.subarray(345,500)),field(header.subarray(0,100))].filter(Boolean).join('/'),size=octal(header.subarray(124,136)),type=String.fromCharCode(header[156]||48);
    if(!['0','5'].includes(type))fail('Plugin archives cannot contain links or extended/special entries');
    if(!name.startsWith('package/')||size>FILE_LIMIT||cursor+size>tar.length||++count>10000)fail('Invalid or oversized plugin archive entry');
    const relative=name.slice(8).replace(/\/$/,'');
    if(!relative){if(type!=='5'||size)fail('Invalid package root');continue;}
    if(names.has(relative))fail('Duplicate plugin archive entry');names.add(relative);
    const target=await inside(destination,relative);
    if(type==='5'){if(size)fail('Directory has archive data');await fs.mkdir(target,{recursive:true});}
    else {await fs.mkdir(path.dirname(target),{recursive:true});await fs.writeFile(target,tar.subarray(cursor,cursor+size),{flag:'wx',mode:octal(header.subarray(100,108))&0o111?0o755:0o644});}
    cursor+=Math.ceil(size/512)*512;if(cursor>tar.length)fail('Truncated plugin archive');
  }
  if(!terminated||!names.has('package.json'))fail('Plugin archive is truncated or has no package.json');
  return {entries:count};
}
async function workspace(root){const relative=`.tsugite/acquisition/${randomUUID()}`,directory=await inside(root,relative);await fs.mkdir(directory,{recursive:true});return directory;}
export async function addArchive(root,archive,{expectedPackage}={}){
  const directory=await workspace(root),extracted=path.join(directory,'package');await fs.mkdir(extracted);
  const stat=await fs.stat(archive);if(!stat.isFile()||stat.size>FILE_LIMIT)fail('Plugin archive exceeds limit');
  await unpack(await fs.readFile(archive),extracted);
  if(expectedPackage){const pkg=await readJSON(extracted,'package.json');if(pkg.name!==expectedPackage.name||pkg.version!==expectedPackage.version)fail('Archive does not match selected npm package identity');}
  return addPlugin(root,extracted);
}
export async function acquireNpm(root,spec,{run=promisify(execFile)}={}){
  npmSpec(spec);const directory=await workspace(root);
  // User explicitly chose npm:pkg@version. Use their configured registry; do
  // not select accounts, print auth/config, run lifecycle scripts or update v1.
  let result;
  let program='npm',prefix=[];
  if(process.platform==='win32'){
    const cli=process.env.TSUGITE_NPM_CLI||path.join(path.dirname(process.execPath),'node_modules/npm/bin/npm-cli.js');
    if(!path.isAbsolute(cli))fail('Select an existing absolute TSUGITE_NPM_CLI path');await fs.access(cli);program=process.execPath;prefix=[cli];
  }
  try{result=await run(program,[...prefix,'pack',spec,'--ignore-scripts','--json','--pack-destination',directory,'--cache',path.join(directory,'cache')],{cwd:directory,timeout:120000,maxBuffer:1000000,windowsHide:true,env:{...process.env,npm_config_ignore_scripts:'true',npm_config_update_notifier:'false',npm_config_audit:'false',npm_config_fund:'false'}});}
  catch{fail('Package acquisition failed; no plugin was registered');}
  let metadata;try{const raw=JSON.parse(result.stdout);metadata=Array.isArray(raw)?raw:Object.values(raw);}catch{fail('Invalid npm pack response');}
  if(metadata.length!==1||typeof metadata[0].filename!=='string'||path.basename(metadata[0].filename)!==metadata[0].filename||!metadata[0].filename.endsWith('.tgz'))fail('Unexpected npm archive filename');
  const split=spec.lastIndexOf('@');return addArchive(root,path.join(directory,metadata[0].filename),{expectedPackage:{name:spec.slice(0,split),version:spec.slice(split+1)}});
}
