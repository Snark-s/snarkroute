// Real isolated API + absent inference endpoints. No provider credential enters this test.
import assert from 'node:assert/strict';
import { readFileSync, mkdirSync, writeFileSync, openSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { createServer } from 'node:net';
const root = resolve(import.meta.dirname, '../..');
const output = resolve(root, '.tmp/audit-20261011/live-unavailable');
mkdirSync(output, {recursive:true});
async function freePort() {
  const socket = createServer();
  await new Promise((resolve,reject) => socket.once('error',reject).listen(0,'127.0.0.1',resolve));
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  return port;
}
const registry = JSON.parse(readFileSync(resolve(root,'service-endpoints.json'),'utf8'));
const used = new Set(Object.values(registry.services).map(service => service.port));
for (const name of ['snarkroute','bonsai_inference','ollama_inference']) {
  let port;
  do { port = await freePort(); } while (used.has(port));
  registry.services[name].port = port;
  used.add(port);
}
const registryPath = resolve(output, 'service-endpoints.json');
writeFileSync(registryPath, JSON.stringify(registry));
const env = {...process.env, APP_MODE:'local', NODE_ENV:'production', API_PORT:String(registry.services.snarkroute.port), HOST:'127.0.0.1',
  SNARKROUTE_PORT_REGISTRY:registryPath,
  LOCAL_LLM_BASE_URL:`http://127.0.0.1:${registry.services.bonsai_inference.port}/v1`, LOCAL_LLM_ADDITIONAL_ENDPOINTS_JSON:'',
  PERSONA_BRIDGE_AUTO_START:'0', SNARKROUTE_LAUNCHER_TOKEN:''};
for (const name of ['GEMINI_API_KEY','POLZA_AI_API_KEY','OPENROUTER_API_KEY','KIE_API_KEY','RUTRONIX_API_KEY',
  'EXPERIENTIAL_API_KEY','EXPERIENTIAL_API_BASE_URL','FAL_KEY','H3_WORKER_URL','VAST_API_KEY','JEV_API_KEY','NEEDLE_API_KEY']) env[name]='';
const log = openSync(resolve(output,'server.log'),'w');
const child = spawn(process.execPath, ['--import',pathToFileURL(resolve(root,'node_modules/tsx/dist/loader.mjs')).href,
  resolve(root,'apps/server/src/index.ts')], {cwd:output,env,windowsHide:true,stdio:['ignore',log,log]});
const endpoint = `http://127.0.0.1:${registry.services.snarkroute.port}`;
try {
  let ready=false;
  for(let attempt=0;attempt<300;attempt++) {
    try { const health = await fetch(endpoint+'/health').then(reply => reply.json()); ready=health.service==='snarkroute-server'&&health.apiVersion===1&&health.ok===true; } catch {}
    if(ready) break;
    if(child.exitCode!==null) throw new Error('Isolated server exited');
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  assert(ready, 'Isolated API failed identity readiness');
  const route = {routeVersion:'1.0',route:{id:'audit-live-unavailable',title:'Unavailable local inference',author:{}},
    nodes:[{id:'llm',type:'ai.text',params:{prompt:'Reply OK',max_tokens:8,routingPolicy:{allowPaid:false}}}],edges:[]};
  const response = await fetch(endpoint+'/api/routes/run',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(route)});
  const result = await response.json();
  assert.equal(result.status,'failed');
  const node=result.nodeResults.llm;
  assert.match(node.errorDetails.code,/NO_PERMITTED_MODEL_ROUTE|PAID_PERMISSION_REQUIRED/);
  const proof={test:'B-live-unavailable',status:result.status,errorCode:node.errorDetails.code,
    origin:node.errorDetails.details?.origin,localInferencePorts:[registry.services.bonsai_inference.port,registry.services.ollama_inference.port],
    paidPermission:false,providerCredentialsPresent:false};
  writeFileSync(resolve(output,'result.json'),JSON.stringify(proof,null,2));
  console.log(JSON.stringify(proof));
} finally { child.kill(); }
