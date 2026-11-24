import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

/**
 * Vite config for the DHSC dashboard SPA.
 *
 * `web/` is the Vite root (see the root `package.json` build script: `vite build web`), so the
 * built output lands in `web/dist` — exactly the directory `wrangler.jsonc` serves through the
 * `ASSETS` binding. Assets are emitted as hashed, same-origin files so the Worker's strict CSP
 * (`script-src 'self'`) holds (see `src/lib/hardening.ts`).
 *
 * Dev proxy: in `npm run dev` the dashboard runs on Vite's own port and forwards every `/api/*`
 * call to the locally-running Worker (`wrangler dev`, default 8787). That keeps the browser on
 * one origin in dev too, so no CORS layer is ever needed (hard rule #1/#2: one Cloudflare stack,
 * one auth model).
 */
const WORKER_DEV_ORIGIN = process.env.WORKER_DEV_ORIGIN ?? "http://127.0.0.1:8787";

/**
 * Build-time config defaults for the SPA. `VITE_SENDER_ID`/`VITE_ENVIRONMENT` are non-secret
 * values baked into the bundle (see `web/src/config.ts`). They are defined here with safe
 * fallbacks so a bare `npm run build` (with no shell env) still produces a configured bundle
 * instead of silently reverting the sender ID to the `DHSC` default. An explicit environment
 * variable still wins, so CI/deploy overrides keep working.
 */
const SENDER_ID = process.env.VITE_SENDER_ID ?? "Dilli Haat";
const ENVIRONMENT = process.env.VITE_ENVIRONMENT ?? "Production";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  define: {
    "import.meta.env.VITE_SENDER_ID": JSON.stringify(SENDER_ID),
    "import.meta.env.VITE_ENVIRONMENT": JSON.stringify(ENVIRONMENT),
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: WORKER_DEV_ORIGIN,
        changeOrigin: true,
      },
    },
  },
});
