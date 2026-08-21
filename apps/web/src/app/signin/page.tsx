import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { db } from "@/lib/db";
import { COOKIE_NAME, encodeSession, isAdminKeyValid, PUBLIC_ROLE } from "@/lib/auth";
import { TopBar, Panel, Empty } from "@/components/shell";

export const dynamic = "force-dynamic";

interface SeededUser {
  id: string;
  email: string;
  name: string | null;
  role: string;
}

/**
 * Development sign-in.
 *
 * Picks an existing seeded user — it creates nothing and grants nothing beyond
 * that user's real membership row. The Clerk adapter replaces this page
 * wholesale; everything downstream reads `getSession` and is unaffected.
 *
 * On a public deployment only VIEWER is offered. Anything above it can start
 * runs or approve mutations, which is not something a passer-by should be able
 * to do to someone else's ecosystem. Presenting `?key=` matching
 * `ADMIN_SIGNIN_KEY` restores the full list.
 */
export default async function SignIn({
  searchParams,
}: {
  searchParams: Promise<{ key?: string; denied?: string }>;
}) {
  const { key, denied } = await searchParams;
  const unlocked = isAdminKeyValid(key);

  const users = await db()<SeededUser[]>`
    SELECT u.id, u.email, u.name, m.role
    FROM users u JOIN memberships m ON m.user_id = u.id
    ORDER BY u.created_at ASC LIMIT 10
  `;
  const offered = unlocked ? users : users.filter((u) => u.role === PUBLIC_ROLE);

  async function signIn(formData: FormData) {
    "use server";
    const userId = String(formData.get("userId") ?? "");
    if (!userId) return;

    // The role is re-read here rather than taken from the form. Hiding a button
    // is not access control — the form fields are entirely under the caller's
    // control, so this action is the only place the decision can actually be
    // made.
    const [row] = await db()<Array<{ role: string }>>`
      SELECT m.role FROM users u JOIN memberships m ON m.user_id = u.id
      WHERE u.id = ${userId}
      LIMIT 1
    `;
    if (!row) return;

    if (row.role !== PUBLIC_ROLE && !isAdminKeyValid(String(formData.get("key") ?? ""))) {
      redirect("/signin?denied=1");
    }

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
              {unlocked
                ? "Development provider. Choose a seeded user; roles come from their real membership."
                : "This deployment is read-only. Sign in as a viewer to explore what the engine produced."}
            </p>
          </div>
        </div>
        <Panel>
          {denied ? (
            <p className="sub" role="alert">
              That account needs a key. Signing in above the viewer role is disabled here.
            </p>
          ) : null}
          {offered.length === 0 ? (
            <Empty>
              No users seeded. Run <code>pnpm seed</code> first.
            </Empty>
          ) : (
            <div className="stack" style={{ gap: 10 }}>
              {offered.map((u) => (
                <form key={u.id} action={signIn} className="row">
                  <input type="hidden" name="userId" value={u.id} />
                  {unlocked && key ? <input type="hidden" name="key" value={key} /> : null}
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
