import react from "@vitejs/plugin-react";
import { loadEnv } from "vite";
import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  return {
    plugins: [react()],
    test: { exclude: [...configDefaults.exclude, "**/dist-types/**"] },
    server: { host: "127.0.0.1", port: Number(process.env.BRANDESHMYG_PORT || env.BRANDESHMYG_PORT || 5175), strictPort: true }
  };
});
