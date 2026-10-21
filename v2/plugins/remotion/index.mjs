import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {muxSoftCaptions} from './subtitles.mjs';
import {publicClipName} from './clips.mjs';
export default {
  quote:()=>({service:'remotion',credits:0}),
  async runtime(){
    const packages={};
    for(const name of ['remotion','@remotion/bundler','@remotion/renderer','@remotion/media','react','react-dom']){
      let directory,found=false;
      try{directory=path.dirname(fileURLToPath(import.meta.resolve(name)));}catch{throw new Error('Install matching Remotion peer packages before planning');}
      while(directory!==path.dirname(directory)){
        try{const pkg=JSON.parse(await fs.readFile(path.join(directory,'package.json'),'utf8'));if(pkg.name===name){packages[name]=pkg.version;found=true;break;}}catch{}
        directory=path.dirname(directory);
      }
      if(!found)throw new Error('Install matching Remotion peer packages before planning');
    }
    const browser=process.env.TSUGITE_BROWSER;if(!browser||!path.isAbsolute(browser))throw new Error('Set TSUGITE_BROWSER to an existing browser before planning');
    const stat=await fs.stat(browser);if(!stat.isFile())throw new Error('Browser must be an executable file');
    return {packages,browser:{path:await fs.realpath(browser),bytes:stat.size,modified:stat.mtimeMs}};
  },
  async render({timeline,inputs,audio=[],output,scratch}){
    const browser=process.env.TSUGITE_BROWSER;
    if(!browser||!path.isAbsolute(browser)||(await fs.stat(browser)).isDirectory())throw new Error('Set TSUGITE_BROWSER to an existing local browser; automatic downloads are disabled');
    const publicDir=path.join(scratch,'public');await fs.mkdir(publicDir);
    const clipNames=inputs.map((file,i)=>publicClipName(i,file));
    for(let i=0;i<inputs.length;i++)await fs.copyFile(inputs[i],path.join(publicDir,clipNames[i]));
    for(let i=0;i<audio.length;i++)await fs.copyFile(audio[i],path.join(publicDir,`audio-${i}${path.extname(audio[i])}`));
    const [{bundle},{selectComposition,renderMedia}]=await Promise.all([import('@remotion/bundler'),import('@remotion/renderer')]);
    const serveUrl=await bundle({entryPoint:fileURLToPath(new URL('./composition.jsx',import.meta.url)),publicDir,outDir:path.join(scratch,'bundle'),onProgress:()=>{}});
    const inputProps={timeline,clipNames,audioNames:audio.map((file,i)=>`audio-${i}${path.extname(file)}`)};
    const composition=await selectComposition({serveUrl,id:'Tsugite',inputProps,browserExecutable:browser});
    await renderMedia({serveUrl,composition,inputProps,browserExecutable:browser,codec:'h264',outputLocation:output,concurrency:1,logLevel:'error'});
    await muxSoftCaptions({timeline,output,scratch});
    return {credits:0};
  }
};
