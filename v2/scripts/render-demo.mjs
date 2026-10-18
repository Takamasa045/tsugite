// Release-fixture explainer. Uses existing peers/browser; never installs them.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {bundle} from '@remotion/bundler';
import {selectComposition,renderMedia} from '@remotion/renderer';
const browser=process.env.TSUGITE_BROWSER,source=process.env.TSUGITE_DEMO_SOURCE,output=process.argv[2];
if(!browser||!path.isAbsolute(browser)||!source||!path.isAbsolute(source)||!output)throw new Error('Select existing browser, synthetic sample and a new output path');
await fs.access(browser);await fs.access(source);try{await fs.access(output);throw new Error('Output exists');}catch(e){if(e.code!=='ENOENT')throw e;}
const scratch=await fs.mkdtemp(path.join(os.tmpdir(),'tsugite-v2-demo-')),publicDir=path.join(scratch,'public');await fs.mkdir(publicDir);await fs.copyFile(source,path.join(publicDir,'sample.mp4'));
const serveUrl=await bundle({entryPoint:fileURLToPath(new URL('./demo.jsx',import.meta.url)),publicDir,outDir:path.join(scratch,'bundle')});
const composition=await selectComposition({serveUrl,id:'TsugiteDemo',browserExecutable:browser});await renderMedia({serveUrl,composition,codec:'h264',outputLocation:path.resolve(output),browserExecutable:browser,concurrency:2});console.log(JSON.stringify({output:path.resolve(output),seconds:30,synthetic:true,scratch}));
