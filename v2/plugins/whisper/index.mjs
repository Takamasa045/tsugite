import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createReadStream} from 'node:fs';
import {createHash} from 'node:crypto';
async function digest(file){const hash=createHash('sha256');for await(const chunk of createReadStream(file))hash.update(chunk);return hash.digest('hex');}
export default {
  quote:()=>({service:'whisper',credits:0}),
  async analyze({input,model,scratch}){
    if(!process.env.TSUGITE_WHISPER||!path.isAbsolute(process.env.TSUGITE_WHISPER)||!model||!path.isAbsolute(model))throw new Error('Choose an existing whisper-cli binary and local model; no downloads are performed');
    const binary=await fs.realpath(process.env.TSUGITE_WHISPER),weights=await fs.realpath(model);
    if(!(await fs.stat(binary)).isFile()||!(await fs.stat(weights)).isFile())throw new Error('Select regular existing Whisper binary/model files');
    const run=promisify(execFile),output=path.join(scratch,'transcript'),wav=path.join(scratch,'input.wav');
    // Normalize video/audio containers locally; never pass a URL or download a model.
    try {
      await run(process.env.TSUGITE_FFMPEG||'ffmpeg',['-nostdin','-v','error','-n','-protocol_whitelist','file,pipe','-i',input,'-vn','-ac','1','-ar','16000','-c:a','pcm_s16le',wav],{timeout:120000,windowsHide:true,maxBuffer:1000000});
      await run(binary,['-m',weights,'-f',wav,'-ng','-t','2','-osrt','-of',output],{timeout:600000,windowsHide:true,maxBuffer:1000000});
    } catch {throw new Error('Local Whisper conversion/transcription failed; inspect the selected runtime and model');}
    return {format:'srt',text:await fs.readFile(output+'.srt','utf8'),mock:false,engine:{binarySha256:await digest(binary),modelSha256:await digest(weights),device:'cpu'}};
  }
};
