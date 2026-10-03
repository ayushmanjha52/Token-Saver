import { count, tokens, usd, usdNumber } from "@/lib/format";
import type { Finding, LintRuleId, RuleTotal, ScoreView } from "@/lib/usage-types";
import s from "./usage.module.css";

const RULE_TITLE: Record<LintRuleId, string> = {
  uncached_prefix: "Repeated prefix sent without caching",
  model_overspec: "Short tasks on a frontier model",
  missing_format_spec: "Long answers with no format asked for",
  large_context_short_answer: "Large context, short answers",
  missing_system_prompt: "Repeated workflow without a system prompt",
};

function explain(f: Finding): string {
  const d = f.detail;
  switch (f.rule) {
    case "uncached_prefix":
      return `The same ~${tokens(Number(d.prefixTokens ?? 0))} prefix went out ${count(f.requests7d, "time")} this week without cache_control. Marking it cacheable bills each repeat at the cache-read rate.`;
    case "model_overspec":
      return `${count(f.requests7d, "request")} with short prompts and short answers ran on ${f.model}. ${String(d.suggestedModel ?? "A balanced-tier model")} handles this shape for less.`;
    case "missing_format_spec":
      return `${count(f.requests7d, "answer")} averaged ${tokens(Number(d.avgOutputTokens ?? 0))} with no output shape requested. Naming the fields, length or list you need usually shortens them.`;
    case "large_context_short_answer":
      return `${count(f.requests7d, "request")} sent ~${tokens(Number(d.avgPromptTokens ?? 0))} of context for a short answer. Check whether all of it is needed, or cache what is.`;
    case "missing_system_prompt":
      return `The same kind of request ran ${count(f.requests7d, "time")} this week with no system prompt. A fixed system prompt makes the workflow cacheable and its answers more consistent.`;
  }
}

function Money({ savings, atStake }: { savings: string | null; atStake: string }) {
  return savings !== null ? (
    <div style={{ textAlign: "right" }}>
      <div className={s.statValue}>{usd(savings)}/mo</div>
      <div className="label">saved if fixed</div>
    </div>
  ) : (
    <div style={{ textAlign: "right" }}>
      <div className={s.statValue}>{usd(atStake)}/mo</div>
      <div className="label">spend affected</div>
    </div>
  );
}

export function CoachingPanel({ findings }: { findings: Finding[] }) {
  const savings = findings.reduce((a, f) => a + (f.monthlySavingsUsd ? usdNumber(f.monthlySavingsUsd) : 0), 0);
  return (
    <section className="panel" aria-labelledby="coach-title">
      <div className={s.panelHead}>
        <h2 id="coach-title" className="label" style={{ margin: 0 }}>
          Coaching · from the last 7 days, per month
        </h2>
        {savings > 0 ? <span className="label">{usd(savings)}/mo recoverable</span> : null}
      </div>
      <div className={s.panelBody}>
        {findings.length === 0 ? (
          <p className={s.note} style={{ marginTop: 0 }}>
            No findings. Static checks run on every call: uncached repeated prefixes, frontier models on short tasks, missing
            format instructions, large context for short answers, repeated work without a system prompt.
          </p>
        ) : (
          findings.map((f) => (
            <div key={`${f.rule}-${f.lastSeen}-${f.model}`} className={s.finding}>
              <div>
                <div style={{ fontWeight: 600 }}>{RULE_TITLE[f.rule]}</div>
                <p style={{ margin: "4px 0 0" }}>{explain(f)}</p>
                <div className="label" style={{ marginTop: 6 }}>
                  {f.model} · {count(f.requests7d, "request")} in 7 days · {usd(f.monthlyAtStakeUsd)}/mo affected
                </div>
              </div>
              <Money savings={f.monthlySavingsUsd} atStake={f.monthlyAtStakeUsd} />
            </div>
          ))
        )}
      </div>
    </section>
  );
}

export function TeamCoachingPanel({ totals }: { totals: RuleTotal[] }) {
  return (
    <section className="panel" aria-labelledby="team-coach-title">
      <div className={s.panelHead}>
        <h2 id="team-coach-title" className="label" style={{ margin: 0 }}>
          Coaching · team totals, per month
        </h2>
        <span className="label">Counted per habit, not per person</span>
      </div>
      <div className={s.panelBody}>
        {totals.length === 0 ? (
          <p className={s.note} style={{ marginTop: 0 }}>
            No findings across the team this week.
          </p>
        ) : (
          totals.map((t) => (
            <div key={t.rule} className={s.finding}>
              <div>
                <div style={{ fontWeight: 600 }}>{RULE_TITLE[t.rule]}</div>
                <div className="label" style={{ marginTop: 6 }}>
                  {t.people === null ? "Fewer than 3 people" : count(t.people, "person")} · {usd(t.monthlyAtStakeUsd)}/mo affected
                </div>
              </div>
              <Money savings={t.monthlySavingsUsd} atStake={t.monthlyAtStakeUsd} />
            </div>
          ))
        )}
      </div>
    </section>
  );
}

const COMPONENT: Record<ScoreView["components"][number]["key"], { name: string; measures: string; missing: string }> = {
  retry: { name: "Retries", measures: "Requests not re-sent", missing: "No requests" },
  modelFit: { name: "Model fit", measures: "Spend not on short tasks sent to a frontier model", missing: "No prompt data" },
  cache: { name: "Cache use", measures: "Cacheable prefix tokens served from cache", missing: "No cacheable prefixes" },
  acceptance: { name: "Acceptance", measures: "Answers used downstream", missing: "No signal reported yet" },
};

/** The score never appears without the components and weights that produced it. */
export function ScorePanel({ score }: { score: ScoreView }) {
  return (
    <section className="panel" aria-labelledby="score-title">
      <div className={s.panelHead}>
        <h2 id="score-title" className="label" style={{ margin: 0 }}>
          Efficiency · trailing {score.windowDays} days to {score.asOfDay}
        </h2>
        <span className="label">{count(score.requests, "request")}</span>
      </div>
      <div className={s.panelBody}>
        <div className={s.hero}>
          <span className={`display ${s.heroValue}`}>{score.score === null ? "—" : Math.round(Number(score.score))}</span>
          <span className={s.heroUnit}>/ 100 · weighted sum of the components below</span>
        </div>
        <table className={s.table}>
          <thead>
            <tr>
              <th className="label">Component</th>
              <th className="label">Measures</th>
              <th className={`label ${s.num}`}>Value</th>
              <th className={`label ${s.num}`}>Weight</th>
            </tr>
          </thead>
          <tbody>
            {score.components.map((c) => (
              <tr key={c.key}>
                <td>{COMPONENT[c.key].name}</td>
                <td>{COMPONENT[c.key].measures}</td>
                <td className={s.num}>{c.value === null ? COMPONENT[c.key].missing : `${(Number(c.value) * 100).toFixed(1)}%`}</td>
                <td className={s.num}>{c.value === null ? "0% · redistributed" : `${(Number(c.weight) * 100).toFixed(0)}%`}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
