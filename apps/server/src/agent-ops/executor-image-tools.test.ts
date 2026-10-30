import {describe,it,expect} from "vitest";
import {CodexExecutor} from "./executors";
import type {AgentTask,AgentToolCall} from "./types";
describe("native Codex image-view receipts",()=>{
 it("records completed engine image events, not narrative claims, before finishing the attempt",async()=>{
  const calls:AgentToolCall[]=[];
  const adapter=new CodexExecutor({auth:async()=>({installed:true,subscription:true,checkedAt:""}) as any,run:async request=>{
    request.onEvent?.({type:"item",itemType:"image_view",summary:"C:\\fixture\\cover.jpg"});
    request.onEvent?.({type:"item",itemType:"command_execution",summary:"echo I viewed an image"});
    return {text:"Controlled visual report",model:"controlled-model",usage:{inputTokens:1,outputTokens:1,reasoningOutputTokens:0}} as any;
  }});
  const result=await adapter.run({task:{id:"fixture",spec:{permissions:{fileWrite:false,shell:"none",network:false}},attempts:[{n:2}]} as AgentTask,workdir:"C:\\fixture",prompt:"Inspect only the local image",brief:"Controlled fixture",env:{},signal:new AbortController().signal,timeoutMs:1000,maxTurns:1,log:()=>{},onPid:()=>{},onToolCall:async call=>{await Promise.resolve();calls.push(call);}});
  expect(result.ok).toBe(true);expect(calls).toHaveLength(1);expect(calls[0]).toMatchObject({attempt:2,tool:"view_image",effectKey:"native-image:cover.jpg",ok:true,arguments:{path:"C:\\fixture\\cover.jpg"}});
 });
});
