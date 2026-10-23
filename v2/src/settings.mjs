import {readJSON,fail} from './files.mjs';
import {tasteHome} from './taste.mjs';
export async function pluginSettings(id){
  let config;try{config=await readJSON(tasteHome(),'config.json',{version:1,plugins:{}});}catch{fail('Unable to read private global config');}
  if(config.version!==1||Object.keys(config).some(k=>!['version','plugins'].includes(k))||!config.plugins||typeof config.plugins!=='object'||Array.isArray(config.plugins))fail('Invalid private global config');
  const value=Object.hasOwn(config.plugins,id)?config.plugins[id]:{};
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!['defaults','connection'].includes(k)))fail('Invalid plugin settings; never store secrets in config');
  const defaults=value.defaults??{},connection=value.connection??null;
  if(!defaults||typeof defaults!=='object'||Array.isArray(defaults)||JSON.stringify(defaults).length>10000||Object.keys(defaults).some(k=>/key|token|secret|password|credential/i.test(k))||Object.values(defaults).some(v=>v!==null&&!['string','number','boolean'].includes(typeof v)))fail('Use scalar defaults and environment references instead of credentials');
  return {defaults,connection:connection?validateConnection(connection):null};
}
const HTTP_KEYS=['enabled','transport','base_url','credential_env','download_origins'];
const CLI_KEYS=['enabled','transport','command'];
function commandToken(value){
  if(typeof value!=='string'||!value||value.length>4096||/[\0\r\n;&|`$<>]/.test(value))fail('CLI command must be an executable path, not a shell line');
  return value;
}
export function validateConnection(connection){
  if(!connection||typeof connection!=='object'||Array.isArray(connection))fail('Invalid connection settings');
  const keys=Object.keys(connection);
  const httpField=keys.some(k=>['base_url','credential_env','download_origins'].includes(k));
  const hasCommand=Object.hasOwn(connection,'command');
  if(connection.transport!==undefined&&connection.transport!=='cli'&&connection.transport!=='http')fail('Invalid connection transport');
  if((connection.transport==='cli'&&httpField)||(connection.transport==='http'&&hasCommand)||(!connection.transport&&httpField&&hasCommand))fail('Choose either a CLI connection or an HTTP connection');
  const transport=connection.transport==='cli'||(!connection.transport&&!httpField)?'cli':'http';
  if(typeof connection.enabled!=='boolean')fail('Invalid connection settings');
  if(transport==='cli'){
    if(keys.some(k=>!CLI_KEYS.includes(k)))fail('Invalid connection settings');
    const command=connection.command==null?null:Array.isArray(connection.command)?connection.command.map(commandToken):[commandToken(connection.command)];
    if(command&&(command.length<1||command.length>8))fail('Invalid CLI command');
    return command?{enabled:connection.enabled,transport:'cli',command}:{enabled:connection.enabled,transport:'cli'};
  }
  if(keys.some(k=>!HTTP_KEYS.includes(k))||typeof connection.credential_env!=='string'||!/^[A-Z][A-Z0-9_]{0,127}$/.test(connection.credential_env))fail('Invalid connection settings');
  for(const origin of [connection.base_url,...(connection.download_origins??[])]){let url;try{url=new URL(origin);}catch{fail('Invalid connection origin');}if(url.protocol!=='https:'||url.username||url.password||url.pathname!=='/'||url.search||url.hash)fail('Connections require explicit HTTPS origins');}
  if(!Array.isArray(connection.download_origins)||connection.download_origins.length>20)fail('Select download origins explicitly');
  return {enabled:connection.enabled,transport:'http',base_url:connection.base_url,credential_env:connection.credential_env,download_origins:connection.download_origins};
}
