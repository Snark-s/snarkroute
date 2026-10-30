/** The FL.ru profile contract for Buzha: fixed texts, files and independent public-page checks (shared by submit and check). */
import { readFileSync } from "node:fs";
import type { TaskCheck, TaskCriterion } from "../src/agent-ops/types";

export const manifest = JSON.parse(readFileSync("Y:/Приложения/Бужа/portfolio-publish/2026-10-30-fl/fl-profile-manifest.json", "utf8"));
export const profile = "https://www.fl.ru/users/buzhastudio/portfolio/";
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export const checks: TaskCheck[] = [
  { type: "file_content", path: "answer.md" },
  { type: "http", url: profile, text: "Бужа Студия" },
  { type: "http", url: profile, text: "виртуальный ассистент творческого бюро" },
  { type: "http", url: profile, text: "заранее согласуем сроки" },
  { type: "http", url: profile, text: "Студия Генерация изображений buzhastudio" },
  { type: "http", url: profile, absentText: "images/no_foto_b.png" },
  { type: "http", url: profile, pattern: 'src="https://st\\.fl\\.ru/[^"]+/foto/[^"]+"[^>]*class="b-layout__pic', matches: { min: 1 } },
  { type: "http", url: profile, pattern: "buzhastudio/cover/(f_[0-9a-f]+\\.[a-z]+)", matches: { min: 2, distinct: true } },
  { type: "http", url: profile, absentText: "Нет работ" },
  ...manifest.works.flatMap((work: { title: string }): TaskCheck[] => [
    { type: "http", url: profile, pattern: `title="${escape(work.title)}"\\s+alt="${escape(work.title)}"\\s+src="https://st\\.fl\\.ru/users/bu/buzhastudio/upload/`, matches: { min: 1 } },
    { type: "http", url: profile, pattern: `buzhastudio/portfolio/(\\d+)/"\\s+title="${escape(work.title)}"`, matches: { min: 1, max: 1, distinct: true } }
  ]),
  { type: "tool_scope", allowed: ["bridge_status", "bridge_capabilities", "browser_sessions", "browser_tabs", "browser_snapshot", "browser_find", "browser_observe_url", "browser_prepare_action", "browser_wait", "browser_navigate", "browser_tab_action", "browser_fill", "browser_click", "browser_upload", "material_read", "material_list", "memory_read", "workspace_read", "workspace_write"] }
];
const workChecks = manifest.works.map((_: unknown, index: number) => 9 + index * 2);
export const criteria: TaskCriterion[] = [
  { id: "name", description: "Публичное имя «Бужа Студия» сохранено и видно в публичном профиле", review: "machine", checkIndexes: [1] },
  { id: "description", description: "Новое описание бюро сохранено и видно публично: виртуальный ассистент, задачи, организация работы", review: "machine", checkIndexes: [2, 3] },
  { id: "specialization", description: "Бесплатная основная специализация «AI — искусственный интеллект / Генерация изображений» выбрана и выводится в профиле", review: "machine", checkIndexes: [4] },
  { id: "avatar", description: "Загруженный аватар отображается вместо стандартной заглушки «БС»", review: "machine", checkIndexes: [5, 6] },
  { id: "cover", description: "Обложки для ПК и мобильной версии загружены и выводятся в публичном профиле", review: "machine", checkIndexes: [7] },
  { id: "works", description: "Три реальные работы опубликованы, у каждой есть загруженное изображение; раздел больше не пуст", review: "machine", checkIndexes: [8, ...workChecks] },
  { id: "no-duplicates", description: "Каждая работа опубликована ровно один раз (одна уникальная ссылка на работу под каждым названием)", review: "machine", checkIndexes: workChecks.map((index: number) => index + 1) },
  { id: "report", description: "answer.md: исходное состояние, фактически сохранённое, ссылки на работы, ограничения площадки с сообщениями сайта", review: "machine", checkIndexes: [0, checks.length - 1] }
];

const works = manifest.works.map((work: any, index: number) => `${index + 1}. «${work.title}» — раздел «${work.section}», файл browser_upload root "y_apps", path "${work.uploadPath}" (sha256 ${work.sha256}).\nОписание работы (как есть):\n${work.description}`).join("\n\n");
export const content = `Оформи рабочий профиль Бужи на FL.ru: ${profile}
Это продолжение незавершённой задачи t-20261029-58ccc5e2 (её история сохранена; там подтверждены только имя и описание). Площадка FL.ru, не Freelance.ru. Отклики и коммерческие сообщения в этом поручении не отправляй.

Полномочия владельца (30.10.2026): самостоятельно заполнять и сохранять обычные поля, менять публичное имя, заголовок и описание, выбирать бесплатную специализацию, загружать аватар, обложку и работы, редактировать описания работ — без повторного согласия на каждое поле или сохранение. Не покупать размещение, подписки, отклики и другие услуги (окна с суммой к оплате закрывать). Не вводить и не менять пароль, не трогать безопасность, не ставить юридические согласия, не обходить CAPTCHA и проверку личности. Если шаг требует этого — сохрани точный экран и сообщение сайта как ограничение и переходи к следующему пункту.

Бужа — виртуальный ассистент бюро, не вымышленный человек. Имя владельца и его личные данные не публикуй. Не выдумывай стаж, клиентов, награды и технические детали работ.

Порядок (сначала свежая загрузка профиля browser_observe_url и запись исходного состояния в answer.md; уже сохранённое не повторяй):
1. Имя «Бужа Студия» оставить (оно допустимо).
2. Профессиональный заголовок «${manifest.headline}»: поле «Заголовок страницы» (pname) на ${profile.replace("portfolio/", "setup/main/")} в одной форме с полем текущего пароля. Пароль не вводи. Попробуй сохранить только заголовок; если сайт требует пароль — запиши его сообщение как ограничение.
3. Описание бюро — заменить текущее публичное описание на этот текст (как есть):
${manifest.description}
4. Основная специализация (бесплатно): ${profile.replace("portfolio/", "setup/specsetup/")} — «${manifest.specialization}». Окно «Покупка специализации» с суммой к оплате не используй.
5. Аватар: path "${manifest.avatar}" (512×512, знак Бужи). Найди штатное место загрузки фото профиля.
6. Обложки на странице профиля: кнопки «Загрузить обложку для ПК» и «…для мобильных устройств» (jpg/png до 5 МБ; 1940×400 и 900×300). ПК: "${manifest.coverDesktop}"; мобильная: "${manifest.coverMobile}".
7. Работы (каждую ровно один раз; перед добавлением проверь, что такой ещё нет), кнопка «Добавить работу» в нужном разделе:
${works}
8. Заново загрузи публичный профиль и каждую работу; в answer.md — что сохранено, ссылки на работы, ограничения с сообщениями сайта.

Загрузка: скрытые поля файла перечислены в snapshot.fileInputs — передавай их selector в browser_upload; после выбора файла прочитай страницу и подтверди сохранение, если сайт показывает кадрирование или кнопку. Экономь шаги: на всё поручение 24 подписочных шага; объединяй независимые действия одного экрана в один пакет, не повторяй безрезультатное.

Приёмщик сам читает публичную страницу профиля по HTTP: имя, описание, специализацию в карточке, аватар вместо «БС», две обложки, три работы с изображениями и отсутствие дублей.`;

