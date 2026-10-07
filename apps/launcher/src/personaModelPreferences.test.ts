import { describe, expect, it } from "vitest";
import {
  defaultPersonaModelPreferences,
  parsePersonaModelPreferences,
  setAutoMode,
  setManualModel,
  setManualRoute
} from "./personaModelPreferences";

describe("Jabberwock model preferences", () => {
  it("restores the last manual model and route after Auto is disabled", () => {
    let preferences = setManualModel(defaultPersonaModelPreferences, "manual-model");
    preferences = setManualRoute(preferences, "provider\0provider/model");
    preferences = setAutoMode(preferences, true);
    preferences = setAutoMode(preferences, false);

    expect(preferences.manualModelId).toBe("manual-model");
    expect(preferences.manualRouteKey).toBe("provider\0provider/model");
  });

  it("falls back safely when stored preferences are invalid", () => {
    expect(parsePersonaModelPreferences("not json")).toEqual(defaultPersonaModelPreferences);
  });
});
