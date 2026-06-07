process.env.APP_MODE ??= "cloud";
process.env.APP_PRODUCT ??= "boojum";
process.env.APP_DEV_UI ??= "true";
process.env.BOOJUM_START_CREDITS ??= "0";
process.env.SNARKROUTE_NO_LISTEN ??= "1";
process.env.DATABASE_URL ??= "postgresql://snarkroute:snarkroute@127.0.0.1:5432/snarkroute";

const adminCookie = "boojum_dev_identity=admin";

async function main(): Promise<void> {
  const { buildServer } = await import("../apps/server/src/app");
  const { invalidatePricingCache } = await import("../apps/server/src/billing/pricing-service");
  const { getCloudStorage } = await import("../apps/server/src/services/cloud-storage");

  let app = await buildServer();
  await app.ready();
  try {
    await app.inject({ method: "GET", url: "/api/auth/current", headers: { cookie: adminCookie } });
    await postJson(app, "/api/admin/pricing/overrides", { provider: "polza", operation: "image.generate", markupPercent: 0, markupCredits: 0, enabled: false, reason: "durable pricing smoke reset" });
    await postJson(app, "/api/admin/pricing/config", { globalMarkupPercent: 25, globalMarkupCredits: 0, minChargeCredits: 0, reason: "durable pricing smoke" });
    const firstEstimate = await estimatePolza(app);
    assertEqual("global markup estimate", firstEstimate.totalEstimatedCredits, 50);

    await app.close();
    invalidatePricingCache();
    app = await buildServer();
    await app.ready();
    const restartedEstimate = await estimatePolza(app);
    assertEqual("restarted estimate", restartedEstimate.totalEstimatedCredits, 50);

    await postJson(app, "/api/admin/pricing/overrides", { provider: "polza", operation: "image.generate", markupPercent: 0, markupCredits: 5, enabled: true, reason: "durable pricing smoke override" });
    const overrideEstimate = await estimatePolza(app);
    assertEqual("override estimate", overrideEstimate.totalEstimatedCredits, 55);

    const previewEstimate = await estimatePreview(app);
    assertEqual("free preview estimate", previewEstimate.totalEstimatedCredits, 0);

    console.log(JSON.stringify({
      firstEstimate: firstEstimate.totalEstimatedCredits,
      restartedEstimate: restartedEstimate.totalEstimatedCredits,
      overrideEstimate: overrideEstimate.totalEstimatedCredits,
      previewEstimate: previewEstimate.totalEstimatedCredits
    }, null, 2));
  } finally {
    await app.close().catch(() => undefined);
    await getCloudStorage().close();
  }
}

async function postJson(app: Awaited<ReturnType<typeof import("../apps/server/src/app").buildServer>>, url: string, payload: unknown): Promise<unknown> {
  const response = await app.inject({ method: "POST", url, headers: { cookie: adminCookie }, payload });
  const body = response.json();
  if (response.statusCode >= 400) throw new Error(`${url} failed (${response.statusCode}): ${JSON.stringify(body)}`);
  return body;
}

async function estimatePolza(app: Awaited<ReturnType<typeof import("../apps/server/src/app").buildServer>>): Promise<any> {
  const response = await app.inject({
    method: "POST",
    url: "/api/routes/estimate",
    headers: { cookie: adminCookie },
    payload: {
      routeVersion: "0.1",
      route: { id: "pricing-durable-smoke", title: "Pricing Durable Smoke", author: {} },
      economics: { enabled: false },
      nodes: [{ id: "polza", type: "polza.image.generate", title: "Polza Image", params: { prompt: "red square" } }],
      edges: []
    }
  });
  const body = response.json();
  if (response.statusCode !== 200) throw new Error(`estimate failed (${response.statusCode}): ${JSON.stringify(body)}`);
  return body;
}

async function estimatePreview(app: Awaited<ReturnType<typeof import("../apps/server/src/app").buildServer>>): Promise<any> {
  const response = await app.inject({
    method: "POST",
    url: "/api/routes/estimate",
    headers: { cookie: adminCookie },
    payload: {
      routeVersion: "0.1",
      route: { id: "pricing-preview-smoke", title: "Pricing Preview Smoke", author: {} },
      economics: { enabled: false },
      nodes: [{ id: "preview", type: "preview.image", title: "Preview" }],
      edges: []
    }
  });
  const body = response.json();
  if (response.statusCode !== 200) throw new Error(`preview estimate failed (${response.statusCode}): ${JSON.stringify(body)}`);
  return body;
}

function assertEqual(label: string, actual: unknown, expected: unknown): void {
  if (actual !== expected) throw new Error(`${label}: expected ${expected}, got ${actual}.`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
