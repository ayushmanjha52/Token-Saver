import type { Redis } from "ioredis";
import { USAGE_STREAM, type UsageEventV1 } from "@tokengrid/shared";

/**
 * Fire-and-forget publisher for usage events.
 *
 * `emit` never throws and never awaits Redis on the caller's behalf: by the
 * time it runs the client already has its response, and nothing about
 * metering is allowed to reach back into delivery. Events that fail to send
 * wait in a bounded in-memory buffer so a Redis failover of a few seconds
 * costs nothing; beyond the bound, or on process exit, they are lost and
 * counted.
 */
export class UsageEmitter {
  private readonly pending: string[] = [];
  private flushing = false;
  private readonly timer: NodeJS.Timeout;
  dropped = 0;
  static readonly MAX_PENDING = 10_000;

  constructor(
    private readonly redis: Redis,
    private readonly log: { error: (obj: object, msg: string) => void },
  ) {
    this.timer = setInterval(() => void this.flush(), 5_000);
    this.timer.unref();
    redis.on("ready", () => void this.flush());
  }

  emit(event: UsageEventV1): void {
    const payload = JSON.stringify(event);
    this.send(payload).catch(() => this.buffer(payload));
  }

  private send(payload: string): Promise<unknown> {
    // No MAXLEN here: trimming on write would discard events the worker has
    // not consumed yet. The worker trims acknowledged history instead.
    return this.redis.xadd(USAGE_STREAM, "*", "event", payload);
  }

  private buffer(payload: string): void {
    if (this.pending.length >= UsageEmitter.MAX_PENDING) {
      this.pending.shift();
      this.dropped++;
      this.log.error({ dropped: this.dropped }, "usage event dropped: emit buffer full");
    }
    this.pending.push(payload);
  }

  private async flush(): Promise<void> {
    if (this.flushing || this.pending.length === 0) return;
    this.flushing = true;
    try {
      while (this.pending.length > 0) {
        const next = this.pending[0];
        if (next === undefined) break;
        await this.send(next);
        this.pending.shift();
      }
    } catch {
      // Still down; the next tick or `ready` event retries.
    } finally {
      this.flushing = false;
    }
  }

  get pendingCount(): number {
    return this.pending.length;
  }

  async close(): Promise<void> {
    clearInterval(this.timer);
    await this.flush();
    if (this.pending.length > 0) {
      this.log.error({ lost: this.pending.length }, "usage events lost at shutdown");
    }
  }
}
