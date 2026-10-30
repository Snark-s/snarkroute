import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRegistry } from "../agent-ops/agents";
import { BuzhaAgentService } from "./service";
import { BUZHA_EXTERNAL_SCHEDULES } from "./schedules";
const dirs:string[]=[];
afterEach(async()=>{for(const dir of dirs.splice(0)) await rm(dir,{recursive:true,force:true,maxRetries:3});});
async function fixture(){
  const dir=await mkdtemp(join(tmpdir(),"buzha-schedules-"));dirs.push(dir);
  const registry=new AgentRegistry([dir],{secret:Buffer.alloc(32,1)}), owner=registry.owner(), source=registry.mcpClient("chatgpt-source-fixture");
  const works:any[]=[], tasks=new Map<string,any>();let schedule=JSON.stringify(BUZHA_EXTERNAL_SCHEDULES), calls=0;
  const service=new BuzhaAgentService({registry,workspace:id=>join(dir,String(id)),tasks:{
    list:()=>[...tasks.values()], get:(id:string)=>tasks.get(id),budgetUsage:()=>({}),chainBudget:()=>({}),
    submit:async(identity:any,spec:any)=>{const old=[...tasks.values()].find(t=>t.spec.idempotencyKey===spec.idempotencyKey);if(old)return{task:old,deduplicated:true};const id=`task-${++calls}`,task={id,chain:{rootTaskId:id},agentId:identity.id,spec,state:"queued",reason:"fixture",attempts:[],effects:[]};tasks.set(task.id,task);return{task,deduplicated:false};}
  } as any,memory:async(path?:string,body?:any)=>{
    if(!path)return {agent_schedule:schedule,agent_work:works};
    if(path==="/api/agent/schedules"){schedule=JSON.stringify(body);return {ok:true};}
    if(path==="/api/agent/inbox"){let row=works.find(w=>w.request_key===body.requestKey);if(row)return row;row={request_key:body.requestKey,payload:JSON.stringify(body),user_message_id:works.length+1};works.push(row);return row;}
    if(path==="/api/agent/bind"){works.find(w=>w.request_key===body.requestKey).task_id=body.taskId;return {ok:true};}
    return {ok:true};
  }});
  const input={automationId:BUZHA_EXTERNAL_SCHEDULES.flows[0].automationId,scheduledFor:"2026-10-30T00:07:50Z",content:"Controlled fixture, no actual scheduled work"};
  return {service,owner,source,input,tasks,calls:()=>calls};
}
describe("ChatGPT source handoff uses the shared queue, never a second clock",()=>{
  it("prepares an occurrence but dispatches nothing before both sides are confirmed",async()=>{const f=await fixture();const result=await f.service.scheduleTrigger(f.source,f.input);expect(result.accepted).toBe(false);expect(result.prepared).toBe(true);expect(f.calls()).toBe(0);await expect(f.service.acknowledgeScheduleSource(f.owner,{sourceClientId:f.source.id,proof:"",verifiedBothSides:true,noUnfinishedExternalEffects:true})).rejects.toThrow();});
  it("deduplicates the same verified occurrence across source and owner transports and blocks new occurrences on unknown effects",async()=>{
    const f=await fixture();
    // Owner attestation is simulated ONLY in this isolated fixture. Live source
    // ownership must remain unverified until the actual external side is checked.
    await f.service.acknowledgeScheduleSource(f.owner,{sourceClientId:f.source.id,proof:"Controlled owner attestation fixture; no real ChatGPT automation changed",verifiedBothSides:true,noUnfinishedExternalEffects:true});
    const first:any=await f.service.scheduleTrigger(f.source,f.input), duplicate:any=await f.service.scheduleTrigger(f.owner,{...f.input,scheduledFor:"2026-10-30T03:07:50+03:00"});
    expect(first.task.id).toBe(duplicate.task.id);expect(duplicate.deduplicated).toBe(true);expect(f.calls()).toBe(1);
    f.tasks.get(first.task.id).effects=[{state:"unknown"}];expect((await f.service.scheduleTrigger(f.source,f.input) as any).task.id).toBe(first.task.id);
    await expect(f.service.scheduleTrigger(f.source,{...f.input,scheduledFor:"2026-10-30T01:07:50Z"})).rejects.toThrow(/сверки/);expect(f.calls()).toBe(1);
  });
});
