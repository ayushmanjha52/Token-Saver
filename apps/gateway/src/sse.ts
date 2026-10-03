/**
 * Incremental server-sent-events parser fed with raw network chunks.
 *
 * It sees the stream as a copy, after the bytes have been written to the
 * client, so it must tolerate chunks that split a line, a multi-byte UTF-8
 * character, or a CRLF pair, and must never throw back into the proxy loop.
 */
export class SseParser {
  private readonly decoder = new TextDecoder("utf-8");
  private buffer = "";
  private eventName = "";
  private data: string[] = [];
  /** A single SSE line longer than this is not a provider event; drop it rather than grow without bound. */
  private static readonly MAX_LINE = 16 * 1024 * 1024;

  constructor(private readonly onEvent: (event: string, data: string) => void) {}

  push(chunk: Uint8Array): void {
    this.buffer += this.decoder.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = this.buffer.indexOf("\n")) !== -1) {
      let line = this.buffer.slice(0, nl);
      this.buffer = this.buffer.slice(nl + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      this.line(line);
    }
    if (this.buffer.length > SseParser.MAX_LINE) this.buffer = "";
  }

  /** Flushes a final event that was not followed by a blank line. */
  end(): void {
    this.buffer += this.decoder.decode();
    if (this.buffer.length > 0) {
      this.line(this.buffer.endsWith("\r") ? this.buffer.slice(0, -1) : this.buffer);
      this.buffer = "";
    }
    this.line("");
  }

  private line(line: string): void {
    if (line === "") {
      if (this.data.length > 0) this.onEvent(this.eventName || "message", this.data.join("\n"));
      this.eventName = "";
      this.data = [];
      return;
    }
    if (line.startsWith(":")) return;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") this.eventName = value;
    else if (field === "data") this.data.push(value);
  }
}
