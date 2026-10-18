import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {plugin} from './plugins.mjs';
import {inside,write,exists,locked,fail} from './files.mjs';
import {parseSRT} from './timeline.mjs';
export async function analyze(root,id,input,{mock=false,model,output}={}){
  return locked(root,async()=>{
    if(!input.startsWith('assets/'))fail('Analysis input must be in assets/');
    const source=await inside(root,input),{manifest,implementation}=await plugin(root,id,true,{mode:mock?'mock':'offline'});
    if(!manifest.capabilities.includes('analysis')||!implementation.analyze)fail('Plugin cannot analyze');
    if((await implementation.quote({input})).credits!==0)fail('Analysis must be zero-credit');
    const scratch=await inside(root,`.tsugite/analysis/${randomUUID()}`);await fs.mkdir(scratch,{recursive:true});
    const result=await implementation.analyze({input:source,model:model?path.resolve(root,model):undefined,scratch});
    if(output){
      if(!output.startsWith('assets/')||!output.endsWith('.srt')||result.format!=='srt'||typeof result.text!=='string'||result.text.length>1000000)fail('Only local SRT output is supported');
      parseSRT(result.text);if(await exists(await inside(root,output)))fail('Analysis output already exists');await write(root,output,result.text);
    }
    return {...result,output:output??null};
  });
}
