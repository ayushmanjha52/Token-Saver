import s from "@/components/usage.module.css";

export const dynamic = "force-dynamic";

export default function LoginPage({ searchParams }: { searchParams: { error?: string } }) {
  const production = process.env.NODE_ENV === "production";
  return (
    <main className={s.page} style={{ maxWidth: 480 }}>
      <div className={`display ${s.wordmark}`}>TokenGrid</div>
      <section className="panel" style={{ marginTop: 24 }}>
        <div className={s.panelHead}>
          <h1 className="label" style={{ margin: 0 }}>
            Sign in · development
          </h1>
        </div>
        <div className={s.panelBody}>
          {searchParams.error === "link" ? (
            <p className="mono" role="alert" style={{ margin: "0 0 12px", color: "var(--oxblood)" }}>
              That sign-in link is invalid, expired or already used. Ask an admin for a new one.
            </p>
          ) : null}
          {production ? (
            <p style={{ margin: 0 }}>
              Sign in with the one-time link an org admin sends you. Admins issue them with{" "}
              <span className="mono">admin login-link --email you@company.com</span>; links expire after 15 minutes and work once.
            </p>
          ) : (
            <form method="post" action="/api/session" style={{ display: "grid", gap: 12 }}>
              <label className="label" htmlFor="email">
                Email of a user in the database
              </label>
              <input id="email" name="email" type="email" required autoComplete="email" />
              {searchParams.error === "unknown" ? (
                <p className="mono" role="alert" style={{ margin: 0, color: "var(--oxblood)" }}>
                  No user with that email. Run pnpm db:seed to create the demo users.
                </p>
              ) : null}
              <button type="submit">Sign in</button>
            </form>
          )}
        </div>
      </section>
    </main>
  );
}
