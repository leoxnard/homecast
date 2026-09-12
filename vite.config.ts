import { defineConfig } from "vite";

export default defineConfig({
  server: {
    port: 5173,
    // Large local masters are opened through the File System Access API, not
    // served — the dev server only ever ships the page itself (PLAN §4.2).
    fs: { strict: true },
    // Signalling runs in the Node server, not in Vite. Proxying it here means
    // the dev page talks to the same origin it will in production, so room
    // codes and `wss://` behave identically.
    //   terminal 1:  npm run serve:dev
    //   terminal 2:  npm run dev
    proxy: {
      "/ws": { target: "ws://127.0.0.1:3000", ws: true },
    },
  },
  build: {
    target: "es2022",
    sourcemap: true,
  },
});
