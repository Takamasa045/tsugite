import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { parseArgs } from 'node:util';
import { init, plan, make, exportVideo, environment, status, cleanPreview } from './core.mjs';
import { review } from './review.mjs';
import { addNote, pack, importPack, tasteHome } from './taste.mjs';
import { addPlugin, newPlugin, plugin,bundledPlugin } from './plugins.mjs';
import { locked, json, readJSON, write, fail } from './files.mjs';
import { migrate } from './migrate.mjs';
import {template,initTemplate,installSkill,addKnowledge} from './packs.mjs';
import {analyze} from './analysis.mjs';
import {addArchive,acquireNpm} from './acquire.mjs';

export const help = `継手 / Tsugite v2 alpha
Usage: tsugite <command> [--project directory] [--json]

  init <directory> [--from-v1 directory]   Create an offline sample or copy v1
  init <directory> --from-v1 dir --flatten file [--archive-v1]
                                          Copy a final and preserve legacy data safely
  init <directory> --template file        Fill portable timing slots with sample media
  init --pack file                       Export a timing template without media
  check [--status]                        Check environment / current workflow
  plan [--no-review] [--no-open]           Plan and open local confirmation page
  make                                   Make clips after plan approval
  export                                 Export after clips approval
  note <text> [--group text] [--global]    Save a private taste observation
  note --pack file | --import file        Export / import a taste pack
  clean                                  Preview old generated files
  plugin list | new <dir> --id <id> | add <local-package-dir>
  plugin add <bundled-name|directory|archive.tgz|npm:package@exact-version>
  plugin analyze <id> assets/input [--mock] [--model local-model] [--output assets/captions.srt]
  plugin knowledge story|prompt-director|file.md
  plugin skill --to <client-skills-directory>

Transport: tsugite mcp (stdio, current project only)
Checks are approved only in the confirmation page. No CLI approval flag exists.
Offline/mock runs need no service account. Live runs require explicit private connections.
`;

export async function dispatch(command, args = [], root = process.cwd()) {
  // Shared command dispatcher is the sole mutation path for CLI and MCP.
  if (command === 'check') return environment(root);
  if (command === 'status') return status(root);
  if (command === 'plan') return plan(root);
  if (command === 'make') return make(root);
  if (command === 'export') return exportVideo(root);
  if (command === 'clean') return cleanPreview(root);
  if (command === 'note' && args.length === 1) return locked(root, () => addNote(root,args[0]));
  fail('Unsupported operation; approvals exist only in the confirmation page');
}
function openBrowser(url) {
  const executable = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'rundll32' : 'xdg-open';
  const args = process.platform === 'win32' ? ['url.dll,FileProtocolHandler',url] : [url];
  const child = spawn(executable,args,{stdio:'ignore',windowsHide:true}); child.on('error',()=>{}); child.unref();
}
export async function main(argv = process.argv.slice(2)) {
  if (!argv.length || argv.includes('--help')) { process.stdout.write(help); return; }
  const command = argv[0], options = { project:{type:'string'}, json:{type:'boolean'} };
  const perCommand = {
    init:{'from-v1':{type:'string'},flatten:{type:'string'},'archive-v1':{type:'boolean'},template:{type:'string'},pack:{type:'string'}}, check:{status:{type:'boolean'}},
    plan:{'no-review':{type:'boolean'},'no-open':{type:'boolean'},review:{type:'boolean'},port:{type:'string'}},
    make:{}, export:{}, note:{group:{type:'string'},global:{type:'boolean'},pack:{type:'string'},import:{type:'string'}}, clean:{},
    plugin:{id:{type:'string'},to:{type:'string'},mock:{type:'boolean'},model:{type:'string'},output:{type:'string'}}, mcp:{}
  };
  if (!Object.hasOwn(perCommand,command)) fail('Unknown command');
  const {values,positionals} = parseArgs({ args:argv.slice(1), options:{...options,...perCommand[command]},allowPositionals:true,strict:true });
  const root = await fs.realpath(path.resolve(values.project || process.cwd()));
  let result;
  if (command === 'mcp') {
    if (positionals.length) fail('Unexpected arguments');
    const { startMcp } = await import('./mcp.mjs'); await startMcp(root); return;
  }
  if (command === 'init') {
    if(values.flatten&&!values['from-v1'])fail('--flatten needs an explicitly selected v1 project');
    if(values['archive-v1']&&!values['from-v1'])fail('--archive-v1 needs an explicitly selected v1 project');
    if([values['from-v1'],values.template,values.pack].filter(Boolean).length>1)fail('Choose one init mode');
    if(values.pack){if(positionals.length)fail('Template export does not take a directory');await fs.writeFile(path.resolve(root,values.pack),json(await template(root)),{flag:'wx',mode:0o600});result={exported:true};}
    else {
      if (positionals.length !== 1) fail('init needs a new directory');const dest = path.resolve(root,positionals[0]);
      result = values['from-v1'] ? await migrate(path.resolve(root,values['from-v1']),dest,{flatten:values.flatten,archive:values['archive-v1']}) : values.template ? await initTemplate(dest,JSON.parse(await fs.readFile(path.resolve(root,values.template),'utf8'))) : await init(dest);
    }
  } else if (command === 'note') {
    if ([values.pack,values.import,positionals.length>0].filter(Boolean).length !== 1) fail('Choose note text, --pack or --import');
    let target = root;
    if (values.global) { target = tasteHome(); await fs.mkdir(target,{recursive:true}); }
    if (values.pack) { await fs.writeFile(path.resolve(root,values.pack),json(await pack(target)),{flag:'wx',mode:0o600}); result = {exported:true}; }
    else if (values.import) {
      const data = JSON.parse(await fs.readFile(path.resolve(root,values.import),'utf8'));
      result = await locked(target,()=>importPack(target,data));
    }
    else { if(positionals.length !== 1) fail('Quote the note text'); result = await locked(target,()=>addNote(target,positionals[0],values.group)); }
  } else if (command === 'plugin') {
    const [sub,value] = positionals;
    if (sub === 'list' && positionals.length === 1) {
      const registry = await readJSON(root,'.tsugite/plugins.json',{});
      result = await Promise.all(['local',...Object.keys(registry)].map(async id => (await plugin(root,id)).manifest));
    } else if (sub === 'new' && positionals.length === 2 && values.id) result = await newPlugin(path.resolve(root,value),values.id);
    else if (sub === 'add' && positionals.length === 2) {
      if(value.startsWith('npm:'))result=await locked(root,()=>acquireNpm(root,value.slice(4)));
      else if(value.endsWith('.tgz'))result=await locked(root,()=>addArchive(root,path.resolve(root,value)));
      else {const source=!value.includes('/')&&!value.includes('\\')?await bundledPlugin(value):null;result=await locked(root,()=>addPlugin(root,source??path.resolve(root,value)));}
    }
    else if(sub==='skill'&&positionals.length===1&&values.to)result=await installSkill(path.resolve(root,values.to));
    else if(sub==='knowledge'&&positionals.length===2)result=await addKnowledge(root,/^[a-z][a-z0-9-]{0,63}$/.test(value)?value:path.resolve(root,value));
    else if(sub==='analyze'&&positionals.length===3)result=await analyze(root,value,positionals[2],{mock:values.mock,model:values.model,output:values.output});
    else fail('Use plugin list | new | add | skill --to directory | analyze id assets/input [--mock]');
  } else {
    if (positionals.length) fail('Unexpected positional arguments');
    result = await dispatch(command === 'check' && values.status ? 'status' : command,[],root);
  }
  if (command === 'plan' && !values['no-review']) {
    const port = values.port === undefined ? 0 : Number(values.port);
    if (!Number.isInteger(port) || port < 0 || port > 65535) fail('Invalid port');
    const page = await review(root,{port});
    process.stdout.write(json({ok:true,...result,url:page.url}));
    if (!values['no-open']) openBrowser(page.url);
    const close = () => { page.server.close(); page.server.closeAllConnections(); };
    process.once('SIGINT',close); process.once('SIGTERM',close);
    return;
  }
  process.stdout.write(json({ok:result?.ok !== false,result}));
  if (result?.ok === false) process.exitCode=1;
}
