import { VastClient, type VastTemplate, type VastTemplateInput } from "./vast-client";

export const H3_VAST_SOURCE_REVISION = "a5e3a57c0806ee10d719f0631eee7fb61f51124c";
export const H3_VAST_IMAGE = "vastai/pytorch";
export const H3_VAST_IMAGE_TAG = "2.13.0-cu130-cuda-13.2-mini-py312-2026-09-01";

export function buildH3VastTemplateInput(): VastTemplateInput {
  return {
    name: "SnarkRoute H3 FL2VA kitchen_int8",
    description: "Private one-click SnarkRoute H3 worker. Starts pinned FL2VA/kitchen_int8 and is reached through a local SSH tunnel.",
    readme: [
      "Created by SnarkRoute H3 Studio.",
      `Source revision: ${H3_VAST_SOURCE_REVISION}`,
      `Base image: ${H3_VAST_IMAGE}:${H3_VAST_IMAGE_TAG}`,
      "Secrets are supplied only when an instance is created and are not stored in this template.",
      "The worker binds to localhost:18080; SnarkRoute opens the SSH tunnel automatically.",
      "Destroy the instance, rather than merely stopping it, to end compute and local-disk billing."
    ].join("\n"),
    image: H3_VAST_IMAGE,
    tag: H3_VAST_IMAGE_TAG,
    env: `-e H3_SNARKROUTE_REVISION=${H3_VAST_SOURCE_REVISION}`,
    onstart: buildOnstartScript(),
    extraFilters: {
      verified: { eq: true },
      rentable: { eq: true },
      rented: { eq: false },
      num_gpus: { eq: 1 },
      gpu_ram: { gte: 49_152 },
      cpu_ram: { gte: 262_144 },
      disk_space: { gte: 300 },
      reliability2: { gte: 0.985 },
      cuda_max_good: { gte: 13.2 },
      direct_port_count: { gte: 2 },
      cpu_arch: { eq: "amd64" }
    },
    recommendedDiskSpaceGb: 300
  };
}

export async function createH3VastTemplate(apiKey: string, fetchImpl?: typeof fetch): Promise<VastTemplate> {
  const client = new VastClient({ apiKey, fetchImpl });
  return client.createTemplate(buildH3VastTemplateInput());
}

function buildOnstartScript(): string {
  return [
    "set -Eeuo pipefail",
    "umask 077",
    'test "${H3_ACCEPT_MODEL_LICENSE:-}" = "1" || { echo "fatal: H3 model license was not accepted" >&2; exit 1; }',
    'test -n "${HF_TOKEN:-}" || { echo "fatal: HF_TOKEN is missing" >&2; exit 1; }',
    'test -n "${H3_WORKER_SERVICE_TOKEN:-}" || { echo "fatal: H3_WORKER_SERVICE_TOKEN is missing" >&2; exit 1; }',
    `REVISION="\${H3_SNARKROUTE_REVISION:-${H3_VAST_SOURCE_REVISION}}"`,
    "APP_DIR=/workspace/snarkroute-h3",
    "ARCHIVE=/workspace/snarkroute-h3-source.tar.gz",
    "if ! command -v curl >/dev/null || ! command -v tar >/dev/null; then",
    "  apt-get update",
    "  apt-get install -y --no-install-recommends ca-certificates curl tar",
    "  rm -rf /var/lib/apt/lists/*",
    "fi",
    'rm -rf "$APP_DIR"',
    'mkdir -p "$APP_DIR"',
    'curl -fL --retry 3 --retry-all-errors "https://github.com/Snark-s/snarkroute/archive/${REVISION}.tar.gz" -o "$ARCHIVE"',
    'tar -xzf "$ARCHIVE" -C "$APP_DIR" --strip-components=3 "snarkroute-${REVISION}/workers/minimax-h3"',
    'printf \'%s\' "$HF_TOKEN" > "$APP_DIR/.hf_token"',
    'printf \'H3_WORKER_SERVICE_TOKEN=%q\\nH3_ACCEPT_MODEL_LICENSE=1\\n\' "$H3_WORKER_SERVICE_TOKEN" > "$APP_DIR/.runtime.env"',
    'chmod 600 "$APP_DIR/.hf_token" "$APP_DIR/.runtime.env"',
    "unset HF_TOKEN H3_WORKER_SERVICE_TOKEN",
    'nohup bash "$APP_DIR/scripts/bootstrap_vast_fl2va.sh" >>/workspace/bootstrap.log 2>&1 &'
  ].join("\n");
}
