import { describe, expect, it, spyOn } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store";

describe("cached store", () => {
  it("serves authentication and live usage without database reads or per-request writes", () => {
    const store = new Store(":memory:", "UTC");
    try {
      const member = store.createKey("Member");
      store.updateKey(member.key.id, { state: "open" });
      const query = spyOn(store.db, "query");
      try {
        for (let i = 0; i < 100; i++) {
          expect(store.authenticate(member.token)?.state).toBe("open");
          store.getSettings(); store.listKeys(); store.getKey(member.key.id);
          store.touch(member.key.id);
          store.startRequest(String(i), member.key.id, "openai", "requested-model", Date.now());
          store.finishRequest(String(i), { model: "actual-model", input: 12, output: 3 }, "completed");
        }
        const rows = store.stats(store.day(), store.day());
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ model: "actual-model", input_tokens: 1200, output_tokens: 300, requests: 100, unknown: 0, pending: 0 });
        expect(query).not.toHaveBeenCalled();
        store.flush(); expect(query).toHaveBeenCalled();
        query.mockClear(); store.flush(); expect(query).not.toHaveBeenCalled();
      } finally { query.mockRestore(); }
      expect(store.db.query("SELECT input_tokens,output_tokens,requests FROM daily_usage").get()).toEqual({ input_tokens: 1200, output_tokens: 300, requests: 100 });
      expect(store.db.query("SELECT last_used_at FROM keys").get()).toEqual({ last_used_at: store.getKey(member.key.id)!.last_used_at });
    } finally { store.close(); }
  });
  it("keeps pending and unknown usage separate and supports model filters", () => {
    const store = new Store(":memory:", "UTC");
    try {
      const { key } = store.createKey("Member");
      store.startRequest("a", key.id, "openai", "model-a", Date.now());
      store.startRequest("b", key.id, "openai", "model-b", Date.now());
      store.finishRequest("b", null, "interrupted");
      store.flush();
      expect(store.db.query("SELECT COUNT(*) AS count FROM daily_usage").get()).toEqual({ count: 1 });
      expect(store.stats(store.day(), store.day(), key.id, "model-a")[0]).toMatchObject({ pending: 1, unknown: 0, requests: 1 });
      expect(store.stats(store.day(), store.day(), key.id, "model-b")[0]).toMatchObject({ pending: 0, unknown: 1, requests: 1 });
      store.finishRequest("a", { model: "model-a", input: 10, output: 2 }, "completed");
      store.finishRequest("a", { model: "model-a", input: 10, output: 2 }, "completed");
      store.updateKey(key.id, { name: "Renamed" });
      expect(store.stats(store.day(), store.day(), key.id, "model-a")[0]).toMatchObject({ name: "Renamed", pending: 0, input_tokens: 10, output_tokens: 2, requests: 1 });
    } finally { store.close(); }
  });
  it("retains dirty data when a flush fails and does not double-count retries", () => {
    const store = new Store(":memory:", "UTC");
    try {
      const { key } = store.createKey("Member");
      store.startRequest("a", key.id, "openai", "m", Date.now());
      store.finishRequest("a", { model: "m", input: 10, output: 2 }, "completed");
      store.db.exec("CREATE TRIGGER fail_usage BEFORE INSERT ON daily_usage BEGIN SELECT RAISE(ABORT,'test write failure'); END");
      expect(() => store.flush()).toThrow("test write failure");
      expect(store.stats(store.day(), store.day())[0].input_tokens).toBe(10);
      store.db.exec("DROP TRIGGER fail_usage");
      store.flush(); store.flush();
      expect(store.db.query("SELECT input_tokens,requests FROM daily_usage").get()).toEqual({ input_tokens: 10, requests: 1 });
    } finally { store.close(); }
  });
  it("persists settings immediately, defaults to ten minutes, and flushes usage at shutdown", () => {
    const dir = mkdtempSync(join(tmpdir(), "llmp-cache-"));
    const path = join(dir, "db.sqlite");
    let store = new Store(path, "UTC");
    try {
      expect(store.getSettings().usageFlushMinutes).toBe(10);
      store.updateSettings({ ...store.getSettings(), openaiBaseUrl: "https://custom.example/v1", openaiApiKey: "saved-secret", timezone: "America/Los_Angeles", usageFlushMinutes: 20 });
      const disk = new Database(path, { readonly: true });
      try {
        const saved = disk.query("SELECT value FROM metadata WHERE name='settings'").get() as { value: string };
        expect(JSON.parse(saved.value)).toMatchObject({ openaiApiKey: "saved-secret", usageFlushMinutes: 20 });
      } finally { disk.close(); }
      const { key } = store.createKey("Member");
      store.startRequest("r", key.id, "openai", "m", Date.now());
      store.finishRequest("r", { model: "m", input: 7, output: 3 }, "completed");
      expect(store.db.query("SELECT COUNT(*) AS count FROM daily_usage").get()).toEqual({ count: 0 });
      store.close();
      store = new Store(path, "UTC", undefined, { openaiApiKey: "stale-environment" });
      expect(store.getSettings()).toMatchObject({ openaiApiKey: "saved-secret", timezone: "America/Los_Angeles", usageFlushMinutes: 20 });
      expect(store.stats(store.day(), store.day())[0]).toMatchObject({ input_tokens: 7, output_tokens: 3 });
      for (const value of [0, -1, 1.5, 1441]) expect(() => store.updateSettings({ ...store.getSettings(), usageFlushMinutes: value })).toThrow();
      expect(store.getSettings().usageFlushMinutes).toBe(20);
    } finally { store.close(); rmSync(dir, { recursive: true }); }
  });
  it("migrates legacy request history exactly once and preserves the archive", () => {
    const dir = mkdtempSync(join(tmpdir(), "llmp-migration-"));
    const path = join(dir, "db.sqlite");
    const db = new Database(path, { create: true });
    db.exec(`CREATE TABLE keys(id TEXT PRIMARY KEY,name TEXT,hash TEXT UNIQUE,suffix TEXT,state TEXT,expires_at INTEGER,created_at INTEGER,last_used_at INTEGER);
      INSERT INTO keys VALUES ('key','Legacy','hash','tail','paused',NULL,0,NULL);
      CREATE TABLE requests(id TEXT,key_id TEXT,day TEXT,provider TEXT,model TEXT,started_at INTEGER,input_tokens INTEGER,output_tokens INTEGER,outcome TEXT);
      INSERT INTO requests VALUES ('1','key','2026-09-15','openai','m',0,20,5,'completed');
      INSERT INTO requests VALUES ('2','key','2026-09-15','openai','m',0,NULL,NULL,'pending');`);
    db.close();
    let store = new Store(path, "UTC");
    try {
      expect(store.stats("2026-09-15", "2026-09-15")[0]).toMatchObject({ input_tokens: 20, output_tokens: 5, requests: 2, unknown: 1 });
      store.close(); store = new Store(path, "UTC");
      expect(store.stats("2026-09-15", "2026-09-15")[0].requests).toBe(2);
      expect(store.db.query("SELECT COUNT(*) AS count FROM requests").get()).toEqual({ count: 2 });
    } finally { store.close(); rmSync(dir, { recursive: true }); }
  });
});
