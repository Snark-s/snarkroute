import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("Living Canvas provider sources", () => {
  it("shows RuTronix in the existing provider library", () => {
    const main = readFileSync(fileURLToPath(new URL("../src/main.tsx", import.meta.url)), "utf8");
    expect(main).toContain('{ id: "rutronix", title: "RuTronix"');
    expect(main).toContain('settingsEndpoint: "/api/settings/rutronix-token"');
    expect(main).not.toContain('type: "rutronix.');
  });

  it("shows KIE.ai as a connection for the provider-neutral model library", () => {
    const main = readFileSync(fileURLToPath(new URL("../src/main.tsx", import.meta.url)), "utf8");
    expect(main).toContain('{ id: "kie", title: "KIE.ai"');
    expect(main).toContain('settingsEndpoint: "/api/settings/kie-token"');
    expect(main).toContain('testEndpoint: "/api/providers/kie/test"');
    expect(main).not.toContain('type: "kie.');
  });
});
