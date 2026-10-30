/** Apply the human's explicit 30 October approval, retaining all task counters.
 * This script changes only the owner's saved ceiling. Regular agent policies,
 * permissions, retries, paid-provider rules and schedule ownership stay intact.
 */
import assert from "node:assert/strict";
import {mkdir,readFile,writeFile} from "node:fs/promises";
import {join} from "node:path";
import {AgentOpsStore} from "../src/agent-ops/store";
import {agentOpsDataDirectory} from "../src/agent-ops/ledger-instance";
import {localServicePort} from "../src/services/local-service-endpoints";
import {loadRootEnv} from "../src/services/env-loader";
loadRootEnv();
assert(process.argv.includes("--approved-by-owner"),"Requires the actual owner's explicit approval, not an executor's claim");
const base=`http://127.0.0.1:${localServicePort("snarkroute")}`;
const state:any=await fetch(base+"/api/agent-ops/status").then(r=>r.json());assert.equal(state.leases.length,0);assert(state.executors.every((e:any)=>e.ledger.activeRuns===0));
const {identity}:any=await fetch(base+"/api/agent-ops/whoami").then(r=>r.json());assert.equal(identity.kind,"owner");assert.equal(identity.policy.id,"owner");assert([12,24].includes(identity.policy.chainBudget.subscriptionRuns));
const store=new AgentOpsStore(agentOpsDataDirectory()), path=store.path("policies.json");
const raw=await readFile(path,"utf8").catch((e:any)=>{if(e.code==="ENOENT")return null;throw e;});const saved=raw?JSON.parse(raw):{policies:{},assignments:{}};
const backup=store.path("backups",`owner-budget-${new Date().toISOString().replace(/[:.]/g,"-")}`);await mkdir(backup,{recursive:true});
await writeFile(join(backup,"policies-before.json"),raw??JSON.stringify({previousFileAbsent:true},null,2));
for(const id of ["t-20261029-58ccc5e2","t-20261030-f59f6f33"]){await writeFile(join(backup,id+".json"),await readFile(store.path("tasks",id,"task.json")));}
const owner=structuredClone(identity.policy);owner.chainBudget.subscriptionRuns=24;
saved.policies={...saved.policies,owner};
saved.ownerBudgetApproval={at:new Date().toISOString(),approval:"Разрешаю указанные лимиты",scope:"Owner ceiling 24; existing FL task total 24, existing mail verification total 16; counters and retry guards unchanged",tasks:{"t-20261029-58ccc5e2":24,"t-20261030-f59f6f33":16}};
await store.writeState("policies",saved);
console.log(JSON.stringify({saved:true,ownerCeiling:24,backup,restartRequired:true,taskCountersChanged:false}));
