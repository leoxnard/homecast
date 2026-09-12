import { defineConfig } from "vite";

export default defineConfig({
  server: {
    port: 5173,
    // Large local masters are opened through the File System Access API, not
    // served — the dev server only ever ships the page itself (PLAN §4.2).
    fs: { strict: true },
  },
  build: {
    target: "es2022",
    sourcemap: true,
  },
});
