import { afterEach, describe, expect, it, vi } from "vitest";
import { h3LocalWslStatus } from "./h3-local-wsl";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("local H3 WSL launcher", () => {
  it("recognizes a ready connection only at the configured local worker URL", () => {
    const local = h3LocalWslStatus({
      configured: true,
      connected: true,
      ready: true,
      workerUrl: "http://127.0.0.1:18080",
      backend: "matlow_int8",
      capabilities: [],
      activeJobs: 0,
    });

    expect(local).toMatchObject({
      workerUrl: "http://127.0.0.1:18080",
      distro: "Ubuntu-24.04",
      running: true,
    });
  });

  it("does not confuse a remote H3 worker with the local process", () => {
    const local = h3LocalWslStatus({
      configured: true,
      connected: true,
      ready: true,
      workerUrl: "https://gpu.example:8000",
      backend: "sglang",
      capabilities: [],
      activeJobs: 0,
    });

    expect(local.running).toBe(false);
  });

  it("rejects shell metacharacters in WSL launcher configuration", () => {
    vi.stubEnv("H3_LOCAL_WSL_START_SCRIPT", "/home/serge/h3/start.sh;reboot");

    expect(() => h3LocalWslStatus()).toThrow(/Invalid local H3 start script/);
  });
});
