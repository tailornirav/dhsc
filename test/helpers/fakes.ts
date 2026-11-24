/**
 * Phase 6 test doubles: an in-memory D1 fake, a queue fake, and a Sendmode fetch stub.
 *
 * `node --test` has no D1 runtime, and pulling `miniflare` in would violate the "$0 / no new
 * dependency" rule (hard rule #1). So we fake the *narrow* SQL surface the Phase 6 code uses,
 * matched by statement shape. That keeps the tests honest about the queries the code issues
 * (a query string change breaks the fake, which is what we want) without re-implementing
 * SQLite.
 *
 * The fakes are intentionally dumb: they store rows as plain objects and return them in the
 * shapes the `src/db/client.ts` helpers expect (`{ results }` for `.all`, a row for
 * `.first`, `{ meta: { changes } }` for `.run`).
 */

import type { QueueMessage } from "../../src/queue/messages.js";

// ---------------------------------------------------------------------------------------
// In-memory D1
// ---------------------------------------------------------------------------------------

interface AudienceChunkRow {
  id: number;
  chunk_index: number;
  recipient_count: number;
  mobile_numbers_json: string;
}
interface CampaignRow {
  id: string;
  name: string;
  sender_id: string;
  message: string;
  mode: string;
  schedule_date: string | null;
  status: string;
  total_recipients: number;
  total_batches: number;
  completed_batches: number;
  failed_batches: number;
  invalid_count: number;
  estimated_credits: number;
  is_test: number;
  created_at: string;
  updated_at: string;
}
interface BatchRow {
  id: string;
  campaign_id: string;
  chunk_index: number;
  status: string;
  sendmode_request_id: string | null;
  invalid_numbers_json: string | null;
  error_message: string | null;
  updated_at: string;
}
interface OptOutRow {
  mobile_number: string;
  created_at: string;
}

/** A prepared statement that defers execution against the owning database. */
class FakeStatement {
  constructor(
    private readonly db: FakeD1,
    private readonly sql: string,
    private readonly params: unknown[] = [],
  ) {}

  bind(...params: unknown[]): FakeStatement {
    return new FakeStatement(this.db, this.sql, params);
  }

  async first<T>(): Promise<T | null> {
    const rows = this.db.execute(this.sql, this.params);
    return (rows[0] as T) ?? null;
  }

  async all<T>(): Promise<{ results: T[]; success: true; meta: Record<string, unknown> }> {
    const rows = this.db.execute(this.sql, this.params);
    return { results: rows as T[], success: true, meta: {} };
  }

  async run(): Promise<{ results: unknown[]; success: true; meta: { changes: number } }> {
    const changes = this.db.executeWrite(this.sql, this.params);
    return { results: [], success: true, meta: { changes } };
  }
}

/**
 * A D1 fake covering the exact statements Phase 6 issues. Seed it with audience chunks and
 * opt-outs; inspect `campaigns`, `batches`, and `optOuts` afterwards.
 */
export class FakeD1 {
  audienceChunks: AudienceChunkRow[] = [];
  campaigns: CampaignRow[] = [];
  batches: BatchRow[] = [];
  optOuts: OptOutRow[] = [];

  /** Seed `audience_chunks` from plain number arrays (chunk index = array position). */
  seedAudience(chunks: string[][]): void {
    this.audienceChunks = chunks.map((numbers, index) => ({
      id: index + 1,
      chunk_index: index,
      recipient_count: numbers.length,
      mobile_numbers_json: JSON.stringify(numbers),
    }));
  }

  prepare(sql: string): FakeStatement {
    return new FakeStatement(this, sql);
  }

  /** Run a batch of statements atomically (enough for our tests). */
  async batch(statements: FakeStatement[]): Promise<unknown[]> {
    const out: unknown[] = [];
    for (const statement of statements) out.push(await statement.run());
    return out;
  }

  /** Normalize whitespace so the fake can match statements regardless of formatting. */
  private static norm(sql: string): string {
    return sql.replace(/\s+/g, " ").trim();
  }

  /** Execute a read statement, returning rows. */
  execute(sql: string, params: unknown[]): unknown[] {
    const q = FakeD1.norm(sql);

    if (q.startsWith("SELECT COALESCE(SUM(recipient_count)")) {
      const total = this.audienceChunks.reduce((s, c) => s + c.recipient_count, 0);
      return [{ total }];
    }
    if (q.startsWith("SELECT COUNT(*) AS count FROM opt_outs")) {
      return [{ count: this.optOuts.length }];
    }
    if (q.startsWith("SELECT mobile_number FROM opt_outs")) {
      return this.optOuts.map((o) => ({ mobile_number: o.mobile_number }));
    }
    if (q.startsWith("SELECT chunk_index, mobile_numbers_json FROM audience_chunks")) {
      return [...this.audienceChunks].sort((a, b) => a.chunk_index - b.chunk_index);
    }
    if (q.startsWith("SELECT mobile_number, created_at FROM opt_outs")) {
      return [...this.optOuts].sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
    }
    if (q.startsWith("SELECT * FROM campaigns WHERE id = ?")) {
      return this.campaigns.filter((c) => c.id === params[0]);
    }
    if (q.startsWith("SELECT * FROM campaigns")) {
      if (q.includes("WHERE status IN ('SCHEDULED'")) {
        const set = new Set(["SCHEDULED", "PROCESSING", "CANCELLING"]);
        return this.byCreatedDesc(this.campaigns.filter((c) => set.has(c.status)));
      }
      if (q.includes("WHERE status NOT IN")) {
        const set = new Set(["SCHEDULED", "PROCESSING", "CANCELLING"]);
        return this.byCreatedDesc(this.campaigns.filter((c) => !set.has(c.status)));
      }
      return this.byCreatedDesc(this.campaigns);
    }
    if (q.startsWith("SELECT * FROM campaign_batches WHERE campaign_id = ?")) {
      return this.batches
        .filter((b) => b.campaign_id === params[0])
        .sort((a, b) => a.chunk_index - b.chunk_index);
    }
    if (q.startsWith("SELECT id, sendmode_request_id FROM campaign_batches")) {
      return this.batches
        .filter(
          (b) =>
            b.campaign_id === params[0] &&
            b.status === "SCHEDULED" &&
            b.sendmode_request_id !== null,
        )
        .map((b) => ({ id: b.id, sendmode_request_id: b.sendmode_request_id }));
    }
    throw new Error(`FakeD1: unhandled read statement: ${q}`);
  }

  /** Execute a write statement, returning the number of affected rows. */
  executeWrite(sql: string, params: unknown[]): number {
    const q = FakeD1.norm(sql);

    if (q.startsWith("INSERT INTO campaigns")) {
      this.campaigns.push({
        id: params[0] as string,
        name: params[1] as string,
        sender_id: params[2] as string,
        message: params[3] as string,
        mode: params[4] as string,
        schedule_date: params[5] as string | null,
        status: params[6] as string,
        total_recipients: params[7] as number,
        total_batches: params[8] as number,
        completed_batches: 0,
        failed_batches: 0,
        invalid_count: 0,
        estimated_credits: params[9] as number,
        is_test: params[10] as number,
        created_at: params[11] as string,
        updated_at: params[12] as string,
      });
      return 1;
    }
    if (q.startsWith("INSERT INTO campaign_batches")) {
      this.batches.push({
        id: params[0] as string,
        campaign_id: params[1] as string,
        chunk_index: params[2] as number,
        status: "PENDING",
        sendmode_request_id: null,
        invalid_numbers_json: null,
        error_message: null,
        updated_at: params[3] as string,
      });
      return 1;
    }
    if (q.startsWith("INSERT OR IGNORE INTO opt_outs")) {
      if (this.optOuts.some((o) => o.mobile_number === params[0])) return 0;
      this.optOuts.push({ mobile_number: params[0] as string, created_at: params[1] as string });
      return 1;
    }
    if (q.startsWith("DELETE FROM opt_outs WHERE mobile_number = ?")) {
      const before = this.optOuts.length;
      this.optOuts = this.optOuts.filter((o) => o.mobile_number !== params[0]);
      return before - this.optOuts.length;
    }
    if (q.startsWith("UPDATE campaigns SET status = 'CANCELLING'")) {
      const row = this.campaigns.find((c) => c.id === params[1]);
      if (!row) return 0;
      row.status = "CANCELLING";
      row.updated_at = params[0] as string;
      return 1;
    }
    if (q.startsWith("UPDATE campaign_batches SET status = 'CANCELLED'")) {
      let changed = 0;
      for (const b of this.batches) {
        if (b.campaign_id === params[1] && b.status === "PENDING") {
          b.status = "CANCELLED";
          b.updated_at = params[0] as string;
          changed++;
        }
      }
      return changed;
    }
    if (q.startsWith("UPDATE campaigns SET status = 'CANCELLED'")) {
      const row = this.campaigns.find((c) => c.id === params[1]);
      if (!row) return 0;
      row.status = "CANCELLED";
      row.updated_at = params[0] as string;
      return 1;
    }
    throw new Error(`FakeD1: unhandled write statement: ${q}`);
  }

  private byCreatedDesc(rows: CampaignRow[]): CampaignRow[] {
    return [...rows].sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0));
  }
}

// ---------------------------------------------------------------------------------------
// Queue fake
// ---------------------------------------------------------------------------------------

/** A queue producer fake that records every message and every `sendBatch` call. */
export class FakeQueue {
  messages: QueueMessage[] = [];
  /** One entry per `sendBatch()` call, recording how many messages that call carried. */
  batches: number[] = [];

  async sendBatch(requests: Iterable<{ body: QueueMessage }>): Promise<unknown> {
    const list = Array.from(requests);
    this.batches.push(list.length);
    for (const r of list) this.messages.push(r.body);
    return { metadata: {} };
  }
}

// ---------------------------------------------------------------------------------------
// Sendmode fetch stub
// ---------------------------------------------------------------------------------------

/** Capture the last provider request and script its response. */
export interface ProviderStub {
  calls: Array<{ url: string; method: string }>;
  /** The balance value served for `/balance` (mutate between calls). */
  balance: number;
  /** Force a non-2xx status (for provider-error tests); `undefined` restores success. */
  failStatus: number | undefined;
  restore(): void;
}

/**
 * Install a global `fetch` stub that answers `/3.0/balance` (and any other path) with a
 * plausible Sendmode JSON body. Returns a controller to tweak the balance/failure and to
 * restore the original `fetch`.
 */
export function stubProvider(initialBalance = 100_000): ProviderStub {
  const original = globalThis.fetch;
  const calls: ProviderStub["calls"] = [];

  const stub: ProviderStub = {
    calls,
    balance: initialBalance,
    failStatus: undefined,
    restore() {
      globalThis.fetch = original;
    },
  };

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    calls.push({ url, method });

    if (stub.failStatus !== undefined) {
      return new Response(
        JSON.stringify({ is_successful: false, error_message: "provider down", accept_date: null }),
        { status: stub.failStatus },
      );
    }
    return new Response(
      JSON.stringify({
        balance: stub.balance,
        is_successful: true,
        error_message: null,
        accept_date: "2026-01-01T00:00:00Z",
      }),
      { status: 200 },
    );
  }) as typeof fetch;

  return stub;
}
