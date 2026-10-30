/** Owner read-only source/storage inspection. Same parent chain; zero model steps. */
import assert from "node:assert/strict";
import {mkdir,writeFile} from "node:fs/promises";
import {resolve} from "node:path";
import {localServicePort} from "../src/services/local-service-endpoints";
const base=`http://127.0.0.1:${localServicePort("snarkroute")}`,parentId="t-20261030-f59f6f33";
const parent:any=await fetch(base+"/api/agent-ops/tasks/"+parentId).then(r=>r.json());
const proof=JSON.parse(parent.task.result.checks[1].content),url=new URL(proof.url);assert.equal(proof.independentReload,true);assert.equal(url.origin,"https://mail.google.com");assert(/^#sent\/[A-Za-z0-9_-]{10,100}$/.test(url.hash));
const workspace=resolve("data/agent-ops/sandbox/buzha-mail-independent-proof");await mkdir(workspace,{recursive:true});
const checks=[
 {type:"http",url:"https://snark.myportfolio.com/book-cover",status:200,text:"Book cover",timeoutMs:20000},
 {type:"http",url:"https://snark.myportfolio.com/stickers-for-halloween",status:200,text:"Stickers for Halloween",timeoutMs:20000},
 // This compact endpoint joins authoritative card links with actual canonical
 // assistant-message contents. It proves both without fetching megabyte logs.
 {type:"http",url:base+"/api/agents/buzha/tasks/"+parentId+"/conversation",json:{path:"observedLinksSaved.0.url",equals:url.href}}
];
const input={title:"Бужа: независимые публичные источники и каноническая запись доказательства",parentTaskId:parentId,idempotencyKey:"buzha-existing-mail-source-storage-2026-10-30",goal:"Read-only owner inspection: confirm two original public portfolio pages and actual storage of the independently observed existing-message URL in the parent card and its linked canonical assistant message. This is not a new outreach or an executor attempt. Never send, edit accounts or generate model text. A failure must remain blocked.",workspace,permissions:{fileWrite:false,shell:"none",network:true},requirements:{kind:"analysis",quality:"high"},allowedExecutors:["codex_cli","claude_code"],checks,criteria:checks.map((_c,i)=>({id:`source-${i}`,description:i<2?"Original public portfolio page exists with the expected work title":"The exact independently observed Sent URL is stored in the actual card/canonical assistant message",review:"machine",checkIndexes:[i]})),review:{forceStrong:false},retry:{maxAttempts:1,sameFailureLimit:1},budget:{wallMinutes:15,activeMinutes:2,subscriptionRuns:0,providerCost:0}};
const response=await fetch(base+"/api/agent-ops/acceptor/inspect",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(input)});const result:any=await response.json();assert(response.ok,JSON.stringify(result));
await writeFile(workspace+"/submission.json",JSON.stringify({at:new Date().toISOString(),parentId,childId:result.task.id,input},null,2));console.log(JSON.stringify({childId:result.task.id,parentId,state:result.task.state,deduplicated:result.deduplicated,modelBudget:0}));
