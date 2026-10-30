/** Verify persistence and no replay around the owner's managed restart. */
import assert from "node:assert/strict";
import {mkdir,writeFile} from "node:fs/promises";
import {localServicePort} from "../src/services/local-service-endpoints";
const base=`http://127.0.0.1:${localServicePort("snarkroute")}`;
const ids=["t-20261029-343e35f6","t-20261029-516f5072","t-20261030-ae1364a2","t-20261029-58ccc5e2","t-20261030-f59f6f33"];
async function read(){
 const status:any=await fetch(base+"/api/agents/buzha").then(r=>r.json());
 const tasks=await Promise.all(ids.map(async id=>{const {task}:any=await fetch(base+"/api/agent-ops/tasks/"+id).then(r=>r.json());return {id,state:task.state,attempts:task.attempts.length,modelCalls:task.attempts.flatMap((a:any)=>a.modelCalls??[]).map((c:any)=>({id:c.id,runId:c.runId,model:c.model,provider:c.provider})),toolCalls:task.attempts.flatMap((a:any)=>a.toolCalls??[]).map((c:any)=>({id:c.id,tool:c.tool,ok:c.ok})),effects:task.effects?.map((e:any)=>({key:e.key,state:e.state})),evidence:task.evidence.length};}));
 return {runtime:status.runtimeVersion,memory:status.memory,messages:status.messages.map((m:any)=>({id:m.id,role:m.role})),owner:status.schedules.owner,localEnabled:status.schedules.localEnabled,flows:status.schedules.flows.map((f:any)=>({id:f.automationId,dtstart:f.schedule.dtstart,rrule:f.schedule.rrule,timezone:f.schedule.sourceTimezone,mode:f.schedule.mode})),tasks};
}
const before=await read();const live:any=await fetch(base+"/api/agent-ops/status").then(r=>r.json());assert.equal(live.leases.length,0,"Do not restart over an active lease");assert(live.executors.every((executor:any)=>executor.ledger.activeRuns===0),"Do not interrupt active executors");
const restart=await fetch(base+"/api/system/restart",{method:"POST",headers:{"content-type":"application/json"},body:"{}"});assert(restart.ok);
let after:Awaited<ReturnType<typeof read>>|undefined;
for(let n=0;n<45;n++){await new Promise(r=>setTimeout(r,1000));try{const current=await read();if(current.runtime.pid!==before.runtime.pid){after=current;break;}}catch{}}
assert(after,"Managed restart did not become ready");
assert.equal(after.memory,before.memory);assert.deepEqual(after.messages,before.messages);assert.equal(after.owner,"chatgpt");assert.equal(after.localEnabled,false);assert.deepEqual(after.flows,before.flows);
for(const original of before.tasks){const restored=after.tasks.find(t=>t.id===original.id)!;assert.equal(restored.attempts,original.attempts);assert.deepEqual(restored.modelCalls,original.modelCalls);assert.deepEqual(restored.toolCalls,original.toolCalls);assert.deepEqual(restored.effects,original.effects);assert(restored.evidence>=original.evidence);if(original.state==="verified")assert.equal(restored.state,"verified");}
const proof={at:new Date().toISOString(),preserved:true,noReplay:true,before,after};await mkdir("data/agent-ops/sandbox/buzha-night-restart",{recursive:true});await writeFile("data/agent-ops/sandbox/buzha-night-restart/proof.json",JSON.stringify(proof,null,2));
console.log(JSON.stringify({oldPid:before.runtime.pid,newPid:after.runtime.pid,revision:after.runtime.gitRevision,branch:after.runtime.branch,dirtySources:after.runtime.dirtySourceFiles,tasks:after.tasks.map(t=>({id:t.id,state:t.state,attempts:t.attempts,models:t.modelCalls.length,tools:t.toolCalls.length})),preserved:true,noReplay:true},null,2));
