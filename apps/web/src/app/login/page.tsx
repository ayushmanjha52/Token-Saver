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
          {production ? (
            <p style={{ margin: 0 }}>Email-only sign-in is disabled in production. An identity provider has not been configured.</p>
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
