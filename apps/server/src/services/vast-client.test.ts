import { describe, expect, it, vi } from "vitest";
import { VastClient, selectH3VastOffer } from "./vast-client";

describe("VastClient", () => {
  it("selects the cheapest safe H3 offer below the configured ceiling and outside excluded regions", () => {
    const selected = selectH3VastOffer([
      { id: 1, dph_total: 0.75, gpu_name: "RTX 4090", gpu_ram: 49152, cpu_ram: 262144, disk_space: 500, cuda_max_good: 13, reliability2: 0.99, direct_port_count: 2, geolocation: "Texas, US", num_gpus: 1 },
      { id: 2, dph_total: 1.05, gpu_name: "RTX 6000 Ada", gpu_ram: 49152, cpu_ram: 270000, disk_space: 400, cuda_max_good: 13.1, reliability2: 0.995, direct_port_count: 2, geolocation: "Tokyo, JP", num_gpus: 1 },
      { id: 3, dph_total: 1.25, gpu_name: "RTX 6000 Ada", gpu_ram: 49152, cpu_ram: 270000, disk_space: 400, cuda_max_good: 13.1, reliability2: 0.995, direct_port_count: 2, geolocation: "Osaka, JP", num_gpus: 1 }
    ], { maxHourlyUsd: 1.2, excludedCountryCodes: ["US", "GB", "KR"] });
    expect(selected?.id).toBe(2);
  });

  it("fails closed when an offer has no country or enough direct ports", () => {
    const base = { dph_total: 0.5, gpu_name: "GPU", gpu_ram: 49152, cpu_ram: 262144, disk_space: 300, cuda_max_good: 13, reliability2: 0.99, num_gpus: 1 };
    expect(selectH3VastOffer([
      { ...base, id: 1, direct_port_count: 2 },
      { ...base, id: 2, direct_port_count: 1, geolocation: "JP" }
    ], { maxHourlyUsd: 1 })).toBeNull();
  });

  it("destroys only the exact instance id and treats a subsequent 404 as confirmed absence", async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> => new Response())
      .mockResolvedValueOnce(new Response(JSON.stringify({ success: true }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ success: false, error: "not_found" }), { status: 404 }));
    const client = new VastClient({ apiKey: "vast-secret", fetchImpl: fetchImpl as typeof fetch });
    await client.destroyAndConfirm(49258049, { retries: 1, delayMs: 0 });
    expect(fetchImpl.mock.calls[0]?.[0]).toBe("https://console.vast.ai/api/v0/instances/49258049");
    expect(fetchImpl.mock.calls[1]?.[0]).toBe("https://console.vast.ai/api/v0/instances/49258049");
  });
});
