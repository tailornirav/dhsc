import { defineConfig } from "drizzle-kit";

/**
 * Drizzle-kit config for DHSC.
 *
 * `generate` only needs `schema`, `out`, `dialect`, and `driver` — it reads the
 * schema file and emits SQL into `src/db/migrations`. That is the ONLY drizzle-kit
 * command this project uses day to day; migrations are applied with
 * `wrangler d1 migrations apply` (see tech.md §11), which is the source of truth.
 *
 * `dbCredentials` are only consumed by `drizzle-kit push` / `drizzle-kit migrate`
 * (an alternative to the wrangler migration runner). If you ever use those, drizzle-kit
 * auto-loads a gitignored `.env` in this directory — see `.env.example` for the shape.
 * Never commit real values (hard rule: secrets never in code).
 */
export default defineConfig({
  dialect: "sqlite",
  driver: "d1-http",
  schema: "./src/db/schema.ts",
  out: "./src/db/migrations",
  verbose: true,
  strict: true,
  dbCredentials: {
    accountId: process.env.CLOUDFLARE_ACCOUNT_ID ?? "",
    databaseId: process.env.CLOUDFLARE_DATABASE_ID ?? "",
    token: process.env.CLOUDFLARE_D1_TOKEN ?? "",
  },
});
