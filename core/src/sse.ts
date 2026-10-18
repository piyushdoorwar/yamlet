// Server-sent events (text/event-stream) parsing, fed text as it arrives. Isomorphic.

export interface SseEvent {
  /** `event:` field; "message" when absent. */
  event: string;
  data: string;
  id?: string;
  retry?: number;
  /** Milliseconds since the request started, when the caller knows it. */
  atMs?: number;
}

export function isEventStream(contentType: string): boolean {
  return /^text\/event-stream\b/i.test(contentType.trim());
}

/** Incremental parser: push text chunks, get the events they complete. */
export class SseParser {
  private buffer = "";
  private data: string[] = [];
  private event = "";
  private id: string | undefined;
  private retry: number | undefined;
  private started = false;

  push(text: string, atMs?: number): SseEvent[] {
    if (!this.started && text) {
      this.started = true;
      if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    }
    this.buffer += text;
    const out: SseEvent[] = [];
    // Lines end in CRLF, LF or CR. A trailing CR may be the first half of a CRLF, so wait for more.
    let match: RegExpExecArray | null;
    const re = /\r\n|\n|\r(?!$)/g;
    let start = 0;
    while ((match = re.exec(this.buffer))) {
      this.line(this.buffer.slice(start, match.index), out, atMs);
      start = match.index + match[0].length;
    }
    this.buffer = this.buffer.slice(start);
    return out;
  }

  /** Dispatch what is left at the end of the stream (a final event without its blank line). */
  end(atMs?: number): SseEvent[] {
    const out: SseEvent[] = [];
    if (this.buffer) this.line(this.buffer.replace(/\r$/, ""), out, atMs);
    this.buffer = "";
    this.dispatch(out, atMs);
    return out;
  }

  private line(line: string, out: SseEvent[], atMs?: number) {
    if (line === "") return this.dispatch(out, atMs);
    if (line.startsWith(":")) return;
    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "data") this.data.push(value);
    else if (field === "event") this.event = value;
    else if (field === "id" && !value.includes("\0")) this.id = value;
    else if (field === "retry" && /^\d+$/.test(value)) this.retry = Number(value);
  }

  private dispatch(out: SseEvent[], atMs?: number) {
    if (this.data.length) {
      out.push({
        event: this.event || "message",
        data: this.data.join("\n"),
        ...(this.id !== undefined ? { id: this.id } : {}),
        ...(this.retry !== undefined ? { retry: this.retry } : {}),
        ...(atMs !== undefined ? { atMs } : {}),
      });
    }
    this.data = [];
    this.event = "";
    this.retry = undefined;
  }
}

/** All events in a complete event-stream body. */
export function parseEventStream(text: string): SseEvent[] {
  const p = new SseParser();
  return [...p.push(text), ...p.end()];
}
