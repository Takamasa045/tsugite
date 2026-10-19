import { Server } from '@modelcontextprotocol/sdk/server';
import { dispatch } from './cli.mjs';

export const workflowTools = ['check','status','plan','make','export','note','clean'];
export async function callTool(root,name,args = {}) {
  if (!workflowTools.includes(name)) throw new Error('Unknown tool; no approval tool exists');
  if (name === 'note') {
    if (Object.keys(args).some(k=>k!=='text') || typeof args.text !== 'string') throw new Error('Invalid note arguments');
    return dispatch(name,[args.text],root);
  }
  if (Object.keys(args).length) throw new Error('Unexpected tool arguments');
  return dispatch(name,[],root);
}
export async function startMcp(root) {
  // Resolve sibling transports from the SDK's exact public export, including paths containing '*'.
  const { StdioServerTransport } = await import(new URL('./stdio.js',import.meta.resolve('@modelcontextprotocol/sdk/server')));
  const { ListToolsRequestSchema, CallToolRequestSchema } = await import(new URL('../types.js',import.meta.resolve('@modelcontextprotocol/sdk/server')));
  const server = new Server({name:'tsugite',version:'2.0.0-alpha.5'},{capabilities:{tools:{}}});
  server.setRequestHandler(ListToolsRequestSchema,async()=>({tools:workflowTools.map(name=>({name,description:`${name} in the configured local project. Human checks require the confirmation page.`,inputSchema:{type:'object',properties:name==='note'?{text:{type:'string'}}:{},required:name==='note'?['text']:[],additionalProperties:false}}))}));
  server.setRequestHandler(CallToolRequestSchema,async request=>{
    try { return {content:[{type:'text',text:JSON.stringify(await callTool(root,request.params.name,request.params.arguments))}]}; }
    catch(e) { return {isError:true,content:[{type:'text',text:e.message}]}; }
  });
  await server.connect(new StdioServerTransport());
}
