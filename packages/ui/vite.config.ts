import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { "@henry/shared": new URL("../shared/src/index.ts", import.meta.url).pathname } },
  server: {
    host: "127.0.0.1",
    port: 5173,
    proxy: {
      "/ws": { target: "ws://127.0.0.1:4711", ws: true },
      "/api": { target: "http://127.0.0.1:4711" },
    },
  },
});
