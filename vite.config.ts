import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": "http://127.0.0.1:4310",
      "/collaboration": { target: "ws://127.0.0.1:4311", ws: true },
    },
  },
  preview: {
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": "http://127.0.0.1:4310",
      "/collaboration": { target: "ws://127.0.0.1:4311", ws: true },
    },
  },
  build: { sourcemap: false, manifest: true },
});
