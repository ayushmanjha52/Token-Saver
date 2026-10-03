import { InvariantViolationError } from "@tokengrid/shared";

export interface StreamEntry {
  id: string;
  payload: string;
}

/** Narrows ioredis' untyped stream replies ([id, [field, value, ...]]) at the boundary. */
export function toEntries(raw: unknown): StreamEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: StreamEntry[] = [];
  for (const item of raw) {
    if (!Array.isArray(item) || typeof item[0] !== "string" || !Array.isArray(item[1])) continue;
    const fields = item[1] as unknown[];
    let payload = "";
    for (let i = 0; i + 1 < fields.length; i += 2) {
      if (fields[i] === "event" && typeof fields[i + 1] === "string") payload = fields[i + 1] as string;
    }
    out.push({ id: item[0], payload });
  }
  return out;
}

/** XREADGROUP returns [[stream, entries]]; we read one stream, so take the first. */
export function entriesFromRead(raw: unknown): StreamEntry[] {
  if (!Array.isArray(raw) || raw.length === 0) return [];
  const first = raw[0];
  if (!Array.isArray(first)) throw new InvariantViolationError("XREADGROUP reply is not [stream, entries]");
  return toEntries(first[1]);
}

function parseId(id: string): [bigint, bigint] {
  const [ms, seq] = id.split("-");
  return [BigInt(ms ?? "0"), BigInt(seq ?? "0")];
}

export function minStreamId(a: string, b: string): string {
  const [am, as] = parseId(a);
  const [bm, bs] = parseId(b);
  if (am !== bm) return am < bm ? a : b;
  return as <= bs ? a : b;
}
