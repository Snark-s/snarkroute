/** Read-only follow-up of Claude's external FL work. No executor, model, browser
 * action, task submission, acceptance override or budget change is performed. */
import { createHash } from "node:crypto";
import { readFile, mkdir, writeFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runCheck } from "../src/agent-ops/workspace";
import { buzhaHome } from "../src/buzha/memory";
import type { TaskCheck } from "../src/agent-ops/types";

const profile="https://www.fl.ru/users/buzhastudio/portfolio/";
const originalId="t-20261029-58ccc5e2";
const directory=fileURLToPath(new URL("../data/agent-ops/sandbox/buzha-claude-result-check/",import.meta.url));
const definitions:Array<{id:string;label:string;additional?:boolean;check:TaskCheck}>=[
  {id:"name",label:"Публичное имя Бужа Студия",check:{type:"http",url:profile,text:"Бужа Студия"}},
  {id:"virtual_description",label:"Описание явно называет Бужу виртуальным ассистентом",check:{type:"http",url:profile,text:"виртуальный ассистент Бужа"}},
  {id:"specialization",label:"Основная специализация Генерация изображений видна в публичном заголовке",check:{type:"http",url:profile,text:"Студия Генерация изображений buzhastudio"}},
  {id:"avatar_placeholder_absent",label:"Прежняя заглушка аватара отсутствует",check:{type:"http",url:profile,absentText:"images/no_foto_b.png"}},
  {id:"avatar_image",label:"В публичной разметке есть загруженное фото профиля; совпадение с утверждённым изображением отдельно не оценивалось",check:{type:"http",url:profile,pattern:'src="https://st\\.fl\\.ru/[^"]+/foto/[^"]+"[^>]*class="b-layout__pic',matches:{min:1}}},
  {id:"covers",label:"Видны две разные обложки",additional:true,check:{type:"http",url:profile,pattern:"buzhastudio/cover/(f_[0-9a-f]+\\.[a-z]+)",matches:{min:2,distinct:true}}},
  {id:"portfolio_not_empty",label:"Нет публичного текста Нет работ",check:{type:"http",url:profile,absentText:"Нет работ"}},
  {id:"book_work",label:"Одна публичная ссылка на заданную работу с книжной обложкой",check:{type:"http",url:profile,pattern:'buzhastudio/portfolio/(\\d+)/[^<]*title="(?:AI-иллюстрация для книжной обложки|AI-иллюстрация для обложки книги)"',matches:{min:1,max:1,distinct:true}}},
  {id:"halloween_work",label:"Одна публичная ссылка на заданную работу Halloween",check:{type:"http",url:profile,pattern:'buzhastudio/portfolio/(\\d+)/[^<]*title="(?:AI-иллюстрация: Halloween|AI-стикеры к Хэллоуину)"',matches:{min:1,max:1,distinct:true}}},
  {id:"original_headline",label:"Точная формулировка заголовка исходного поручения найдена в разметке",check:{type:"http",url:profile,text:"Бужа | 3D, дизайн, монтаж и AI-визуализация"}}
];
const observations=await Promise.all(definitions.map(async definition=>{
  const result=await runCheck({...definition.check,timeoutMs:15000} as TaskCheck,undefined);
  return{id:definition.id,label:definition.label,additional:definition.additional===true,ok:result.ok,source:result.source,detail:result.detail,
    ...(result.content?{contentSha256:createHash("sha256").update(result.content).digest("hex")}: {})};
}));
const original=JSON.parse(await readFile(new URL(`../data/agent-ops/tasks/${originalId}/task.json`,import.meta.url),"utf8"));
const originalTask={id:originalId,state:original.state,attempts:original.attempts.length,attemptLimit:original.spec.retry.maxAttempts,subscriptionLimit:original.spec.budget.subscriptionRuns,
  subscriptionUsed:original.attempts.reduce((n:number,a:any)=>n+(a.modelCalls?.filter((c:any)=>c.tier==="subscription").length??0),0)+(original.reviewRuns?.filter((r:any)=>["codex_cli","claude_code"].includes(r.executor)).length??0)};
const journalPath=join(buzhaHome(),"data","agent-work","claude-fl-2026-10-30","effects.json");
let external:Record<string,unknown>={completion:"unknown"};
try{const entries=Object.values(JSON.parse(await readFile(journalPath,"utf8"))) as any[];external={...external,journalUpdatedAt:(await stat(journalPath)).mtime.toISOString(),actions:entries.length,lastActions:entries.sort((a,b)=>String(a.at).localeCompare(String(b.at))).slice(-5).map(e=>({tool:e.tool,state:e.state,at:e.at}))};}catch{external.journalAvailable=false;}
const fingerprint=createHash("sha256").update(JSON.stringify({facts:observations.map(o=>({id:o.id,ok:o.ok})),originalTask})).digest("hex");
const previous=await readFile(join(directory,"latest.json"),"utf8").then(JSON.parse).catch(()=>undefined);
const observedAt=new Date().toISOString(),candidateReady=observations.filter(o=>!o.additional).every(o=>o.ok);
const report={observedAt,moscow:new Date(observedAt).toLocaleString("ru-RU",{timeZone:"Europe/Moscow"}),profile,fingerprint,changed:previous?.fingerprint!==fingerprint,candidateReady,
  scope:"Anonymous public HTML through the shared Acceptor HTTP checker. Image identity, attribution and visual quality are not confirmed. Original task acceptance is not changed.",
  modelCallsByThisCheck:0,originalTask,external,observations};
await mkdir(directory,{recursive:true});await writeFile(join(directory,"latest.json"),JSON.stringify(report,null,2));
if(report.changed)await writeFile(join(directory,observedAt.replace(/[:.]/g,"-")+".json"),JSON.stringify(report,null,2));
console.log(JSON.stringify(report,null,2));
