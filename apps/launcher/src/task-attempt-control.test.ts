import { describe, expect, it } from "vitest";
import { continueWithAdditionalAttempt } from "./task-attempt-control";

function fixture(attemptsLimit = 4, failBudget = false, state = "blocked") {
  const calls: Array<{ path:string; body?:any }> = [];
  const request = async (path:string,init?:RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({path,body});
    if (!init) return {task:{state},taskBudget:{attemptsUsed:4,attemptsLimit,subscriptionRunsUsed:15,subscriptionRunsLimit:24}};
    if (path.endsWith("/budget") && failBudget) throw new Error("owner required");
    return {ok:true};
  };
  return {calls,request};
}
describe("owner continuation through the existing task API",()=>{
  it("reads current counters, grants exactly one attempt and forwards the owner's clarification",async()=>{
    const f=fixture();await continueWithAdditionalAttempt("same-task","Owner authorizes a fifth attempt",f.request);
    expect(f.calls).toEqual([
      {path:"/tasks/same-task"},
      {path:"/tasks/same-task/budget",body:{budget:{maxAttempts:5},reason:"Owner authorizes a fifth attempt"}},
      {path:"/tasks/same-task/resolve",body:{action:"continue",note:"Owner authorizes a fifth attempt"}}
    ]);
  });
  it("never continues if the server rejects the owner budget action",async()=>{
    const f=fixture(4,true);await expect(continueWithAdditionalAttempt("task","Approved fifth attempt",f.request)).rejects.toThrow("owner required");expect(f.calls).toHaveLength(2);
  });
  it("does not grant a sixth attempt when a previous grant was already saved",async()=>{
    const f=fixture(5);await continueWithAdditionalAttempt("task","Continue the already granted fifth attempt",f.request);
    expect(f.calls.map(c=>c.path)).toEqual(["/tasks/task","/tasks/task/resolve"]);
  });
  it("does not mutate a task that is already running",async()=>{
    const f=fixture(4,false,"running");await expect(continueWithAdditionalAttempt("task","Approved fifth attempt",f.request)).rejects.toThrow(/состояние/);expect(f.calls).toHaveLength(1);
  });
  it("requires an explicit clarification before making requests",async()=>{
    const f=fixture();await expect(continueWithAdditionalAttempt("task","  ",f.request)).rejects.toThrow(/основание/);expect(f.calls).toHaveLength(0);
  });
  it("does not allocate another attempt to a subscription executor with no steps left",async()=>{
    const calls:string[]=[];
    await expect(continueWithAdditionalAttempt("task","Continue after owner approval",async path=>{calls.push(path);return{task:{state:"blocked",executor:"buzha_codex"},taskBudget:{attemptsUsed:5,attemptsLimit:5,subscriptionRunsUsed:24,subscriptionRunsLimit:24}};})).rejects.toThrow(/подписочных шагов/);
    expect(calls).toEqual(["/tasks/task"]);
  });
});
