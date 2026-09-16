import { Database } from "bun:sqlite";
import { mkdirSync, chmodSync } from "node:fs";
import { dirname } from "node:path";

export type KeyRecord = {
  id: string; name: string; suffix: string; state: "open" | "paused" | "revoked";
  expires_at: number | null; created_at: number; last_used_at: number | null;
};
export type Usage = { model: string; input: number; output: number };
export type Settings = {
  openaiBaseUrl: string; openaiApiKey: string;
  anthropicBaseUrl: string; anthropicApiKey: string; anthropicVersion: string;
  timezone: string; usageFlushMinutes: number;
};
export type UsageRow = {
  day: string; key_id: string; provider: string; model: string;
  input_tokens: number; output_tokens: number; requests: number; unknown: number;
};
type PendingRequest = { keyId: string; day: string; provider: string; model: string };
const digest = (token: string) => new Bun.CryptoHasher("sha256").update(token).digest("hex");
const rowId = (row: Pick<UsageRow, "day" | "key_id" | "provider" | "model">) => JSON.stringify([row.day, row.key_id, row.provider, row.model]);

export class Store {
  readonly db: Database;
  private settings: Settings;
  private dateFormat: Intl.DateTimeFormat;
  private keys = new Map<string, KeyRecord>();
  private hashes = new Map<string, string>();
  private usage = new Map<string, UsageRow>();
  private pending = new Map<string, PendingRequest>();
  private dirtyUsage = new Set<string>();
  private dirtyLastUsed = new Set<string>();
  private timer?: ReturnType<typeof setInterval>;
  private closed = false;

  constructor(path: string, timezone: string, legacyToken?: string, initialSettings: Partial<Settings> = {}) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new Database(path, { create: true });
    if (path !== ":memory:") chmodSync(path, 0o600);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS metadata (name TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS keys (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, hash TEXT NOT NULL UNIQUE, suffix TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('open','paused','revoked')),
        expires_at INTEGER, created_at INTEGER NOT NULL, last_used_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS daily_usage (
        day TEXT NOT NULL, key_id TEXT NOT NULL REFERENCES keys(id), provider TEXT NOT NULL, model TEXT NOT NULL,
        input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL, requests INTEGER NOT NULL, unknown INTEGER NOT NULL,
        PRIMARY KEY (day,key_id,provider,model)
      );
    `);
    this.db.transaction(() => {
      // Preserve the previous per-request history; migrate it once into compact daily counters.
      if (!this.db.query("SELECT value FROM metadata WHERE name='daily_usage_migrated'").get()) {
        if (this.db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='requests'").get()) {
          this.db.exec(`INSERT INTO daily_usage
            SELECT day,key_id,provider,model,COALESCE(SUM(input_tokens),0),COALESCE(SUM(output_tokens),0),COUNT(*),
            SUM(CASE WHEN input_tokens IS NULL THEN 1 ELSE 0 END)
            FROM requests GROUP BY day,key_id,provider,model`);
        }
        this.db.query("INSERT INTO metadata VALUES ('daily_usage_migrated','1')").run();
      }
    })();
    for (const row of this.db.query("SELECT * FROM keys ORDER BY created_at,id").all() as (KeyRecord & { hash: string })[]) {
      const { hash, ...key } = row;
      this.keys.set(key.id, key);
      this.hashes.set(hash, key.id);
    }
    for (const row of this.db.query("SELECT * FROM daily_usage").all() as UsageRow[]) this.usage.set(rowId(row), row);
    this.db.transaction(() => {
      if (!this.db.query("SELECT value FROM metadata WHERE name='legacy_imported'").get()) {
        if (legacyToken) this.insertKey("Legacy shared key", legacyToken, "open");
        this.db.query("INSERT INTO metadata VALUES ('legacy_imported','1')").run();
      }
    })();
    const saved = this.db.query("SELECT value FROM metadata WHERE name='settings'").get() as { value: string } | null;
    this.settings = {
      openaiBaseUrl: "https://api.openai.com", openaiApiKey: "",
      anthropicBaseUrl: "https://api.anthropic.com", anthropicApiKey: "", anthropicVersion: "2023-06-01",
      ...initialSettings, timezone, usageFlushMinutes: 10,
      ...(saved ? JSON.parse(saved.value) : {}),
    };
    this.dateFormat = this.makeDateFormat(this.settings.timezone);
    if (!saved) this.db.query("INSERT INTO metadata VALUES ('settings',?)").run(JSON.stringify(this.settings));
    this.scheduleFlush();
  }
  private makeDateFormat(timezone: string) {
    return new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" });
  }
  get timezone() { return this.settings.timezone; }
  getSettings(): Settings { return { ...this.settings }; }
  updateSettings(settings: Settings) {
    const format = this.makeDateFormat(settings.timezone);
    if (!Number.isInteger(settings.usageFlushMinutes) || settings.usageFlushMinutes < 1 || settings.usageFlushMinutes > 1440) throw new Error("Usage flush interval must be between 1 and 1440 minutes");
    for (const base of [settings.openaiBaseUrl, settings.anthropicBaseUrl]) {
      const url = new URL(base);
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error("Upstream URL must use HTTP(S) without credentials, query parameters, or fragments");
    }
    this.db.query("UPDATE metadata SET value=? WHERE name='settings'").run(JSON.stringify(settings));
    this.settings = { ...settings };
    this.dateFormat = format;
    this.scheduleFlush();
  }
  private scheduleFlush() {
    clearInterval(this.timer);
    this.timer = setInterval(() => this.tryFlush(), this.settings.usageFlushMinutes * 60_000);
    this.timer.unref();
  }
  day(time = Date.now()) { return this.dateFormat.format(new Date(time)); }
  private insertKey(name: string, token: string, state: KeyRecord["state"] = "paused") {
    const key: KeyRecord = { id: crypto.randomUUID(), name, suffix: token.slice(-4), state, expires_at: null, created_at: Date.now(), last_used_at: null };
    const hash = digest(token);
    this.db.query("INSERT INTO keys (id,name,hash,suffix,state,created_at) VALUES (?,?,?,?,?,?)")
      .run(key.id, name, hash, key.suffix, state, key.created_at);
    this.keys.set(key.id, key);
    this.hashes.set(hash, key.id);
    return { ...key };
  }
  createKey(name: string) {
    const token = `llmp_${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url")}`;
    return { key: this.insertKey(name, token), token };
  }
  listKeys() { return [...this.keys.values()].map(key => ({ ...key })); }
  getKey(id: string) { const key = this.keys.get(id); return key ? { ...key } : undefined; }
  authenticate(token: string) { const id = this.hashes.get(digest(token)); return id ? this.getKey(id)! : null; }
  allowed(key: KeyRecord, now = Date.now()) { return key.state === "open" && (key.expires_at === null || key.expires_at > now); }
  updateKey(id: string, change: { name?: string; state?: KeyRecord["state"]; expiresAt?: number | null }) {
    const key = this.keys.get(id);
    if (!key || key.state === "revoked") throw new Error("Key not found or revoked");
    const next = { ...key, name: change.name ?? key.name, state: change.state ?? key.state, expires_at: change.expiresAt === undefined ? key.expires_at : change.expiresAt };
    // Security/control changes commit before publishing the new cached state.
    this.db.query("UPDATE keys SET name=?,state=?,expires_at=? WHERE id=?").run(next.name, next.state, next.expires_at, id);
    this.keys.set(id, next);
    return { ...next };
  }
  touch(id: string) {
    const key = this.keys.get(id);
    if (key) { key.last_used_at = Date.now(); this.dirtyLastUsed.add(id); }
  }
  startRequest(id: string, keyId: string, provider: string, model: string, startedAt: number) {
    if (this.pending.has(id)) throw new Error("Duplicate request ID");
    this.pending.set(id, { keyId, provider, model, day: this.day(startedAt) });
  }
  finishRequest(id: string, usage: Usage | null, _outcome: string) {
    const request = this.pending.get(id);
    if (!request) return;
    this.pending.delete(id);
    const row: UsageRow = { day: request.day, key_id: request.keyId, provider: request.provider, model: usage?.model || request.model, input_tokens: 0, output_tokens: 0, requests: 0, unknown: 0 };
    const idOfRow = rowId(row);
    const total = this.usage.get(idOfRow) ?? row;
    total.input_tokens += usage?.input ?? 0;
    total.output_tokens += usage?.output ?? 0;
    total.requests++;
    if (!usage) total.unknown++;
    this.usage.set(idOfRow, total);
    this.dirtyUsage.add(idOfRow);
  }
  stats(from: string, to: string, keyId?: string, model?: string) {
    const matches = (r: UsageRow) => r.day >= from && r.day <= to && (!keyId || r.key_id === keyId) && (!model || r.model === model);
    const rows = new Map<string, UsageRow & { pending: number; name: string }>();
    for (const [id, row] of this.usage) if (matches(row)) rows.set(id, { ...row, pending: 0, name: this.keys.get(row.key_id)!.name });
    for (const request of this.pending.values()) {
      const row: UsageRow = { day: request.day, key_id: request.keyId, provider: request.provider, model: request.model, input_tokens: 0, output_tokens: 0, requests: 0, unknown: 0 };
      if (!matches(row)) continue;
      const id = rowId(row);
      const total = rows.get(id) ?? { ...row, pending: 0, name: this.keys.get(row.key_id)!.name };
      total.requests++; total.pending++;
      rows.set(id, total);
    }
    return [...rows.values()].sort((a, b) => b.day.localeCompare(a.day) || a.name.localeCompare(b.name) || a.model.localeCompare(b.model));
  }
  flush() {
    if (!this.dirtyUsage.size && !this.dirtyLastUsed.size) return;
    this.db.transaction(() => {
      const usage = this.db.query(`INSERT INTO daily_usage VALUES (?,?,?,?,?,?,?,?)
        ON CONFLICT(day,key_id,provider,model) DO UPDATE SET input_tokens=excluded.input_tokens,
        output_tokens=excluded.output_tokens,requests=excluded.requests,unknown=excluded.unknown`);
      for (const id of this.dirtyUsage) {
        const r = this.usage.get(id)!;
        usage.run(r.day, r.key_id, r.provider, r.model, r.input_tokens, r.output_tokens, r.requests, r.unknown);
      }
      const touch = this.db.query("UPDATE keys SET last_used_at=? WHERE id=?");
      for (const id of this.dirtyLastUsed) touch.run(this.keys.get(id)!.last_used_at, id);
    })();
    this.dirtyUsage.clear(); this.dirtyLastUsed.clear();
  }
  private tryFlush() {
    try { this.flush(); } catch (error) { console.error("[store] Usage flush failed; retaining cache for retry", error); }
  }
  close() {
    if (this.closed) return;
    clearInterval(this.timer);
    for (const id of this.pending.keys()) this.finishRequest(id, null, "interrupted");
    this.flush();
    this.db.close(); this.closed = true;
  }
}
