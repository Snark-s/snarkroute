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
    prompt: "Find current and upcoming open calls, festivals, residencies and commissions relevant to fulldome cinema, immersive media, AI video, projection mapping and dome installations. Prioritize official application pages, deadlines, eligibility, fees, geography, required materials and whether remote or international applicants are accepted. Deduplicate recurring listings, mark uncertain details, and return concise Markdown with source links and a short shortlist for an independent director.",
    provider: "openrouter",
    model: WEB_SEARCH_MODEL,
    enabled: false
  },
  {
    id: "immersive-media-brief",
    title: "Immersive Media Brief",
    topic: "AI-video, dome, mapping and model news",
    schedule: "0 21 * * 1",
    prompt: "Prepare a weekly brief of meaningful news from the last seven days about AI video, fulldome and dome production, immersive media, projection mapping, creative tools and model releases. Prefer primary sources and official release notes. Separate verified facts from interpretation, include dates and links, and explain what matters for a small studio making cinematic immersive work.",
    provider: "openrouter",
    model: WEB_SEARCH_MODEL,
    enabled: false
  },
  {
    id: "h3-max-director-watch",
    title: "H3 Max Director Watch",
    topic: "Video-model and video-directing tool updates",
    schedule: "0 10 * * *",
    prompt: "Track current updates to video-generation models and tools useful for directing: controllable camera motion, character and reference consistency, image-to-video, editing, storyboarding, audio, API changes, limits and licensing. Focus on changes that affect a director's workflow, compare with the previous known state, cite official sources, and flag hype or unverified claims.",
    provider: "openrouter",
    model: WEB_SEARCH_MODEL,
    enabled: false
  }
];
