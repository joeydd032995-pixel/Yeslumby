"use client";

import { useEffect } from "react";

/**
 * Render failures as pages rather than blank 500s.
 *
 * Authorization failures reach here: a signed-in user asking for another
 * tenant's ecosystem gets a clear refusal instead of a stack trace, and the
 * message deliberately does not say whether the resource exists.
 */
export default function ErrorBoundary({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  const denied = /requires (OWNER|ADMIN|ARCHITECT|OPERATOR|VIEWER)/.test(error.message);

  return (
    <main className="shell" style={{ paddingTop: 64 }}>
      <div className="panel" style={{ padding: 28, maxWidth: 560 }}>
        <h1>{denied ? "Not available" : "Something went wrong"}</h1>
        <p className="sub">
          {denied
            ? "This ecosystem is not available to your account."
            : "The page could not be rendered."}
        </p>
        <div className="row" style={{ marginTop: 18 }}>
          <a className="btn primary" href="/dashboard">
            Back to dashboard
          </a>
          {!denied && (
            <button onClick={reset} type="button">
              Try again
            </button>
          )}
        </div>
      </div>
    </main>
  );
}
