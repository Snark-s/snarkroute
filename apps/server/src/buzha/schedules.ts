/** Owner supplied ChatGPT settings. This is a record of external ownership,
 * never a local scheduler registration or permission to run a due occurrence. */
export const BUZHA_EXTERNAL_SCHEDULES = {
  owner: "chatgpt", localEnabled: false, timezone: "Europe/Moscow", migration: "external_owner_retained",
  source: "owner_supplied_chatgpt_settings", sourceDate: "2026-10-30",
  reason: "Обе автоматизации включены в ChatGPT по сведениям владельца. Локальных дублей нет. Передача управления не выполнена; нужна согласованная остановка внешнего владельца и сверка незавершённых запусков. Вечерняя и ночная работа разрешена с учётом режима компьютера.",
  flows: [
    { id: "orders", name: "Бужа: поток заказов", automationId: "6ae3452672388191adbeef6f06c0d88a", enabled: true,
      schedule: { dtstart: "20261029T130750Z", rrule: "FREQ=HOURLY", sourceTimezone: "UTC", mode: "exact_schedule", sourceLabel: "Каждый час, на 07 минуте 50 секунде (UTC)", moscowLabel: "Каждый час в :07:50 Europe/Moscow" } },
    { id: "replies", name: "Бужа: ответы и сделки", automationId: "6ae3454528e881919edcc240c68fa2f9", enabled: true,
      schedule: { dtstart: "20261029T223000", rrule: "FREQ=DAILY", sourceTimezone: "Europe/Stockholm", mode: "flexible_schedule", sourceLabel: "Ежедневно в 22:30 Europe/Stockholm; запуск гибкий", moscowLabel: "Зимой — 00:30 следующих суток; летом — 23:30 того же дня. Точное время запуска не гарантировано." } }
  ]
};

function stockholmNominal(day: Date) {
  const parts=new Intl.DateTimeFormat("en-CA",{timeZone:"Europe/Stockholm",year:"numeric",month:"2-digit",day:"2-digit"}).formatToParts(day);
  const part=(name:string)=>Number(parts.find(p=>p.type===name)?.value);
  const date=new Date(Date.UTC(part("year"),part("month")-1,part("day"),22,30));
  const hour=Number(new Intl.DateTimeFormat("en-GB",{timeZone:"Europe/Stockholm",hour:"2-digit",hourCycle:"h23"}).format(date));
  date.setUTCHours(date.getUTCHours()-(hour-22+24)%24); return date;
}

export function nextBuzhaRun(id:string,now=new Date()):string {
  if(id==="orders") { const start=Date.parse("2026-10-29T13:07:50Z"), index=Math.max(0,Math.floor((now.getTime()-start)/3600000)+1); return new Date(start+index*3600000).toISOString(); }
  if(id!=="replies") throw new Error("Неизвестная автоматизация Бужи.");
  if(now.getTime()<Date.parse("2026-10-29T21:30:00Z")) return "2026-10-29T21:30:00.000Z";
  let day=new Date(now), nominal=stockholmNominal(day);
  for(let i=0;i<3;i++) { if(nominal.getTime()>now.getTime()&&nominal.getTime()>=Date.parse("2026-10-29T21:30:00Z")) return nominal.toISOString(); day=new Date(day.getTime()+86400000); nominal=stockholmNominal(day); }
  throw new Error("Не удалось определить следующее номинальное срабатывание.");
}

export function normalizeBuzhaOccurrence(automationId:string,scheduledFor:string) {
  const flow=BUZHA_EXTERNAL_SCHEDULES.flows.find(item=>item.automationId===automationId), date=new Date(scheduledFor);
  if(!flow||!/(Z|[+-]\d\d:\d\d)$/.test(scheduledFor)||!Number.isFinite(date.getTime())) throw new Error("Нужны известный ID и номинальное время с часовым поясом.");
  const epoch=Date.parse("2026-10-29T13:07:50Z");
  if(flow.id==="orders" && (date.getTime()<epoch||(date.getTime()-epoch)%3600000!==0)) throw new Error("Срабатывание не соответствует почасовому расписанию :07:50.");
  if(flow.id==="replies" && (date.getTime()<Date.parse("2026-10-29T21:30:00Z")||stockholmNominal(date).getTime()!==date.getTime())) throw new Error("Номинальное срабатывание должно быть 22:30 Europe/Stockholm.");
  const occurrence=date.toISOString();return {automationId,flowId:flow.id,occurrence,requestKey:`buzha:schedule:${automationId}:${occurrence}`};
}

export function buzhaSchedules(saved?: string | null, now = new Date()) {
  const settings = (saved ? JSON.parse(saved) : BUZHA_EXTERNAL_SCHEDULES) as typeof BUZHA_EXTERNAL_SCHEDULES & {handoff?:{verifiedByOwner:boolean;sourceClientId:string;proof:string;verifiedAt:string}};
  // Keep the original Stockholm recurrence intact. Calculate its current
  // Moscow representation using the IANA timezone rules, not a fixed offset.
  const date = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Stockholm", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const part = (name: string) => Number(date.find(p => p.type === name)?.value);
  const nominal = new Date(Date.UTC(part("year"), part("month") - 1, part("day"), 22, 30));
  const stockholmHour = Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Stockholm", hour: "2-digit", hourCycle: "h23" }).format(nominal));
  nominal.setUTCHours(nominal.getUTCHours() - (stockholmHour - 22 + 24) % 24);
  return { ...settings, sourceIntegration:settings.handoff?.verifiedByOwner ? "owner_verified_chatgpt_source":"prepared_unverified", flows: settings.flows.map(flow => ({ ...flow, schedule: { ...flow.schedule,
    nextNominalAt:nextBuzhaRun(flow.id,now), nextMoscow:new Intl.DateTimeFormat("ru-RU",{timeZone:"Europe/Moscow",day:"2-digit",month:"2-digit",year:"numeric",hour:"2-digit",minute:"2-digit",second:"2-digit",hourCycle:"h23"}).format(new Date(nextBuzhaRun(flow.id,now))),
    currentMoscow: flow.id === "replies" ? new Intl.DateTimeFormat("ru-RU", { timeZone: "Europe/Moscow", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(nominal) + " — номинальное время для текущей даты Стокгольма" : "Каждый час в :07:50",
  } })) };
}
