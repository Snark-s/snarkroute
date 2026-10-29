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

export function buzhaSchedules(saved?: string | null, now = new Date()) {
  const settings = saved ? JSON.parse(saved) as typeof BUZHA_EXTERNAL_SCHEDULES : BUZHA_EXTERNAL_SCHEDULES;
  // Keep the original Stockholm recurrence intact. Calculate its current
  // Moscow representation using the IANA timezone rules, not a fixed offset.
  const date = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Stockholm", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const part = (name: string) => Number(date.find(p => p.type === name)?.value);
  const nominal = new Date(Date.UTC(part("year"), part("month") - 1, part("day"), 22, 30));
  const stockholmHour = Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Stockholm", hour: "2-digit", hourCycle: "h23" }).format(nominal));
  nominal.setUTCHours(nominal.getUTCHours() - (stockholmHour - 22 + 24) % 24);
  return { ...settings, flows: settings.flows.map(flow => ({ ...flow, schedule: { ...flow.schedule,
    currentMoscow: flow.id === "replies" ? new Intl.DateTimeFormat("ru-RU", { timeZone: "Europe/Moscow", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(nominal) + " — номинальное время для текущей даты Стокгольма" : "Каждый час в :07:50",
  } })) };
}
