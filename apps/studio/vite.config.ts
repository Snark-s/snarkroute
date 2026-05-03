import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const apiBaseUrl = process.env.VITE_API_BASE_URL || env.VITE_API_BASE_URL || "http://127.0.0.1:4317";
  const studioPort = Number(process.env.STUDIO_PORT || env.STUDIO_PORT || 5173);

  return {
    plugins: [react()],
    server: {
      host: "127.0.0.1",
      port: studioPort,
      strictPort: true,
      proxy: {
        "/api": apiBaseUrl
      }
    }
  };
});
