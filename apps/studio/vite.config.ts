import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const apiBaseUrl = env.VITE_API_BASE_URL || "http://127.0.0.1:4317";

  return {
    plugins: [react()],
    server: {
      proxy: {
        "/api": apiBaseUrl
      }
    }
  };
});
