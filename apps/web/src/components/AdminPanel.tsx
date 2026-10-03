"use client";

import { useCallback, useEffect, useState } from "react";
import type { DriftDay, ReconciliationView } from "@/lib/admin";
import { usd } from "@/lib/format";
import s from "./usage.module.css";

const DAY_MS = 86_400_000;

function pct(r: number | null): string {
  if (r === null) return "provider billed $0";
  return `${r > 0 ? "+" : ""}${(r * 100).toFixed(2)}%`;
}

/**
 * Daily drift for one provider, diverging from zero: above the line
 * TokenGrid metered more than the provider billed, below it less. The ±2%
 * alert threshold is drawn, and days past it turn oxblood and are named in
 * the table below, so the status never rests on colour alone.
 */
function DriftChart({ provider, days, threshold, window }: { provider: string; days: DriftDay[]; threshold: number; window: number }) {
  const byDay = new Map(days.map((d) => [d.day, d]));
  const today = Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate());
  const slots = Array.from({ length: window }, (_, i) => new Date(today - (window - i) * DAY_MS).toISOString().slice(0, 10));
  const worst = Math.max(threshold * 2.5, ...days.map((d) => Math.abs(d.driftRatio ?? 0)));
  const range = Math.ceil(worst * 100) / 100;
  const y = (r: number) => `${50 - (r / range) * 50}%`;

  return (
    <div style={{ marginBottom: 20 }}>
      <div className="label" style={{ marginBottom: 6 }}>
        {provider} · metered vs billed, per UTC day
      </div>
      <div className={s.chart}>
        <div className={s.plot} style={{ height: 120, alignItems: "stretch", borderBottom: "none" }}>
          {[range, threshold, 0, -threshold, -range].map((v) => (
            <span key={v} aria-hidden>
              <span className={s.gridline} style={{ top: y(v), background: v === 0 ? "var(--ink)" : "var(--rule)" }} />
              <span className={`${s.yLabel} label`} style={{ top: y(v), bottom: "auto" }}>
                {v === 0 ? "0%" : `${v > 0 ? "+" : "−"}${(Math.abs(v) * 100).toFixed(v === threshold || v === -threshold ? 0 : 1)}%`}
              </span>
            </span>
          ))}
          {slots.map((day) => {
            const d = byDay.get(day);
            const r = d?.driftRatio ?? null;
            const drifted = (d?.driftedModels ?? 0) > 0;
            const h = r === null ? 0 : Math.min(50, (Math.abs(r) / range) * 50);
            return (
              <div
                key={day}
                className={s.col}
                tabIndex={d ? 0 : -1}
                aria-label={d ? `${day}: metered ${usd(d.meteredUsd)}, billed ${usd(d.providerUsd)}, ${pct(r)}${drifted ? ", drift" : ""}` : `${day}: not reconciled`}
                style={{ position: "relative" }}
              >
                {d && r !== null ? (
                  <div
                    style={{
                      position: "absolute",
                      left: 0,
                      right: 0,
                      top: r >= 0 ? `${50 - h}%` : "50%",
                      height: `max(2px, ${h}%)`,
                      background: drifted ? "var(--oxblood)" : "var(--ink)",
                    }}
                  />
                ) : null}
                {d ? (
                  <div className={s.tip} role="tooltip">
                    {day} · metered {usd(d.meteredUsd)} · billed {usd(d.providerUsd)} · {pct(r)}
                    {drifted ? ` · ${d.driftedModels} model(s) drifted` : ""}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
        <div className={s.xAxis}>
          <span className="label">{slots[0]}</span>
          <span className="label">{slots[slots.length - 1]}</span>
        </div>
      </div>
    </div>
  );
}

export function AdminPanel() {
  const [data, setData] = useState<ReconciliationView | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await fetch("/api/admin/reconciliation", { cache: "no-store" });
    if (res.status === 401) {
      window.location.href = "/login";
      return;
    }
    const body = (await res.json()) as ReconciliationView | { error: { message: string } };
    if ("error" in body) setError(body.error.message);
    else setData(body);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function ack(id: string) {
    await fetch("/api/admin/alerts", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id }) });
    await load();
  }

  const providers = data ? [...new Set(data.days.map((d) => d.provider))].sort() : [];

  return (
    <main className={s.page}>
      <header className={s.header}>
        <div>
          <div className={`display ${s.wordmark}`}>TokenGrid</div>
          <div className="label">Reconciliation · metered cost against provider bills</div>
        </div>
        <a className={s.linkButton} href="/usage">
          Usage
        </a>
      </header>

      {error ? (
        <div className={`${s.banner} ${s.error}`} role="alert" style={{ marginTop: 16 }}>
          <span>
            <span className={`label ${s.errorLabel}`}>Error · </span>
            {error}
          </span>
        </div>
      ) : null}
      {!data && !error ? <p className="label">Reading reconciliation…</p> : null}

      {data ? (
        <div className={s.grid} style={{ marginTop: 16 }}>
          <section className="panel" aria-labelledby="alerts-title">
            <div className={s.panelHead}>
              <h2 id="alerts-title" className="label" style={{ margin: 0 }}>
                Alerts
              </h2>
              <span className="label">{data.alerts.filter((a) => !a.acknowledgedAt).length} open</span>
            </div>
            <div className={s.panelBody}>
              {data.alerts.length === 0 ? (
                <p className={s.note} style={{ marginTop: 0 }}>
                  No alerts. A day is flagged when metered cost for a model differs from the provider&apos;s bill by more than{" "}
                  {(data.threshold * 100).toFixed(0)}% (and at least a tenth of a cent).
                </p>
              ) : (
                data.alerts.map((a) => (
                  <div key={a.id} className={s.finding}>
                    <div>
                      <div style={{ fontWeight: 600 }}>{a.acknowledgedAt ? "Acknowledged" : <span className={s.over}>Open</span>}</div>
                      <p style={{ margin: "4px 0 0" }}>{a.message}</p>
                      <div className="label" style={{ marginTop: 6 }}>
                        {a.createdAt.replace("T", " ").slice(0, 16)} UTC
                      </div>
                    </div>
                    {a.acknowledgedAt ? null : (
                      <button type="button" onClick={() => void ack(a.id)}>
                        Acknowledge
                      </button>
                    )}
                  </div>
                ))
              )}
            </div>
          </section>

          <section className="panel" aria-labelledby="drift-title">
            <div className={s.panelHead}>
              <h2 id="drift-title" className="label" style={{ margin: 0 }}>
                Drift · last 30 days
              </h2>
              <span className="label">alert band ±{(data.threshold * 100).toFixed(0)}%</span>
            </div>
            <div className={s.panelBody}>
              {providers.length === 0 ? (
                <p className={s.note} style={{ marginTop: 0 }}>
                  Nothing reconciled yet. Store a provider admin key (pnpm --filter @tokengrid/ingest credential --kind admin …); the
                  worker reconciles each UTC day after 01:00.
                </p>
              ) : (
                providers.map((p) => (
                  <DriftChart key={p} provider={p} days={data.days.filter((d) => d.provider === p)} threshold={data.threshold} window={30} />
                ))
              )}
              {data.drifted.length > 0 ? (
                <table className={s.table}>
                  <thead>
                    <tr>
                      <th className="label">Day</th>
                      <th className="label">Provider</th>
                      <th className="label">Model</th>
                      <th className={`label ${s.num}`}>Billed</th>
                      <th className={`label ${s.num}`}>Metered</th>
                      <th className={`label ${s.num}`}>Drift</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.drifted.map((d) => (
                      <tr key={`${d.day}-${d.provider}-${d.model}`}>
                        <td>{d.day}</td>
                        <td>{d.provider}</td>
                        <td>{d.model}</td>
                        <td className={s.num}>{usd(d.providerUsd)}</td>
                        <td className={s.num}>{usd(d.meteredUsd)}</td>
                        <td className={`${s.num} ${s.over}`}>{pct(d.driftRatio)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : null}
            </div>
          </section>
        </div>
      ) : null}
    </main>
  );
}
