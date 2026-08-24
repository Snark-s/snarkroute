import { describe, expect, it } from "vitest";
import { deleteEnvLine } from "./env";

describe("environment secret editing", () => {
  it("removes only the requested secret line", () => {
    expect(deleteEnvLine("OPENROUTER_API_KEY=keep\r\nKIE_API_KEY=remove\r\nAPP_MODE=local\r\n", "KIE_API_KEY"))
      .toBe("OPENROUTER_API_KEY=keep\r\nAPP_MODE=local\r\n");
  });

  it("leaves an environment file unchanged when the key is absent", () => {
    expect(deleteEnvLine("APP_MODE=local\n", "KIE_API_KEY")).toBe("APP_MODE=local\n");
  });

  it("removes duplicate definitions so a restart cannot restore an old key", () => {
    expect(deleteEnvLine("KIE_API_KEY=old\nAPP_MODE=local\nKIE_API_KEY=new\n", "KIE_API_KEY")).toBe("APP_MODE=local\n");
  });
});
