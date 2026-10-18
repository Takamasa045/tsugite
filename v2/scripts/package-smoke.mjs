// Runs only in a new install-owned fixture; never a production approval.
import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {browser} from '../tests/helpers.mjs';
const selected=JSON.parse(await fs.readFile(process.argv[2],'utf8')),root=path.join(selected.directory,'project'),run=promisify(execFile),steps=[];
process.env.TSUGITE_HOME=path.join(selected.directory,'private-home');
const cli=async args=>{const r=await run(process.execPath,[selected.cli,...args],{cwd:selected.directory,env:process.env,timeout:120000,maxBuffer:1000000}),data=JSON.parse(r.stdout);if(!data.ok)throw Error('Packaged CLI failed');steps.push(args[0]);return data;};
const base=path.resolve(path.dirname(selected.cli),'../src'),{review}=await import(pathToFileURL(path.join(base,'review.mjs'))),{status,state}=await import(pathToFileURL(path.join(base,'core.mjs')));
await cli(['init',root]);await cli(['check','--project',root]);await cli(['plan','--no-review','--project',root]);const page=await review(root);
try{const ui=await browser(page.url);if((await ui.submit('approve',{stage:'plan'})).status!==303)throw Error('Fixture plan form failed');await cli(['make','--project',root]);await cli(['export','--project',root]);await ui.refresh();if((await ui.submit('approve',{stage:'final'})).status!==303)throw Error('Fixture final form failed');const result={ok:true,packaged:true,approval:'Automated forms in an install-owned fixture, not human production approval',steps,checks:(await status(root)).checks,output:(await status(root)).output,ledger:(await state(root)).ledger};await fs.writeFile(path.join(selected.directory,'evidence.json'),JSON.stringify(result,null,2));process.stdout.write(JSON.stringify({directory:selected.directory,...result},null,2)+'\n');}finally{await page.close();}
