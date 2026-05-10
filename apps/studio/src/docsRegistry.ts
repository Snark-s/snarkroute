import capabilitiesEn from "../../../docs/CAPABILITIES.md?raw";
import capabilitiesRu from "../../../docs/CAPABILITIES_ru.md?raw";
import promptLibraryRu from "../../../docs/prompt-library_ru.md?raw";
import openRouterEn from "../../../docs/openrouter.md?raw";
import openRouterRu from "../../../docs/openrouter_ru.md?raw";
import newUserGuideEn from "../../../docs/SnarkRoute_for_new_user_en.md?raw";
import newUserGuideRu from "../../../docs/SnarkRoute_for_new_user_ru.md?raw";

export type StudioDocKind = "capabilities" | "new-user-guide" | "prompt-library" | "openrouter";
export type StudioDocLanguage = "en" | "ru";

export type StudioDocEntry = {
  id: string;
  title: string;
  language: StudioDocLanguage;
  kind: StudioDocKind;
  content: string;
};

export const studioDocs: StudioDocEntry[] = [
  {
    id: "openrouter-en",
    title: "OpenRouter setup",
    language: "en",
    kind: "openrouter",
    content: openRouterEn
  },
  {
    id: "openrouter-ru",
    title: "OpenRouter",
    language: "ru",
    kind: "openrouter",
    content: openRouterRu
  },
  {
    id: "new-user-guide-ru",
    title: "Кратко для нового пользователя",
    language: "ru",
    kind: "new-user-guide",
    content: newUserGuideRu
  },
  {
    id: "new-user-guide-en",
    title: "New user guide",
    language: "en",
    kind: "new-user-guide",
    content: newUserGuideEn
  },
  {
    id: "prompt-library-ru",
    title: "Библиотека промптов",
    language: "ru",
    kind: "prompt-library",
    content: promptLibraryRu
  },
  {
    id: "capabilities-en",
    title: "Capabilities",
    language: "en",
    kind: "capabilities",
    content: capabilitiesEn
  },
  {
    id: "capabilities-ru",
    title: "Подробный обзор всего",
    language: "ru",
    kind: "capabilities",
    content: capabilitiesRu
  }
];
