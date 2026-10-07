export type AutoStrategy = "economy" | "balanced" | "quality";

export type PersonaModelPreferences = {
  autoMode: boolean;
  autoStrategy: AutoStrategy;
  manualModelId: string;
  manualRouteKey: string;
};

export const defaultPersonaModelPreferences: PersonaModelPreferences = {
  autoMode: false,
  autoStrategy: "balanced",
  manualModelId: "",
  manualRouteKey: ""
};

export function parsePersonaModelPreferences(value: string | null): PersonaModelPreferences {
  if (!value) return { ...defaultPersonaModelPreferences };
  try {
    const parsed = JSON.parse(value) as Partial<PersonaModelPreferences>;
    return {
      autoMode: parsed.autoMode === true,
      autoStrategy: ["economy", "balanced", "quality"].includes(String(parsed.autoStrategy))
        ? parsed.autoStrategy as AutoStrategy
        : "balanced",
      manualModelId: typeof parsed.manualModelId === "string" ? parsed.manualModelId : "",
      manualRouteKey: typeof parsed.manualRouteKey === "string" ? parsed.manualRouteKey : ""
    };
  } catch {
    return { ...defaultPersonaModelPreferences };
  }
}

export function setAutoMode(
  preferences: PersonaModelPreferences,
  autoMode: boolean
): PersonaModelPreferences {
  return { ...preferences, autoMode };
}

export function setManualModel(
  preferences: PersonaModelPreferences,
  manualModelId: string,
  manualRouteKey = ""
): PersonaModelPreferences {
  return { ...preferences, manualModelId, manualRouteKey };
}

export function setManualRoute(
  preferences: PersonaModelPreferences,
  manualRouteKey: string
): PersonaModelPreferences {
  return { ...preferences, manualRouteKey };
}
