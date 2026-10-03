"use client";

import { useState } from "react";
import { count, dayLabel, niceCeil, usd, usdNumber } from "@/lib/format";
import type { DailyPoint } from "@/lib/usage-types";
import s from "./usage.module.css";

const DAY_MS = 86_400_000;

/** Every UTC day in [start, end), so a day with no calls reads as zero rather than vanishing. */
function fillDays(points: DailyPoint[], start: string, end: string): DailyPoint[] {
  const byDay = new Map(points.map((p) => [p.day, p]));
  const out: DailyPoint[] = [];
  for (let t = Date.parse(start); t < Date.parse(end); t += DAY_MS) {
    const day = new Date(t).toISOString().slice(0, 10);
    out.push(byDay.get(day) ?? { day, costUsd: "0", requests: 0 });
  }
  return out;
}

export function DailySpend({ points, start, end }: { points: DailyPoint[]; start: string; end: string }) {
  const [asTable, setAsTable] = useState(false);
  const days = fillDays(points, start, end);
  const max = niceCeil(Math.max(...days.map((d) => usdNumber(d.costUsd)), 0));
  const first = days[0];
  const last = days[days.length - 1];

  return (
    <section className="panel" aria-labelledby="daily-title">
      <div className={s.panelHead}>
        <h2 id="daily-title" className="label" style={{ margin: 0 }}>
          Daily draw · USD per UTC day
        </h2>
        <button type="button" aria-pressed={asTable} onClick={() => setAsTable((v) => !v)}>
          Table view
        </button>
      </div>
      <div className={s.panelBody}>
        {asTable ? (
          <table className={s.table}>
            <thead>
              <tr>
                <th className="label">Day (UTC)</th>
                <th className={`label ${s.num}`}>Requests</th>
                <th className={`label ${s.num}`}>Spend</th>
              </tr>
            </thead>
            <tbody>
              {days.map((d) => (
                <tr key={d.day}>
                  <td>{d.day}</td>
                  <td className={s.num}>{count(d.requests, "req")}</td>
                  <td className={s.num}>{usd(d.costUsd)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className={s.chart}>
            <div className={s.plot}>
              {[0, 0.5, 1].map((f) => (
                <span key={f} aria-hidden>
                  <span className={s.gridline} style={{ bottom: `${f * 100}%` }} />
                  <span className={`${s.yLabel} label`} style={{ bottom: `${f * 100}%`, transform: "translateY(50%)" }}>
                    {usd(max * f)}
                  </span>
                </span>
              ))}
              {days.map((d) => {
                const v = usdNumber(d.costUsd);
                return (
                  <div key={d.day} className={s.col} tabIndex={0} aria-label={`${d.day}: ${usd(d.costUsd)}, ${count(d.requests, "request")}`}>
                    <div className={s.bar} style={{ height: v > 0 ? `max(2px, ${(v / max) * 100}%)` : 0 }} />
                    <div className={s.tip} role="tooltip">
                      {dayLabel(d.day)} · {usd(d.costUsd)} · {count(d.requests, "req")}
                    </div>
                  </div>
                );
              })}
            </div>
            <div className={s.xAxis}>
              <span className="label">{first ? dayLabel(first.day) : ""}</span>
              <span className="label">{last ? dayLabel(last.day) : ""}</span>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
