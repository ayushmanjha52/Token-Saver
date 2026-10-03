/** Display formatting. Every figure leaves here with its unit attached. */

export function usdNumber(decimal: string): number {
  const n = Number(decimal);
  return Number.isFinite(n) ? n : 0;
}

export function usd(decimal: string | number): string {
  const n = typeof decimal === "number" ? decimal : usdNumber(decimal);
  if (n > 0 && n < 0.01) return "<$0.01";
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function tokens(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B tok`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M tok`;
  if (n >= 1e4) return `${(n / 1e3).toFixed(1)}k tok`;
  return `${n.toLocaleString("en-US")} tok`;
}

export function count(n: number, unit: string): string {
  return `${n.toLocaleString("en-US")} ${unit}${n === 1 ? "" : "s"}`;
}

export function pct(part: number, whole: number): string {
  if (whole <= 0) return "—";
  return `${((part / whole) * 100).toFixed(1)}%`;
}

/**
 * Rounds a scale maximum up to 1, 2, 2.5 or 5 × 10^k, so the 10% ticks land
 * on figures a reader can do arithmetic with.
 */
export function niceCeil(x: number): number {
  if (x <= 0) return 1;
  const mag = 10 ** Math.floor(Math.log10(x));
  for (const step of [1, 2, 2.5, 5, 10]) if (step * mag >= x) return step * mag;
  return 10 * mag;
}

export function dayLabel(isoDay: string): string {
  const d = new Date(`${isoDay}T00:00:00Z`);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}
