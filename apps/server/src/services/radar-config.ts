export type RadarProvider = "openrouter" | "polza" | "gemini";

export type RadarDefinition = {
  id: string;
  title: string;
  topic: string;
  schedule: string;
  prompt: string;
  provider: RadarProvider;
  model: string;
  enabled: boolean;
};

const WEB_SEARCH_MODEL = "perplexity/sonar-pro";

export const RADAR_SYSTEM_PROMPT = "Ты — исследовательский радар для независимого режиссёра и небольшой студии. Итоговый ответ и весь текст отчёта пиши на русском языке. Не переходи на английский в пояснениях, выводах и полях отчёта; оставляй в оригинале только названия, имена, названия моделей, инструментов и фестивалей, устоявшиеся технические термины и ссылки. Сохраняй структуру отчёта, разделы, поля находок, ссылки и дедлайны. Не выдумывай факты, даты или ссылки; явно помечай неизвестное, неподтверждённое и интерпретации.";

/**
 * Radar schedules are deliberately disabled: enabling one makes billable
 * provider requests and is an owner decision.
 */
export const DEFAULT_RADARS: readonly RadarDefinition[] = [
  {
    id: "filmfreeway-festival-radar",
    title: "FilmFreeway: фестивальный радар",
    topic: "Open calls and festivals for fulldome, immersive media, AI video and mapping",
    schedule: "0 21 * * 1",
    prompt: "Найди актуальные и предстоящие open call, фестивали, резиденции и комиссии, релевантные fulldome cinema, immersive media, AI video, projection mapping и dome installations. Приоритизируй официальные страницы подачи заявки. Для каждой находки укажи название, тип, дедлайн, eligibility, fees, географию, требуемые материалы, принимаются ли remote или international applicants, а также ссылку на источник. Дедуплицируй повторяющиеся listings и явно помечай неуверенные сведения. Верни краткий Markdown-отчёт с сохранением полей находок, ссылок и дедлайнов и короткий shortlist для независимого режиссёра. Итоговый текст отчёта и пояснения напиши на русском языке; названия, термины и ссылки можно оставлять в оригинале.",
    provider: "openrouter",
    model: WEB_SEARCH_MODEL,
    enabled: false
  },
  {
    id: "immersive-media-brief",
    title: "Immersive Media Brief",
    topic: "AI-video, dome, mapping and model news",
    schedule: "0 21 * * 1",
    prompt: "Подготовь еженедельный brief о значимых новостях за последние семь дней в областях AI video, fulldome и dome production, immersive media, projection mapping, creative tools и релизов моделей. Отдавай приоритет первичным источникам и официальным release notes. Для каждой находки укажи дату и ссылку, отделяй verified facts от interpretation и объясняй, что важно для небольшой студии, создающей кинематографические immersive works. Сохрани краткий Markdown-формат отчёта и исходные поля находок и источников. Итоговый текст отчёта и пояснения напиши на русском языке; названия, термины и ссылки можно оставлять в оригинале.",
    provider: "openrouter",
    model: WEB_SEARCH_MODEL,
    enabled: false
  },
  {
    id: "h3-max-director-watch",
    title: "H3 Max Director Watch",
    topic: "Video-model and video-directing tool updates",
    schedule: "0 10 * * *",
    prompt: "Отслеживай актуальные обновления video-generation models и инструментов для режиссуры: controllable camera motion, character and reference consistency, image-to-video, editing, storyboarding, audio, изменения API, limits и licensing. Сосредоточься на изменениях, влияющих на рабочий процесс режиссёра; для каждой находки сравни новое состояние с предыдущим известным, укажи ссылку на официальный источник и явно отметь hype или unverified claims. Сохрани структуру краткого Markdown-отчёта и поля находок, источников и сравнения. Итоговый текст отчёта и пояснения напиши на русском языке; названия, термины и ссылки можно оставлять в оригинале.",
    provider: "openrouter",
    model: WEB_SEARCH_MODEL,
    enabled: false
  }
];

/**
 * The owner switches radars on in .env (re-read by the «Перезапустить SnarkRoute» button):
 * SNARKROUTE_RADARS=all, or a comma list of radar ids; empty or absent keeps every radar off.
 */
export function configuredRadars(env: NodeJS.ProcessEnv = process.env): RadarDefinition[] {
  const raw = env.SNARKROUTE_RADARS?.trim() ?? "";
  const ids = new Set(raw.split(",").map(item => item.trim()).filter(Boolean));
  const all = ids.has("all");
  // Optional provider/model switch for every radar (e.g. SNARKROUTE_RADAR_PROVIDER=polza, SNARKROUTE_RADAR_MODEL=perplexity/sonar-pro).
  const provider = env.SNARKROUTE_RADAR_PROVIDER?.trim();
  const model = env.SNARKROUTE_RADAR_MODEL?.trim();
  const providerOverride = provider === "openrouter" || provider === "polza" || provider === "gemini" ? { provider: provider as RadarProvider } : {};
  return DEFAULT_RADARS.map(radar => ({ ...radar, ...providerOverride, ...(model ? { model } : {}), enabled: all || ids.has(radar.id) }));
}
