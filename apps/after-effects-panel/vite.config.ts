import react from "@vitejs/plugin-react";
import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  base: "./",
  plugins: [react()],
  test: { environment: "node", exclude: [...configDefaults.exclude, "**/dist-types/**"] },
  build: { outDir: "dist", emptyOutDir: true }
});
