import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  publicDir: "../snarkroute/public",
  server: { host: "127.0.0.1", port: Number(process.env.LAUNCHER_PORT ?? 5172), strictPort: true }
});
