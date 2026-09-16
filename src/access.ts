import { Store } from "./store";

// One server process owns the database and all live requests.
export class Access {
  private active = new Map<string, Set<AbortController>>();
  private timer?: ReturnType<typeof setTimeout>;
  constructor(readonly store: Store) { this.reschedule(); }
  enroll(keyId: string) {
    const controller = new AbortController();
    const set = this.active.get(keyId) ?? new Set<AbortController>();
    set.add(controller);
    this.active.set(keyId, set);
    return { controller, release: () => { set.delete(controller); if (!set.size) this.active.delete(keyId); } };
  }
  changed() {
    for (const [id, controllers] of this.active) {
      const key = this.store.getKey(id);
      if (!key || !this.store.allowed(key)) {
        for (const controller of controllers) controller.abort(new Error("key_disabled"));
      }
    }
    this.reschedule();
  }
  private reschedule() {
    clearTimeout(this.timer);
    const deadlines = this.store.listKeys().filter(k => k.state === "open" && k.expires_at !== null && k.expires_at > Date.now()).map(k => k.expires_at!);
    if (deadlines.length) {
      this.timer = setTimeout(() => this.changed(), Math.min(2_147_483_647, Math.max(1, Math.min(...deadlines) - Date.now())));
      this.timer.unref();
    }
  }
  close() {
    clearTimeout(this.timer);
    for (const controllers of this.active.values()) for (const c of controllers) c.abort(new Error("server_shutdown"));
  }
}
