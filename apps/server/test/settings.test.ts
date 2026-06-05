import { describe, expect, it } from "vitest";

describe("settings API", () => {
  it("refuses to start with APP_DEV_UI enabled in production", async () => {
    const previousDevUi = process.env.APP_DEV_UI;
    const previousNodeEnv = process.env.NODE_ENV;
    process.env.APP_DEV_UI = "true";
    process.env.NODE_ENV = "production";
    const { buildServer } = await import("../src/app");

    try {
      expect(() => buildServer()).toThrow("APP_DEV_UI must not be enabled in production");
    } finally {
      if (previousDevUi === undefined) delete process.env.APP_DEV_UI;
      else process.env.APP_DEV_UI = previousDevUi;
      if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previousNodeEnv;
    }
  });

  it("refuses unsafe production cloud auth configuration", async () => {
    const previous = snapshotEnv(["APP_DEV_UI", "NODE_ENV", "APP_MODE", "AUTH_HASH_SECRET", "AUTH_BASE_URL", "APP_WEB_URL"]);
    const { buildServer } = await import("../src/app");

    try {
      process.env.APP_DEV_UI = "false";
      process.env.NODE_ENV = "production";
      process.env.APP_MODE = "cloud";
      delete process.env.AUTH_HASH_SECRET;
      process.env.AUTH_BASE_URL = "https://api.example.com";
      process.env.APP_WEB_URL = "https://app.example.com";
      expect(() => buildServer()).toThrow("AUTH_HASH_SECRET is required in production cloud mode");

      process.env.AUTH_HASH_SECRET = "short";
      expect(() => buildServer()).toThrow("AUTH_HASH_SECRET must be at least 32 characters in production cloud mode");

      process.env.AUTH_HASH_SECRET = "0123456789abcdef0123456789abcdef";
      process.env.AUTH_BASE_URL = "http://127.0.0.1:4317";
      expect(() => buildServer()).toThrow("AUTH_BASE_URL must not point to localhost in production cloud mode");

      process.env.AUTH_BASE_URL = "https://api.example.com";
      process.env.APP_WEB_URL = "http://localhost:5173";
      expect(() => buildServer()).toThrow("APP_WEB_URL must not point to localhost in production cloud mode");
    } finally {
      restoreEnv(previous);
    }
  });

  it("returns local Boojum capabilities by default", async () => {
    process.env.SNARKROUTE_NO_LISTEN = "1";
    const previousProduct = process.env.APP_PRODUCT;
    const previousMode = process.env.APP_MODE;
    delete process.env.APP_PRODUCT;
    delete process.env.APP_MODE;
    const { buildServer } = await import("../src/index");
    const app = buildServer();

    try {
      const response = await app.inject({ method: "GET", url: "/api/capabilities" });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        product: "boojum",
        mode: "local",
        authRequiredForSave: false,
        supportsCredits: false,
        supportsGuestDemo: true,
        supportsUserApiKeys: true,
        supportsBrowserVault: false,
        supportsCloudStoredUserKeys: false,
        supportsLocalFilesystem: true,
        supportsPublicSharing: false
      });
    } finally {
      await app.close();
      if (previousProduct === undefined) delete process.env.APP_PRODUCT;
      else process.env.APP_PRODUCT = previousProduct;
      if (previousMode === undefined) delete process.env.APP_MODE;
      else process.env.APP_MODE = previousMode;
      delete process.env.SNARKROUTE_NO_LISTEN;
    }
  });

  it("returns cloud capability gates from APP_PRODUCT and APP_MODE", async () => {
    process.env.SNARKROUTE_NO_LISTEN = "1";
    const previousProduct = process.env.APP_PRODUCT;
    const previousMode = process.env.APP_MODE;
    process.env.APP_PRODUCT = "snark";
    process.env.APP_MODE = "cloud";
    const { buildServer } = await import("../src/index");
    const app = buildServer();

    try {
      const response = await app.inject({ method: "GET", url: "/api/capabilities" });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        product: "snark",
        mode: "cloud",
        authRequiredForSave: true,
        supportsCredits: true,
        supportsGuestDemo: true,
        supportsUserApiKeys: false,
        supportsLocalFilesystem: false
      });
    } finally {
      await app.close();
      if (previousProduct === undefined) delete process.env.APP_PRODUCT;
      else process.env.APP_PRODUCT = previousProduct;
      if (previousMode === undefined) delete process.env.APP_MODE;
      else process.env.APP_MODE = previousMode;
      delete process.env.SNARKROUTE_NO_LISTEN;
    }
  });

  it("keeps local filesystem enabled for Boojum even when APP_MODE is cloud", async () => {
    process.env.SNARKROUTE_NO_LISTEN = "1";
    const previousProduct = process.env.APP_PRODUCT;
    const previousMode = process.env.APP_MODE;
    process.env.APP_PRODUCT = "boojum";
    process.env.APP_MODE = "cloud";
    const { buildServer } = await import("../src/index");
    const app = buildServer();

    try {
      const response = await app.inject({ method: "GET", url: "/api/capabilities" });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        product: "boojum",
        mode: "cloud",
        supportsLocalFilesystem: true
      });
    } finally {
      await app.close();
      if (previousProduct === undefined) delete process.env.APP_PRODUCT;
      else process.env.APP_PRODUCT = previousProduct;
      if (previousMode === undefined) delete process.env.APP_MODE;
      else process.env.APP_MODE = previousMode;
      delete process.env.SNARKROUTE_NO_LISTEN;
    }
  });

  it("returns API token statuses without token values", async () => {
    process.env.SNARKROUTE_NO_LISTEN = "1";
    const previousToken = process.env.REPLICATE_API_TOKEN;
    const previousGeminiToken = process.env.GEMINI_API_KEY;
    const previousOpenRouterToken = process.env.OPENROUTER_API_KEY;
    const previousSeedanceBackend = process.env.SEEDANCE_PROVIDER_BACKEND;
    const previousArkToken = process.env.ARK_API_KEY;
    const previousSeedanceToken = process.env.SEEDANCE_API_KEY;
    process.env.REPLICATE_API_TOKEN = "test-secret-token";
    process.env.GEMINI_API_KEY = "test-gemini-secret-key";
    process.env.OPENROUTER_API_KEY = "sk-or-test-secret-key";
    process.env.SEEDANCE_PROVIDER_BACKEND = "byteplus-modelark";
    process.env.ARK_API_KEY = "ark-test-secret-b740";
    const { buildServer } = await import("../src/index");
    const app = buildServer();

    try {
      const response = await app.inject({ method: "GET", url: "/api/settings" });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ replicate: { configured: true }, gemini: { configured: true }, openrouter: { configured: true }, seedance: { configured: true, backend: "byteplus-modelark", apiKeyEnvKey: "ARK_API_KEY" } });
      expect(response.body).not.toContain("test-secret-token");
      expect(response.body).not.toContain("test-gemini-secret-key");
      expect(response.body).not.toContain("sk-or-test-secret-key");
      expect(response.body).not.toContain("ark-test-secret-b740");
      expect(response.json().openrouter.maskedApiKey).toContain("****");
      expect(response.json().seedance.maskedApiKey).toContain("****");
    } finally {
      await app.close();
      if (previousToken === undefined) delete process.env.REPLICATE_API_TOKEN;
      else process.env.REPLICATE_API_TOKEN = previousToken;
      if (previousGeminiToken === undefined) delete process.env.GEMINI_API_KEY;
      else process.env.GEMINI_API_KEY = previousGeminiToken;
      if (previousOpenRouterToken === undefined) delete process.env.OPENROUTER_API_KEY;
      else process.env.OPENROUTER_API_KEY = previousOpenRouterToken;
      if (previousSeedanceBackend === undefined) delete process.env.SEEDANCE_PROVIDER_BACKEND;
      else process.env.SEEDANCE_PROVIDER_BACKEND = previousSeedanceBackend;
      if (previousArkToken === undefined) delete process.env.ARK_API_KEY;
      else process.env.ARK_API_KEY = previousArkToken;
      if (previousSeedanceToken === undefined) delete process.env.SEEDANCE_API_KEY;
      else process.env.SEEDANCE_API_KEY = previousSeedanceToken;
      delete process.env.SNARKROUTE_NO_LISTEN;
    }
  });

  it("does not mark Seedance configured when only a key is present", async () => {
    process.env.SNARKROUTE_NO_LISTEN = "1";
    const previousBackend = process.env.SEEDANCE_PROVIDER_BACKEND;
    const previousToken = process.env.SEEDANCE_API_KEY;
    const previousBaseUrl = process.env.SEEDANCE_API_BASE_URL;
    delete process.env.SEEDANCE_PROVIDER_BACKEND;
    process.env.SEEDANCE_API_KEY = "seed-secret-key";
    delete process.env.SEEDANCE_API_BASE_URL;
    const { buildServer } = await import("../src/index");
    const app = buildServer();
    try {
      const response = await app.inject({ method: "GET", url: "/api/settings" });
      expect(response.statusCode).toBe(200);
      expect(response.json().seedance).toMatchObject({ configured: false, statusText: "key saved, provider/base URL not verified" });
    } finally {
      await app.close();
      if (previousBackend === undefined) delete process.env.SEEDANCE_PROVIDER_BACKEND;
      else process.env.SEEDANCE_PROVIDER_BACKEND = previousBackend;
      if (previousToken === undefined) delete process.env.SEEDANCE_API_KEY;
      else process.env.SEEDANCE_API_KEY = previousToken;
      if (previousBaseUrl === undefined) delete process.env.SEEDANCE_API_BASE_URL;
      else process.env.SEEDANCE_API_BASE_URL = previousBaseUrl;
      delete process.env.SNARKROUTE_NO_LISTEN;
    }
  });

  it("returns provider links including OpenRouter", async () => {
    process.env.SNARKROUTE_NO_LISTEN = "1";
    const { buildServer } = await import("../src/index");
    const app = buildServer();
    try {
      const response = await app.inject({ method: "GET", url: "/api/providers/links" });
      expect(response.statusCode).toBe(200);
      expect(response.json().openrouter.apiKeysUrl).toBe("https://openrouter.ai/settings/keys");
      expect(response.json().seedance.byteplusApiKeysUrl).toBe("https://console.byteplus.com/ark/region:ark+ap-southeast-1/apiKey");
    } finally {
      await app.close();
      delete process.env.SNARKROUTE_NO_LISTEN;
    }
  });
});

function snapshotEnv(keys: string[]): Record<string, string | undefined> {
  return Object.fromEntries(keys.map((key) => [key, process.env[key]]));
}

function restoreEnv(snapshot: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(snapshot)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}
