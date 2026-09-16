import type { Usage } from "./store";

type ObjectValue = Record<string, any>;
const count = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const MAX_PARSE_CHARS = 8 * 1024 * 1024;

// Observe bounded copies of response chunks; never change the bytes sent to the client.
export class UsageObserver {
  private decoder = new TextDecoder();
  private buffer = "";
  private dropping = false;
  private anthropic: ObjectValue = {};
  private candidate: Usage | null = null;
  usage: Usage | null = null;
  constructor(private provider: "openai" | "anthropic", private sse: boolean, private model: string) {}
  feed(bytes: Uint8Array) {
    const text = this.decoder.decode(bytes, { stream: true });
    if (!this.sse) {
      if (this.dropping) return;
      this.buffer += text;
      if (this.buffer.length > MAX_PARSE_CHARS) { this.buffer = ""; this.dropping = true; }
      return;
    }
    // SSE uses blank lines as event boundaries, including CRLF split across chunks.
    this.buffer += text;
    let match: RegExpExecArray | null;
    while ((match = /\r?\n\r?\n/.exec(this.buffer))) {
      const event = this.buffer.slice(0, match.index);
      this.buffer = this.buffer.slice(match.index + match[0].length);
      if (!this.dropping && event.length <= MAX_PARSE_CHARS) {
        const data = event.split(/\r?\n/).filter(l => l.startsWith("data:")).map(l => l.slice(5).replace(/^ /, "")).join("\n");
        this.parse(data);
      }
      this.dropping = false;
    }
    if (this.buffer.length > MAX_PARSE_CHARS) { this.buffer = this.buffer.slice(-3); this.dropping = true; }
  }
  end() {
    this.buffer += this.decoder.decode();
    if (!this.sse && !this.dropping) this.parse(this.buffer);
    this.buffer = "";
  }
  private normalize(u: ObjectValue): Usage | null {
    const input = u.input_tokens ?? u.prompt_tokens;
    const output = u.output_tokens ?? u.completion_tokens ?? (count(u.prompt_tokens) && u.total_tokens === u.prompt_tokens ? 0 : undefined);
    if (!count(input) || !count(output)) return null;
    const cache = this.provider === "anthropic" ? (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) : 0;
    if (!count(cache) || !count(input + cache)) return null;
    return { model: this.model, input: input + cache, output };
  }
  private parse(data: string) {
    let value: ObjectValue;
    try { value = JSON.parse(data); } catch { return; }
    if (!value || typeof value !== "object") return;
    const obj = value.response ?? value.message ?? value;
    if (typeof obj.model === "string") this.model = obj.model;
    if (this.provider === "anthropic" && this.sse) {
      if (value.type === "message_start") this.anthropic = { ...obj.usage };
      if (value.type === "message_delta" && value.usage) {
        this.anthropic = { ...this.anthropic, ...value.usage };
        this.candidate = this.normalize(this.anthropic);
      }
      if (value.type === "message_stop") this.usage = this.candidate;
    } else if (obj.usage && typeof obj.usage === "object") {
      // Intermediate Responses events can include null or provisional usage.
      if (!this.sse || !value.type || ["response.completed", "response.incomplete", "response.failed"].includes(value.type)) {
        this.usage = this.normalize(obj.usage);
      }
    }
  }
}
