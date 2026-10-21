import { describe, expect, it, vi } from "vitest";
import { createLauncherRestartControl } from "../../../scripts/launcher-control.mjs";
import {
  LISTEN_EADDRINUSE_DELAY_MS,
  LISTEN_EADDRINUSE_RETRIES,
  listenWithPortRetry,
} from "../src/server";

describe("launcher restart race", () => {
  it("waits for shutdown and a free port before starting, then reports healthy", async () => {
    const events: string[] = [];
    let oldProcessExited = false;
    let portChecks = 0;

    const control = createLauncherRestartControl({
      apiPort: 4317,
      owned: () => !oldProcessExited,
      serverPid: () => (oldProcessExited ? undefined : 55052),
      stop: async () => {
        events.push("shutdown");
        oldProcessExited = true;
        events.push("old-exited");
      },
      portOpen: async () => {
        portChecks += 1;
        events.push(`port-check-${portChecks}`);
        return false;
      },
      start: async () => events.push("start"),
      cleanup: async () => events.push("cleanup"),
      healthy: async () => {
        events.push("healthy");
        return true;
      },
      wait: async () => undefined,
    });

    control.restart();
    await control.wait();

    expect(events).toEqual(["shutdown", "old-exited", "port-check-1", "start", "healthy"]);
    expect(control.status().operation).toMatchObject({ state: "healthy", action: "restart" });
  });

  it("retries EADDRINUSE and succeeds once the API socket is released", async () => {
    const listen = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error("busy"), { code: "EADDRINUSE" }))
      .mockRejectedValueOnce(Object.assign(new Error("still busy"), { code: "EADDRINUSE" }))
      .mockResolvedValue("http://127.0.0.1:4317");
    const wait = vi.fn(async () => undefined);

    await expect(listenWithPortRetry(
      { listen } as never,
      { port: 4317, host: "127.0.0.1", wait },
    )).resolves.toBe("http://127.0.0.1:4317");

    expect(listen).toHaveBeenCalledTimes(3);
    expect(wait).toHaveBeenCalledTimes(2);
    expect(wait).toHaveBeenCalledWith(LISTEN_EADDRINUSE_DELAY_MS);
  });

  it("fails after the configured EADDRINUSE retry budget", async () => {
    const error = Object.assign(new Error("still busy"), { code: "EADDRINUSE" });
    const listen = vi.fn().mockRejectedValue(error);

    await expect(listenWithPortRetry(
      { listen } as never,
      { port: 4317, host: "127.0.0.1", wait: async () => undefined },
    )).rejects.toBe(error);

    expect(listen).toHaveBeenCalledTimes(LISTEN_EADDRINUSE_RETRIES + 1);
  });
});
