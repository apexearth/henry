import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// HENRY_PORT points the dev server at a private daemon; the user's live one stays on 14711.
const daemon = process.env.HENRY_PORT ?? "14711";

export default defineConfig({
  plugins: [react()],
  // Henry is a local tool: ui/dist is what the daemon serves day to day, so keep it readable
  // (the build script's NODE_ENV=development also keeps React's full error messages).
  build: { minify: false, sourcemap: true },
  resolve: { alias: { "@henry/shared": fileURLToPath(new URL("../shared/src/index.ts", import.meta.url)) } },
  server: {
    host: "127.0.0.1",
    port: 14713,
    proxy: {
      "/ws": { target: `ws://127.0.0.1:${daemon}`, ws: true },
      "/api": { target: `http://127.0.0.1:${daemon}` },
    },
  },
});
