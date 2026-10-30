/** Live transport contract only. Does not activate, edit or execute a schedule. */
import assert from "node:assert/strict";
import {mkdir,writeFile} from "node:fs/promises";
import {Client} from "@modelcontextprotocol/sdk/client/index.js";
import {StreamableHTTPClientTransport} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {loadRootEnv} from "../src/services/env-loader";
import {localServicePort} from "../src/services/local-service-endpoints";
loadRootEnv();const base=`http://127.0.0.1:${localServicePort("snarkroute")}`;
const client=new Client({name:"buzha-schedule-transport-test",version:"1"});
const transport=new StreamableHTTPClientTransport(new URL(base+"/mcp"),{requestInit:{headers:{authorization:`Bearer ${process.env.SNARKROUTE_MCP_TOKEN}`}}});
try{
  const before:any=await fetch(base+"/api/agents/buzha").then(r=>r.json());assert.equal(before.schedules.owner,"chatgpt");assert.equal(before.schedules.localEnabled,false);
  await client.connect(transport);const listed=await client.listTools();assert(listed.tools.some(tool=>tool.name==="buzha_schedule_trigger"));
  const input={automationId:"6ae3452672388191adbeef6f06c0d88a",scheduledFor:"2026-10-30T01:07:50Z",content:"Transport preparation check only; do not execute scheduled business work",dryRun:true};
  const mcp=await client.callTool({name:"buzha_schedule_trigger",arguments:input});assert(!mcp.isError);
  const parsed=JSON.parse((mcp.content as any[]).filter(c=>c.type==="text").map(c=>c.text).join("\n"));
  const api:any=await fetch(base+"/api/agents/buzha/schedules/trigger",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({...input,scheduledFor:"2026-10-30T04:07:50+03:00"})}).then(r=>r.json());
  assert.equal(parsed.requestKey,api.requestKey);assert.equal(parsed.accepted,false);assert.equal(api.accepted,false);assert.equal(parsed.sourceVerified,false);assert(!api.task);
  const after:any=await fetch(base+"/api/agents/buzha").then(r=>r.json());assert.deepEqual(after.tasks.map((t:any)=>t.id).sort(),before.tasks.map((t:any)=>t.id).sort());
  const proof={requestKey:api.requestKey,mcpAndApiSameOccurrence:true,taskCreated:false,sourceVerified:false,owner:"chatgpt",localEnabled:false,next:after.schedules.flows.map((f:any)=>({name:f.name,nextMoscow:f.schedule.nextMoscow})),at:new Date().toISOString()};
  await mkdir("data/agent-ops/sandbox/buzha-schedule-transport",{recursive:true});await writeFile("data/agent-ops/sandbox/buzha-schedule-transport/proof.json",JSON.stringify(proof,null,2));console.log(JSON.stringify(proof,null,2));
}finally{await transport.terminateSession().catch(()=>undefined);await client.close();}
