import {readJSON,fail} from './files.mjs';
import {tasteHome} from './taste.mjs';
export async function pluginSettings(id){
  let config;try{config=await readJSON(tasteHome(),'config.json',{version:1,plugins:{}});}catch{fail('Unable to read private global config');}
  if(config.version!==1||Object.keys(config).some(k=>!['version','plugins'].includes(k))||!config.plugins||typeof config.plugins!=='object'||Array.isArray(config.plugins))fail('Invalid private global config');
  const value=Object.hasOwn(config.plugins,id)?config.plugins[id]:{};
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!['defaults','connection'].includes(k)))fail('Invalid plugin settings; never store secrets in config');
  const defaults=value.defaults??{},connection=value.connection??null;
  if(!defaults||typeof defaults!=='object'||Array.isArray(defaults)||JSON.stringify(defaults).length>10000||Object.keys(defaults).some(k=>/key|token|secret|password|credential/i.test(k))||Object.values(defaults).some(v=>v!==null&&!['string','number','boolean'].includes(typeof v)))fail('Use scalar defaults and environment references instead of credentials');
  if(connection){
    if(typeof connection!=='object'||Array.isArray(connection)||Object.keys(connection).some(k=>!['enabled','base_url','credential_env','download_origins'].includes(k))||typeof connection.enabled!=='boolean'||typeof connection.credential_env!=='string'||!/^[A-Z][A-Z0-9_]{0,127}$/.test(connection.credential_env))fail('Invalid connection settings');
    for(const origin of [connection.base_url,...(connection.download_origins??[])]){let url;try{url=new URL(origin);}catch{fail('Invalid connection origin');}if(url.protocol!=='https:'||url.username||url.password||url.pathname!=='/'||url.search||url.hash)fail('Connections require explicit HTTPS origins');}
    if(!Array.isArray(connection.download_origins)||connection.download_origins.length>20)fail('Select download origins explicitly');
  }
  return {defaults,connection};
}
