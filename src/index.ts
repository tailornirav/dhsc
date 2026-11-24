import { Hono } from "hono";

/** Cloudflare bindings available to the Worker. */
export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  SMS_QUEUE: Queue;
  SENDMODE_ACCESS_KEY: string;
}

const app = new Hono<{ Bindings: Env }>();

app.get("/api/health", (c) => c.json({ status: "ok" }));

export default {
  fetch: app.fetch,
  async queue(_batch: MessageBatch, _env: Env): Promise<void> {
    // No-op consumer for now; routing by message `type` lands in Phase 7.
  },
};
