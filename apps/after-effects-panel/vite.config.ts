import react from "@vitejs/plugin-react";
import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  base: "./",
  plugins: [react()],
  test: { environment: "node", exclude: [...configDefaults.exclude, "**/dist-types/**"] },
  define: { __SNARKROUTE_BUILD_ID__: JSON.stringify(process.env.SNARKROUTE_BUILD_ID ?? new Date().toISOString()) },
  build: { outDir: "dist", emptyOutDir: true }
});
