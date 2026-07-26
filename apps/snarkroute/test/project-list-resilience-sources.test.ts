import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("Living Canvas project list resilience", () => {
  it("keeps the project request independent from a failing current canvas request", () => {
    const main = readFileSync(fileURLToPath(new URL("../src/main.tsx", import.meta.url)), "utf8");
    const refreshLibrary = main.slice(
      main.indexOf("async function refreshLibrary()"),
      main.indexOf("async function refreshModelsAndProviders")
    );

    expect(refreshLibrary).toContain("Promise.allSettled");
    expect(refreshLibrary).toContain('projectListResult.status === "fulfilled"');
    expect(refreshLibrary).toContain("setProjects(projectListResult.value.projects)");
  });
});
