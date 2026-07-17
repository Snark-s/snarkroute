import react from "@vitejs/plugin-react";
import { execFileSync } from "node:child_process";
import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  base: "./",
  plugins: [react()],
  test: { environment: "node", exclude: [...configDefaults.exclude, "**/dist-types/**"] },
  define: { __SNARKROUTE_BUILD_COMMIT__: JSON.stringify(buildCommit()), __SNARKROUTE_BUILD_TIMESTAMP__: JSON.stringify(new Date().toISOString().replace(/\.\d{3}Z$/, "Z")) },
  build: { outDir: "dist", emptyOutDir: true }
});

function buildCommit(): string { try { return execFileSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim() || "commit unknown"; } catch { return "commit unknown"; } }
