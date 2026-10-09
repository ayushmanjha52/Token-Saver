import Link from "next/link";
import { redirect } from "next/navigation";
import s from "@/components/usage.module.css";
import { PASSWORD_MIN } from "@/lib/auth";
import { getSession } from "@/lib/session";

export const dynamic = "force-dynamic";

const ERRORS: Record<string, string> = {
  email_taken: "That email already has an account. Sign in instead, or ask your admin for a sign-in link.",
  throttled: "Too many sign-ups from this network. Try again in an hour.",
  origin: "That request came from another site and was refused. Sign up from this page.",
  internal: "Something went wrong on our side. Try again.",
};

export default function SignUpPage({ searchParams }: { searchParams: { error?: string; message?: string } }) {
  if (getSession()) redirect("/usage");
  const code = searchParams.error;
  const error = code === "invalid_input" ? (searchParams.message ?? "Check the details and try again.") : code ? ERRORS[code] : undefined;
  return (
    <main className={s.authPage}>
      <div className={s.authCard}>
        <div className={`display ${s.wordmark}`}>
          Token<em>Grid</em>
        </div>
        <p className={s.authTagline}>See where your team&apos;s AI spend goes, and what to change.</p>

        <section className="panel">
          <div className={s.panelBody}>
            <h1 className={`display ${s.authTitle}`}>Create an account</h1>
            <p className={s.hint} style={{ margin: "0 0 20px" }}>
              You&apos;ll be the admin of a new organization. Invite your team once you&apos;re in.
            </p>
            {error ? (
              <p className={s.alert} role="alert" style={{ marginBottom: 16 }}>
                {error}
              </p>
            ) : null}
            <form method="post" action="/api/auth/signup" className={s.form}>
              <label className={s.field}>
                <span className="label">Your name</span>
                <input name="name" required maxLength={80} autoComplete="name" />
              </label>
              <label className={s.field}>
                <span className="label">Work email</span>
                <input name="email" type="email" required maxLength={200} autoComplete="email" />
              </label>
              <label className={s.field}>
                <span className="label">Organization</span>
                <input name="organization" required maxLength={80} autoComplete="organization" />
              </label>
              <label className={s.field}>
                <span className="label">Password</span>
                <input name="password" type="password" required minLength={PASSWORD_MIN} maxLength={200} autoComplete="new-password" />
                <span className={s.hint}>At least {PASSWORD_MIN} characters.</span>
              </label>
              <button type="submit" className={s.primary}>
                Create account
              </button>
            </form>
            <div className={s.authFoot}>
              Already have an account? <Link href="/login">Sign in</Link>
            </div>
          </div>
        </section>

        <p className={s.authNote}>Your prompts are never stored. Your manager sees your individual usage only if you allow it.</p>
      </div>
    </main>
  );
}
