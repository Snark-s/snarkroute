import { test } from "node:test";
import assert from "node:assert/strict";
import ts from "typescript";
import { buildContextPack, buildRelevantSlice } from "./jabberwock-bonsai-diagnostic-context";

const source = `import type {PendingPersonaProtocol} from '../protocol';
const pendingKey=(tabId:number)=>'pending:'+tabId;
let jabberwockBlinkOn=false;
function setJabberwockToolbarActive(active:boolean){jabberwockBlinkOn=active;}
chrome.runtime.onMessage.addListener((message,sender,reply)=>{
  const tabId=sender.tab?.id;
  if(message.type==='JABBERWOCK_SUPERVISOR'){jabberwock.execute(tabId,message.command).then(reply);}
  if(message.type==='unrelated'){unrelated();}
});
async function getPending(tabId:number){return (await chrome.storage.session.get(pendingKey(tabId)))[pendingKey(tabId)];}
function unrelated(){return 10;}
`;
test("pack consists of actual anchored source and original requirements", () => {
  const pack = buildContextPack(source, { stepIndex: 6 }, ["missing call"]);
  assert.ok(pack.text.includes("setJabberwockToolbarActive"));
  assert.ok(pack.text.includes("chrome.storage.session.get"));
  assert.ok(pack.text.includes("missing call"));
  for (const r of pack.regions) assert.equal(r.text, source.split(/\r?\n/).slice(r.startLine - 1, r.endLine).join("\n"));
  assert.equal(pack.observations.helperCallCount, 0);
  assert.equal(pack.observations.storageListenerCount, 0);
});
test("slice preserves real helper, session and Jabberwock listener structures", () => {
  const slice = buildRelevantSlice(source);
  assert.ok(slice.source.includes("function setJabberwockToolbarActive"));
  assert.ok(slice.source.includes("chrome.storage.session.get"));
  assert.ok(slice.source.includes("JABBERWOCK_SUPERVISOR"));
  assert.ok(!slice.source.includes("function unrelated"));
  assert.ok(!slice.source.includes("message.type==='unrelated'"));
  const ast = ts.createSourceFile("slice.ts", slice.source, ts.ScriptTarget.Latest, true);
  assert.equal((ast as any).parseDiagnostics.length, 0);
  for (const origin of slice.origins) assert.equal(origin.text, source.slice(origin.start, origin.end));
});
