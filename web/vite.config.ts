import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// `npm run dev` starts the API on its own port and passes it through as
// CRATE_API, because 8080 is usually taken by a Crate container already running
// on the host. Run bare `npm run dev:ui` and it assumes the API at 8080.
const api = process.env.CRATE_API || "http://127.0.0.1:8080";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      "/api": api,
      // Built by the server so it carries the instance's configured name.
      "/manifest.webmanifest": api,
    },
  },
  build: {
    outDir: "dist",
  },
});
