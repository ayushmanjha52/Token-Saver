import type { ReactNode } from "react";
import s from "./meter.module.css";

export interface MeterSplit {
  /** USD. Null until there is an outcome signal to classify spend with. */
  productive: number | null;
  wasted: number | null;
  unclassified: number;
}

interface MeterProps {
  split: MeterSplit;
  /** Shared across every meter on the panel, so bars compare between rows. */
  scaleMax: number;
  /** Draws an oxblood stop at a hard limit (USD). */
  limit?: number | null;
  /** Spoken description; the visual carries no information this text lacks. */
  description: string;
  tooltip?: ReactNode;
}

const TICKS = [10, 20, 30, 40, 50, 60, 70, 80, 90];

/**
 * The load meter: one 26px bar on a scale shared with every other meter in
 * view, solid for productive spend, hatched for waste, with a 10% tick scale
 * laid over it so a reading needs no legend.
 */
export function Meter({ split, scaleMax, limit, description, tooltip }: MeterProps) {
  const pctOf = (v: number) => `${Math.max(0, Math.min(100, (v / scaleMax) * 100))}%`;
  const segments: { key: string; cls: string | undefined; value: number }[] = [
    { key: "productive", cls: s.productive, value: split.productive ?? 0 },
    { key: "wasted", cls: s.wasted, value: split.wasted ?? 0 },
    { key: "unclassified", cls: s.unclassified, value: split.unclassified },
  ].filter((x) => x.value > 0);

  return (
    <div className={s.wrap} tabIndex={tooltip ? 0 : undefined} role="img" aria-label={description}>
      <div className={s.track}>
        <div className={s.fill}>
          {segments.map((seg) => (
            <div key={seg.key} className={`${s.seg} ${seg.cls ?? ""}`} style={{ width: pctOf(seg.value) }} />
          ))}
        </div>
        <div className={s.ticks} aria-hidden>
          {TICKS.map((t) => (
            <span key={t} className={`${s.tick} ${t === 50 ? s.major : ""}`} style={{ left: `${t}%` }} />
          ))}
        </div>
      </div>
      {limit != null && limit > 0 && limit <= scaleMax ? (
        <span className={s.limit} style={{ left: `calc(${pctOf(limit)} - 1px)` }} aria-hidden />
      ) : null}
      {tooltip ? (
        <div className={s.tip} role="tooltip">
          {tooltip}
        </div>
      ) : null}
    </div>
  );
}
