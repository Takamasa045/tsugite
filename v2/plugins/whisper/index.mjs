import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
export default {
  quote:()=>({service:'whisper',credits:0}),
  async analyze({input,model,scratch}){
    if(!process.env.TSUGITE_WHISPER||!path.isAbsolute(process.env.TSUGITE_WHISPER)||!model||!path.isAbsolute(model))throw new Error('Choose an existing whisper-cli binary and local model; no downloads are performed');
    await fs.access(model);await fs.access(process.env.TSUGITE_WHISPER);
    const output=path.join(scratch,'transcript');
    await promisify(execFile)(process.env.TSUGITE_WHISPER,['-m',model,'-f',input,'-osrt','-of',output],{timeout:600000,windowsHide:true,maxBuffer:1000000});
    return {format:'srt',text:await fs.readFile(output+'.srt','utf8'),mock:false};
  }
};
