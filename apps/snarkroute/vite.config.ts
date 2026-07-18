import react from "@vitejs/plugin-react";
import { loadEnv } from "vite";
import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const snarkRoutePort = Number(process.env.SNARKROUTE_PORT || env.SNARKROUTE_PORT || 5174);

  return {
    plugins: [react()],
    test: { exclude: [...configDefaults.exclude, "**/dist-types/**"] },
    server: {
      host: "127.0.0.1",
      port: snarkRoutePort,
      strictPort: true
    }
  };
});
