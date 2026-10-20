import { describe, expect, it } from "vitest";
import { applyEnvFile } from "./env-loader";

describe("applyEnvFile", () => {
  it("lets an edited .env win over the launcher's stale copy, but keeps launcher-owned keys", () => {
    const env: NodeJS.ProcessEnv = {
      LOCAL_LLM_BASE_URL: "http://127.0.0.1:8081/v1",
      API_PORT: "4317",
      SNARKROUTE_LAUNCHER_TOKEN: "t"
    };
    applyEnvFile({ LOCAL_LLM_BASE_URL: "http://127.0.0.1:8092/v1", API_PORT: "9999", SNARKROUTE_LAUNCHER_TOKEN: "x", NEW_KEY: "v" }, env);
    expect(env).toEqual({
      LOCAL_LLM_BASE_URL: "http://127.0.0.1:8092/v1",
      API_PORT: "4317",
      SNARKROUTE_LAUNCHER_TOKEN: "t",
      NEW_KEY: "v"
    });
  });
});
