/** Owner-authorized real FL.ru work through permanent Buzha. Not a controlled test. */
import { mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { localServicePort } from "../src/services/local-service-endpoints";
const base = `http://127.0.0.1:${localServicePort("snarkroute")}`;
const url = "https://www.fl.ru/users/buzhastudio/portfolio/";
const content = `Ночное рабочее поручение владельца 30.10.2026: завершить реальный профиль Бужи на FL.ru ${url} через твои рабочие инструменты и общий Приёмщик.
Разрешено оформление профиля, бесплатная специализация и публикация авторских примеров; не спрашивай согласие на обычную кнопку. Действует прежняя централизованная политика buzha-studio. Пароли, юридические согласия, подтверждение личности, CAPTCHA и платежи остаются за владельцем — не обходи отказ. Личные имя/телефон/почту владельца не публикуй.
Публичное имя Бужа Студия; профессиональный заголовок «Бужа | 3D, дизайн, монтаж и AI-визуализация». Бужа — виртуальный представитель творческой мастерской, а не вымышленная сотрудница. Актуальное описание в fl-profile-persona-2026-10-29.md (material_read). Старый fl-profile-ready устарел, его не публиковать.
Уже наблюдались публичные имя «Бужа Студия», описание с «Дизайн, ретушь» и «виртуальный представитель», ссылка snark.myportfolio.com. Сначала заново загрузи публичный профиль (browser_observe_url). Уже сохранённое повторно не меняй. Работай в своих фоновых вкладках (browser_tab_action create); не перенаправляй и не закрывай чужие вкладки. На setup/main есть password-поле, на setup/info — юридическое согласие: не трогай их, при отказе сохрани конкретную причину и переходи к независимым пунктам.
Нужно: подтвердить имя/описание; установить профессиональный заголовок, если доступно без защищённых шагов; выбрать подходящую БЕСПЛАТНУЮ специализацию профиля (ссылка /profile/setup/specsetup/, не платное размещение в каталоге); установить аватар из существующего assets/buzha-avatar-768.png (root y_apps, path Бужа/assets/buzha-avatar-768.png); добавить две реальные работы, если бесплатные возможности позволяют. Для аватара и работ найди штатную форму/visible input[type=file]; upload только выбирает файл — затем нужно сохранить и проверить после новой загрузки.
Подготовленные работы:
1) «AI-иллюстрация для книжной обложки», root y_apps, path Бужа/portfolio-publish/2026-10-30/ai-book-cover.jpg; источник https://snark.myportfolio.com/book-cover (раздел Neural Network Creativity); авторская работа художника творческой мастерской, Бужа — виртуальный представитель, не автор изображения.
2) «AI-иллюстрация: Halloween», root y_apps, path Бужа/portfolio-publish/2026-10-30/ai-halloween-stickers.png; источник https://snark.myportfolio.com/stickers-for-halloween, тот же раздел AI-графики и роль. Не выдавай AI за фотографию или ручной рисунок. Не публикуй ai-book-illustration.jpg: в его EXIF есть имя автора, а персональные данные в профиль не добавляем. Не выдумывай клиентов, опыт, стоимость и сроки.
Для этого поручения коммерческих сообщений не отправляй. Отклик — отдельная рабочая цель после проверки профиля; чужие недавние отклики не дублируй.
Бюджет общий для всех попыток этого поручения: 6 подписочных модельных шагов вместе с Приёмщиком, 4 попытки. Объединяй независимые чтения и последовательные известные безопасные поля в пакет до 6 actions; используй результаты следующему шагу. Оставь шаг для приёмки. В answer.md запиши фактически выполненное, публичные ссылки, источники работ и точные незавершённые пункты; не объявляй весь профиль готовым без доказательств. Финальный результат — новая загрузка публичной страницы и наблюдения, не квитанции clicked/file_selected.`;
const checks = [
  { type: "file_content", path: "answer.md" },
  { type: "tool", tool: "browser_observe_url", arguments: { url }, text: "Бужа Студия" },
  { type: "tool", tool: "browser_observe_url", arguments: { url }, text: "виртуальный" },
  { type: "tool_observations" }
];
const input = { content, requestKey: "buzha-fl-profile-working-2026-10-30", quality: "high", contract: {
  expectedResult: "На реальном публичном профиле подтверждены имя, профессиональный заголовок, описание виртуальной мастерской, бесплатная специализация, аватар и две настоящие авторские работы с происхождением.",
  checks, criteria: [
    { id: "name", description: "Публичное имя Бужа Студия сохранено после свежей загрузки", review: "machine", checkIndexes: [1] },
    { id: "description", description: "Публичное описание честно представляет виртуального представителя творческой мастерской", review: "machine", checkIndexes: [2] },
    { id: "headline-specialization", description: "Сохранены профессиональный заголовок и подходящая бесплатная специализация профиля, без покупки размещения", review: "model", checkIndexes: [0,3] },
    { id: "avatar", description: "Утверждённый аватар Бужи действительно сохранён и отображается после новой загрузки публичного профиля", review: "model", checkIndexes: [0,3] },
    { id: "works", description: "Две указанные настоящие работы с честной атрибуцией и ролью студии опубликованы и подтверждены после новой загрузки; выбор файла не считается публикацией", review: "model", checkIndexes: [0,3] }
  ], budget: { wallMinutes: 90, subscriptionRuns: 6, maxTurns: 8, providerCost: 0 }
} };
const response = await fetch(base + "/api/agents/buzha/messages", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
const result: any = await response.json(); if (!response.ok) throw new Error(JSON.stringify(result));
const dir = resolve("data", "agent-ops", "sandbox", "buzha-fl-working"); await mkdir(dir, { recursive: true });
await writeFile(join(dir, "submission.json"), JSON.stringify({ taskId: result.task.id, deduplicated: result.deduplicated, input, submittedAt: new Date().toISOString() }, null, 2));
console.log(JSON.stringify({ taskId: result.task.id, state: result.task.state, deduplicated: result.deduplicated, requestKey: input.requestKey }, null, 2));
