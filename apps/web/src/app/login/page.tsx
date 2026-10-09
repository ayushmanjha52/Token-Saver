import Link from "next/link";
import s from "@/components/usage.module.css";

export const dynamic = "force-dynamic";

const ERRORS: Record<string, string> = {
  bad_credentials: "Email or password is incorrect.",
  locked: "Too many failed attempts. This account is locked for 15 minutes.",
  throttled: "Too many attempts from this network. Try again in a few minutes.",
  origin: "That request came from another site and was refused. Sign in from this page.",
  link: "That sign-in link is invalid, expired or already used. Ask your admin for a new one.",
  unknown: "No user with that email. Run pnpm db:seed to create the demo users.",
  internal: "Something went wrong on our side. Try again.",
};

export default function LoginPage({ searchParams }: { searchParams: { error?: string } }) {
  const production = process.env.NODE_ENV === "production";
  const error = searchParams.error ? ERRORS[searchParams.error] : undefined;
  return (
    <main className={s.authPage}>
      <div className={s.authCard}>
        <div className={`display ${s.wordmark}`}>
          Token<em>Grid</em>
        </div>
        <p className={s.authTagline}>Metered AI spend, per person, on one scale.</p>

        <section className="panel">
          <div className={s.panelBody}>
            <h1 className={`display ${s.authTitle}`}>Sign in</h1>
            <p className={s.hint} style={{ margin: "0 0 20px" }}>
              Welcome back.
            </p>
            {error ? (
              <p className={s.alert} role="alert" style={{ marginBottom: 16 }}>
                {error}
              </p>
            ) : null}
            <form method="post" action="/api/auth/signin" className={s.form}>
              <label className={s.field}>
                <span className="label">Email</span>
                <input name="email" type="email" required autoComplete="email" />
              </label>
              <label className={s.field}>
                <span className="label">Password</span>
                <input name="password" type="password" required autoComplete="current-password" />
              </label>
              <button type="submit" className={s.primary}>
                Sign in
              </button>
            </form>
            <div className={s.authFoot}>
              New to TokenGrid? <Link href="/signup">Create an account</Link>
            </div>
          </div>
        </section>

        <p className={s.authNote}>Invited by an admin? Open the one-time sign-in link they sent you.</p>

        {production ? null : (
          <section className="panel" style={{ marginTop: 16 }}>
            <div className={s.panelBody}>
              <form method="post" action="/api/session" className={s.form}>
                <label className={s.field}>
                  <span className="label">Development · sign in as any seeded user</span>
                  <input name="email" type="email" required autoComplete="off" placeholder="manager@tokengrid.local" />
                </label>
                <button type="submit">Sign in without a password</button>
              </form>
            </div>
          </section>
        )}
      </div>
    </main>
  );
}
