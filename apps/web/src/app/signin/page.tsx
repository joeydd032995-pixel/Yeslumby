import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { db } from "@/lib/db";
import { COOKIE_NAME, encodeSession } from "@/lib/auth";
import { TopBar, Panel, Empty } from "@/components/shell";

export const dynamic = "force-dynamic";

/**
 * Development sign-in.
 *
 * Picks an existing seeded user — it creates nothing and grants nothing beyond
 * that user's real membership row. The Clerk adapter replaces this page
 * wholesale; everything downstream reads `getSession` and is unaffected.
 */
export default async function SignIn() {
  const users = await db()<Array<{ id: string; email: string; name: string | null; role: string }>>`
    SELECT u.id, u.email, u.name, m.role
    FROM users u JOIN memberships m ON m.user_id = u.id
    ORDER BY u.created_at ASC LIMIT 10
  `;

  async function signIn(formData: FormData) {
    "use server";
    const userId = String(formData.get("userId") ?? "");
    if (!userId) return;
    const store = await cookies();
    store.set(COOKIE_NAME, encodeSession(userId), {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      maxAge: 60 * 60 * 24 * 7,
    });
    redirect("/dashboard");
  }

  return (
    <>
      <TopBar />
      <main className="shell">
        <div className="page-head">
          <div className="grow">
            <h1>Sign in</h1>
            <p className="sub">
              Development provider. Choose a seeded user; roles come from their real membership.
            </p>
          </div>
        </div>
        <Panel>
          {users.length === 0 ? (
            <Empty>
              No users seeded. Run <code>pnpm seed</code> first.
            </Empty>
          ) : (
            <div className="stack" style={{ gap: 10 }}>
              {users.map((u) => (
                <form key={u.id} action={signIn} className="row">
                  <input type="hidden" name="userId" value={u.id} />
                  <button type="submit" className="primary">
                    Continue as {u.name ?? u.email}
                  </button>
                  <span className="muted mono">{u.role}</span>
                </form>
              ))}
            </div>
          )}
        </Panel>
      </main>
    </>
  );
}
