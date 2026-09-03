import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { h3VastConfigStatus } from "./h3-session-runtime";

const directories: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("H3 managed Vast configuration", () => {
  it("is ready for the SSH-tunnel mode without a public worker URL", () => {
    const directory = mkdtempSync(join(tmpdir(), "h3-vast-config-"));
    directories.push(directory);
    const key = join(directory, "id_ed25519");
    writeFileSync(key, "test key");
    vi.stubEnv("VAST_API_KEY", "vast-key");
    vi.stubEnv("HF_TOKEN", "hf-test-token");
    vi.stubEnv("H3_WORKER_SERVICE_TOKEN", "service-token");
    vi.stubEnv("H3_ACCEPT_MODEL_LICENSE", "1");
    vi.stubEnv("H3_VAST_TEMPLATE_HASH", "template-hash");
    vi.stubEnv("H3_VAST_CONNECTION_MODE", "ssh_tunnel");
    vi.stubEnv("H3_VAST_SSH_PRIVATE_KEY", key);
    vi.stubEnv("H3_VAST_WORKER_URL_TEMPLATE", "");

    const status = h3VastConfigStatus();
    expect(status).toMatchObject({ configured: true, connectionMode: "ssh_tunnel", sshKeyConfigured: true, workerUrlTemplateConfigured: false });
  });

  it("fails closed when the configured private key is missing", () => {
    vi.stubEnv("VAST_API_KEY", "vast-key");
    vi.stubEnv("HF_TOKEN", "hf-test-token");
    vi.stubEnv("H3_WORKER_SERVICE_TOKEN", "service-token");
    vi.stubEnv("H3_ACCEPT_MODEL_LICENSE", "1");
    vi.stubEnv("H3_VAST_TEMPLATE_HASH", "template-hash");
    vi.stubEnv("H3_VAST_CONNECTION_MODE", "ssh_tunnel");
    vi.stubEnv("H3_VAST_SSH_PRIVATE_KEY", join(tmpdir(), "missing-h3-private-key"));

    expect(h3VastConfigStatus()).toMatchObject({ configured: false, sshKeyConfigured: false });
  });
});
