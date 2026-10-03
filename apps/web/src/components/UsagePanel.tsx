"use client";

import { useCallback, useEffect, useState } from "react";
import { count, niceCeil, pct, tokens, usd, usdNumber } from "@/lib/format";
import type { Figures, MeterRow, PeriodKey, SpendSplit, UsageError, UsageResponse } from "@/lib/usage-types";
import { PERIODS } from "@/lib/usage-types";
import { DailySpend } from "./DailySpend";
import { CoachingPanel, ScorePanel, TeamCoachingPanel } from "./Coaching";
import { Meter, type MeterSplit } from "./Meter";
import s from "./usage.module.css";

type View = { kind: "self" } | { kind: "team"; teamId: string } | { kind: "member"; teamId: string; ref: string };

const PERIOD_LABEL: Record<PeriodKey, string> = { "7d": "7D", "30d": "30D", month: "Month" };

function toMeter(split: SpendSplit): MeterSplit {
  return {
    productive: split.productiveUsd === null ? null : usdNumber(split.productiveUsd),
    wasted: split.wastedUsd === null ? null : usdNumber(split.wastedUsd),
    unclassified: usdNumber(split.unclassifiedUsd),
  };
}

function queryOf(view: View, period: PeriodKey): string {
  const p = new URLSearchParams({ view: view.kind, period });
  if (view.kind !== "self") p.set("team", view.teamId);
  if (view.kind === "member") p.set("ref", view.ref);
  return p.toString();
}

function FigureTip({ title, f }: { title: string; f: Figures }) {
  const prompt = f.inputTokens + f.cacheReadTokens + f.cacheWriteTokens;
  return (
    <>
      <div style={{ fontWeight: 600 }}>{title}</div>
      <div>Spend {usd(f.costUsd)}{usdNumber(f.wastedUsd) > 0 ? ` · wasted ${usd(f.wastedUsd)}` : ""}</div>
      <div>{count(f.requests, "request")}</div>
      <div>Input {tokens(f.inputTokens)} · Output {tokens(f.outputTokens)}</div>
      <div>Cache reads {pct(f.cacheReadTokens, prompt)} of prompt</div>
    </>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className={s.stat}>
      <div className="label">{label}</div>
      <div className={s.statValue}>{value}</div>
    </div>
  );
}

export function UsagePanel() {
  const [view, setView] = useState<View>({ kind: "self" });
  const [period, setPeriod] = useState<PeriodKey>("30d");
  const [data, setData] = useState<UsageResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [savingConsent, setSavingConsent] = useState(false);

  const load = useCallback(async (v: View, p: PeriodKey) => {
    setLoading(true);
    try {
      const res = await fetch(`/api/usage?${queryOf(v, p)}`, { cache: "no-store" });
      if (res.status === 401) {
        window.location.href = "/login";
        return;
      }
      const body = (await res.json()) as UsageResponse | UsageError;
      if ("error" in body) {
        setError(body.error.message);
      } else {
        setData(body);
        setError(null);
      }
    } catch {
      setError("Usage could not be loaded. Check your connection and retry.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(view, period);
  }, [view, period, load]);

  async function toggleConsent(grant: boolean) {
    setSavingConsent(true);
    try {
      await fetch("/api/consent", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ grant }) });
      await load(view, period);
    } finally {
      setSavingConsent(false);
    }
  }

  async function signOut() {
    await fetch("/api/session", { method: "DELETE" });
    window.location.href = "/login";
  }

  const managed = data?.viewer.teams.filter((t) => t.access !== "member") ?? [];
  const budgetLimit = data?.budget ? usdNumber(data.budget.limitUsd) : null;
  const total = data ? usdNumber(data.totals.costUsd) : 0;
  const aggregateScale = niceCeil(total);
  const monthSpent = data?.budget ? usdNumber(data.budget.spentThisMonthUsd) : 0;
  const overLimit = budgetLimit !== null && monthSpent >= budgetLimit;
  const limitScale = niceCeil(Math.max(budgetLimit ?? 0, monthSpent));
  const rowScale = niceCeil(Math.max(0, ...(data?.rows ?? []).map((r) => usdNumber(r.figures.costUsd))));
  const promptTokens = data ? data.totals.inputTokens + data.totals.cacheReadTokens + data.totals.cacheWriteTokens : 0;
  const scopeTitle =
    data?.scope.kind === "team" ? `Team · ${data.scope.teamName}` : data?.scope.kind === "member" ? data.scope.displayName : "My usage";

  return (
    <main className={s.page}>
      <header className={s.header}>
        <div>
          <div className={`display ${s.wordmark}`}>TokenGrid</div>
          <div className="label">Load panel · metered at the gateway</div>
        </div>
        {data ? (
          <div className={s.who}>
            <span className="mono">
              {data.viewer.displayName}
              {data.viewer.orgRole === "admin" ? <span className="label"> · org admin</span> : null}
            </span>
            <button type="button" onClick={() => void signOut()}>
              Sign out
            </button>
          </div>
        ) : null}
      </header>

      <nav className={s.filters} aria-label="Usage filters">
        <div className={s.group} role="group" aria-label="View">
          <button type="button" aria-pressed={view.kind === "self"} onClick={() => setView({ kind: "self" })}>
            My usage
          </button>
          {managed.map((t) => (
            <button
              key={t.id}
              type="button"
              aria-pressed={view.kind !== "self" && view.teamId === t.id}
              onClick={() => setView({ kind: "team", teamId: t.id })}
            >
              Team · {t.name}
            </button>
          ))}
        </div>
        <div className={s.group} role="group" aria-label="Period">
          {PERIODS.map((p) => (
            <button key={p} type="button" aria-pressed={period === p} onClick={() => setPeriod(p)}>
              {PERIOD_LABEL[p]}
            </button>
          ))}
        </div>
        {data ? (
          <span className={`label ${s.range}`}>
            {data.period.start.slice(0, 10)} → {new Date(Date.parse(data.period.end) - 1).toISOString().slice(0, 10)} · UTC
          </span>
        ) : null}
      </nav>

      {error ? (
        <div className={`${s.banner} ${s.error}`} role="alert" style={{ marginBottom: 16 }}>
          <span>
            <span className={`label ${s.errorLabel}`}>Error · </span>
            {error}
          </span>
          <button type="button" onClick={() => void load(view, period)}>
            Retry
          </button>
        </div>
      ) : null}

      {!data && loading ? <p className="label">Reading meters…</p> : null}

      {data ? (
        <div className={`${s.grid} ${loading ? s.stale : ""}`} aria-busy={loading}>
          {data.scope.kind === "member" ? (
            <div className={s.banner}>
              <span>
                Viewing <strong>{data.scope.displayName}</strong> individually. They allowed this, and this view is recorded in
                an audit log they can read.
              </span>
              <button type="button" onClick={() => setView({ kind: "team", teamId: data.scope.kind === "member" ? data.scope.teamId : "" })}>
                Back to team
              </button>
            </div>
          ) : null}

          <section className="panel" aria-labelledby="draw-title">
            <div className={s.panelHead}>
              <h2 id="draw-title" className="label" style={{ margin: 0 }}>
                Draw · {scopeTitle}
              </h2>
              <span className="label">{count(data.totals.requests, "request")}</span>
            </div>
            <div className={s.panelBody}>
              {data.totals.requests === 0 ? (
                <>
                  <p style={{ marginTop: 0 }}>
                    No metered calls in this period. Calls appear here once a client sends them through the gateway with a
                    TokenGrid key:
                  </p>
                  <div className={s.code}>{`new Anthropic({ apiKey: "tgk_…", baseURL: "<gateway URL>" })`}</div>
                </>
              ) : (
                <>
                  <div className={s.hero}>
                    <span className={`display ${s.heroValue}`}>{usd(data.totals.costUsd)}</span>
                    <span className={s.heroUnit}>USD spent</span>
                    {data.split.wastedUsd !== null && usdNumber(data.split.wastedUsd) > 0 ? (
                      <span className="label">
                        {usd(data.split.wastedUsd)} wasted on discarded responses · {pct(usdNumber(data.split.wastedUsd), total)}
                      </span>
                    ) : null}
                  </div>
                  <Meter
                    split={toMeter(data.split)}
                    scaleMax={aggregateScale}
                    description={`${usd(data.totals.costUsd)} spent on a scale to ${usd(aggregateScale)}`}
                    tooltip={<FigureTip title={scopeTitle} f={data.totals} />}
                  />
                  <div className={s.scaleCaption}>
                    <span className="label">$0</span>
                    <span className="label">10% = {usd(aggregateScale / 10)}</span>
                    <span className="label">{usd(aggregateScale)}</span>
                  </div>
                  <div className={s.stats}>
                    <Stat label="Input" value={tokens(data.totals.inputTokens)} />
                    <Stat label="Output" value={tokens(data.totals.outputTokens)} />
                    <Stat label="Cache reads" value={tokens(data.totals.cacheReadTokens)} />
                    <Stat label="Cache writes" value={tokens(data.totals.cacheWriteTokens)} />
                    <Stat label="Prompt from cache" value={pct(data.totals.cacheReadTokens, promptTokens)} />
                    <Stat label="Re-sent" value={count(data.totals.retriedRequests, "request")} />
                  </div>
                  <div className={s.legend}>
                    {data.split.productiveUsd !== null ? (
                      <span className={`${s.key} label`}>
                        <span className={`${s.swatch} ${s.swProductive}`} /> Kept {usd(data.split.productiveUsd)}
                      </span>
                    ) : null}
                    {data.split.wastedUsd !== null ? (
                      <span className={`${s.key} label`}>
                        <span className={`${s.swatch} ${s.swWasted}`} /> Wasted {usd(data.split.wastedUsd)}
                      </span>
                    ) : null}
                    {usdNumber(data.split.unclassifiedUsd) > 0 ? (
                      <span className={`${s.key} label`}>
                        <span className={`${s.swatch} ${s.swUnclassified}`} /> Unclassified {usd(data.split.unclassifiedUsd)}
                      </span>
                    ) : null}
                  </div>
                  <p className={s.note}>
                    Wasted is spend on responses thrown away because the same prompt was sent again within 15 minutes, counted in
                    the hour the discarded request ran. Kept means not re-sent; nothing yet reports whether a kept answer was used.
                  </p>
                  {data.totals.incompleteRequests > 0 ? (
                    <p className={s.note}>
                      {count(data.totals.incompleteRequests, "request")} ended before the provider reported final usage; their
                      output is counted as a minimum.
                    </p>
                  ) : null}
                </>
              )}
            </div>
          </section>

          {data.budget && budgetLimit !== null ? (
            <section className="panel" aria-labelledby="limit-title">
              <div className={s.panelHead}>
                <h2 id="limit-title" className="label" style={{ margin: 0 }}>
                  Monthly limit · this calendar month, UTC
                </h2>
                <span className={`label ${overLimit ? s.over : ""}`}>{overLimit ? "Over limit · calls refused" : "Within limit"}</span>
              </div>
              <div className={s.panelBody}>
                <Meter
                  split={{ productive: null, wasted: null, unclassified: monthSpent }}
                  scaleMax={limitScale}
                  limit={budgetLimit}
                  description={`${usd(monthSpent)} of a ${usd(budgetLimit)} monthly limit used`}
                />
                <div className={s.scaleCaption}>
                  <span className="label">$0</span>
                  <span className="label">
                    {usd(monthSpent)} of {usd(budgetLimit)} limit · 10% = {usd(limitScale / 10)}
                  </span>
                  <span className="label">{usd(limitScale)}</span>
                </div>
                {overLimit ? (
                  <p className={`${s.note} ${s.over}`}>
                    The gateway is refusing your calls with HTTP 402 until the limit resets at the start of next month (UTC).
                  </p>
                ) : null}
              </div>
            </section>
          ) : null}

          {data.score ? <ScorePanel score={data.score} /> : null}
          {data.scope.kind !== "team" ? <CoachingPanel findings={data.findings} /> : <TeamCoachingPanel totals={data.teamFindings} />}

          {data.scope.kind === "team" ? (
            <TeamLines
              rows={data.rows}
              scale={rowScale}
              suppressed={data.scope.rowsSuppressed}
              onOpen={(ref) => setView({ kind: "member", teamId: data.scope.kind === "team" ? data.scope.teamId : "", ref })}
            />
          ) : null}

          <DailySpend points={data.daily} start={data.period.start} end={data.period.end} />

          <section className="panel" aria-labelledby="models-title">
            <div className={s.panelHead}>
              <h2 id="models-title" className="label" style={{ margin: 0 }}>
                By model
              </h2>
            </div>
            <div className={s.panelBody}>
              {data.models.length === 0 ? (
                <p className={s.note} style={{ marginTop: 0 }}>
                  No calls in this period.
                </p>
              ) : (
                <table className={s.table}>
                  <thead>
                    <tr>
                      <th className="label">Model</th>
                      <th className={`label ${s.num}`}>Requests</th>
                      <th className={`label ${s.num}`}>Spend</th>
                      <th className={`label ${s.num}`}>Share</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.models.map((m) => (
                      <tr key={m.model}>
                        <td>{m.model}</td>
                        <td className={s.num}>{count(m.requests, "req")}</td>
                        <td className={s.num}>{usd(m.costUsd)}</td>
                        <td className={s.num}>{pct(usdNumber(m.costUsd), total)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </section>

          {data.scope.kind === "self" ? (
            <section className="panel" aria-labelledby="privacy-title">
              <div className={s.panelHead}>
                <h2 id="privacy-title" className="label" style={{ margin: 0 }}>
                  Your data · who can see it
                </h2>
              </div>
              <div className={s.panelBody}>
                <p style={{ marginTop: 0 }}>
                  Managers see your team&apos;s totals with every person unnamed. They can open your individual usage only if you
                  allow it, and every time they do, it is listed below.
                </p>
                <button type="button" aria-pressed={data.viewer.consented} disabled={savingConsent} onClick={() => void toggleConsent(!data.viewer.consented)}>
                  {data.viewer.consented ? "Individual view allowed · revoke" : "Allow managers to open my individual view"}
                </button>
                <h3 className="label" style={{ margin: "16px 0 6px" }}>
                  Individual views of your usage
                </h3>
                {data.viewer.recentViews.length === 0 ? (
                  <p className={s.note} style={{ marginTop: 0 }}>
                    Nobody has opened your individual usage.
                  </p>
                ) : (
                  <table className={s.table}>
                    <tbody>
                      {data.viewer.recentViews.map((r) => (
                        <tr key={r.at}>
                          <td>{r.actor}</td>
                          <td className={s.num}>{new Date(r.at).toISOString().replace("T", " ").slice(0, 16)} UTC</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            </section>
          ) : null}
        </div>
      ) : null}
    </main>
  );
}

function TeamLines({
  rows,
  scale,
  suppressed,
  onOpen,
}: {
  rows: MeterRow[];
  scale: number;
  suppressed: boolean;
  onOpen: (ref: string) => void;
}) {
  return (
    <section className="panel" aria-labelledby="lines-title">
      <div className={s.panelHead}>
        <h2 id="lines-title" className="label" style={{ margin: 0 }}>
          Lines · one shared scale, $0 – {usd(scale)}
        </h2>
        <span className="label">Unnamed · order is not rank</span>
      </div>
      <div className={s.panelBody}>
        {rows.map((r) => (
          <div key={r.ref} className={s.row}>
            <span className={s.rowLabel}>{r.label}</span>
            <Meter
              split={toMeter(r.split)}
              scaleMax={scale}
              description={`${r.label}: ${usd(r.figures.costUsd)} on a scale to ${usd(scale)}`}
              tooltip={<FigureTip title={r.label} f={r.figures} />}
            />
            <span className={s.rowFigure}>{usd(r.figures.costUsd)}</span>
            <span>
              {r.drilldownAllowed && !r.isViewer ? (
                <button type="button" onClick={() => onOpen(r.ref)} title="Opens this person's individual usage and records it in their audit log">
                  Open · audited
                </button>
              ) : (
                <span className="label">{r.isViewer ? "" : "Private"}</span>
              )}
            </span>
          </div>
        ))}
        {suppressed ? (
          <p className={s.note}>
            Per-person lines are hidden: fewer than three other people in this team have usage this period, so unnamed lines
            would identify them. The total above still includes everyone.
          </p>
        ) : null}
      </div>
    </section>
  );
}
