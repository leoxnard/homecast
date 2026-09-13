import { appendFileSync } from "node:fs";
import { defineConfig } from "vite";

/**
 * Dev only: browsers that cannot be scripted (iOS Safari in the simulator)
 * report console errors to POST /__log, appended to .devlog.
 */
const devLog = {
  name: "homecast-dev-log",
  configureServer(server: { middlewares: { use: (path: string, fn: (req: any, res: any) => void) => void } }) {
    server.middlewares.use("/__log", (req, res) => {
      let body = "";
      req.on("data", (c: Buffer) => (body += c));
      req.on("end", () => {
        appendFileSync(".devlog", `${new Date().toISOString()} ${String(req.headers["user-agent"]).slice(0, 60)} ${body}\n`);
        res.end("ok");
      });
    });
  },
};

export default defineConfig({
  plugins: [devLog],
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
      "/api": { target: "http://127.0.0.1:3000" },
    },
  },
  build: {
    target: "es2022",
    sourcemap: true,
  },
});
