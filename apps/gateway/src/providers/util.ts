export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function num(v: unknown): number | null {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : null;
}

export function headerString(h: string | string[] | undefined): string | null {
  if (typeof h === "string") return h;
  if (Array.isArray(h) && h[0] !== undefined) return h[0];
  return null;
}

/**
 * Collects a non-streaming JSON body for parsing at the end. A chat response
 * is at most a few MB; anything larger is not one we can meter, and holding
 * it would only cost memory.
 */
export class JsonCollector {
  private readonly chunks: Uint8Array[] = [];
  private bytes = 0;
  static readonly MAX_BYTES = 64 * 1024 * 1024;

  push(chunk: Uint8Array): void {
    this.bytes += chunk.byteLength;
    if (this.bytes <= JsonCollector.MAX_BYTES) this.chunks.push(chunk);
  }

  parse(): Record<string, unknown> | null {
    if (this.bytes > JsonCollector.MAX_BYTES) return null;
    let body: unknown;
    try {
      body = JSON.parse(Buffer.concat(this.chunks).toString("utf8"));
    } catch {
      return null;
    }
    return isRecord(body) ? body : null;
  }
}
