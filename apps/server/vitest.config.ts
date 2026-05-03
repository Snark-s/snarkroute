import { defineConfig } from "vitest/config";
import { snarkrouteAliases } from "../../vitest.shared";

export default defineConfig({
  resolve: {
    alias: snarkrouteAliases
  },
  test: {
    environment: "node"
  }
});
