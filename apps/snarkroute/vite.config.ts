import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const snarkRoutePort = Number(process.env.SNARKROUTE_PORT || env.SNARKROUTE_PORT || 5174);

  return {
    plugins: [react()],
    server: {
      host: "127.0.0.1",
      port: snarkRoutePort,
      strictPort: true
    }
  };
});
