import { defineConfig } from "vitest/config";
import { snarkrouteAliases } from "../../vitest.shared";

export default defineConfig({
  resolve: {
    alias: snarkrouteAliases
  },
  test: {
    environment: "node",
    // Each run writes temp files into its own folder, removed when the run ends.
    globalSetup: ["../../vitest.temp-sandbox.ts"]
  }
});
