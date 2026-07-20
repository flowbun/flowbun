import { useEffect, useState } from "react";

/**
 * Wraps the whole app (see App.tsx) so the websocket connection to the
 * coordinator — and everything it carries — is never even attempted until
 * we know we're authenticated (or that auth isn't configured at all). This
 * is UX, not the actual security boundary: the coordinator's own "/ws"
 * upgrade handler enforces auth independently (see ws-server.ts), exactly
 * like every other capability the editor has — nothing here is privileged.
 *
 * /api/session is a no-op passthrough (`authRequired: false`) unless
 * FLOWBUN_AUTH_USERNAME/FLOWBUN_AUTH_PASSWORD are both set on the
 * coordinator+editor processes, so an existing unauthenticated deployment
 * never sees this screen at all.
 */
type SessionStatus =
  | { kind: "loading" }
  | { kind: "unauthenticated" }
  | { kind: "authenticated"; authRequired: boolean };

export function LoginGate({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<SessionStatus>({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    fetch("/api/session")
      .then((r) => r.json())
      .then((data: { authRequired: boolean; authenticated: boolean }) => {
        if (cancelled) return;
        setStatus(
          !data.authRequired || data.authenticated
            ? { kind: "authenticated", authRequired: data.authRequired }
            : { kind: "unauthenticated" },
        );
      })
      .catch(() => {
        // Can't even reach the editor's own HTTP server — fail open rather
        // than stranding the user on a login screen they can never pass;
        // the coordinator's own ws upgrade still enforces auth regardless.
        if (!cancelled)
          setStatus({ kind: "authenticated", authRequired: false });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (status.kind === "loading") return null;
  if (status.kind === "unauthenticated") {
    return (
      <LoginForm
        onSuccess={() =>
          setStatus({ kind: "authenticated", authRequired: true })
        }
      />
    );
  }
  return (
    <>
      {children}
      {status.authRequired && <LogoutBadge />}
    </>
  );
}

function LoginForm({ onSuccess }: { onSuccess: () => void }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      if (res.ok) {
        onSuccess();
      } else {
        setError("Incorrect username or password.");
      }
    } catch {
      setError("Couldn't reach the server — try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="login-gate-page">
      <form
        className="create-dialog-panel login-gate-panel"
        onSubmit={handleSubmit}
      >
        <h3>Flowbun</h3>
        <label htmlFor="login-username">Username</label>
        <input
          id="login-username"
          // biome-ignore lint/a11y/noAutofocus: the entire page is this form -- there's nothing else to focus first.
          autoFocus
          autoComplete="username"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
        />
        <label htmlFor="login-password" className="login-gate-field">
          Password
        </label>
        <input
          id="login-password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        {error && <div className="create-dialog-error">{error}</div>}
        <div className="create-dialog-actions">
          <button
            type="submit"
            className="create-dialog-submit"
            disabled={submitting}
          >
            {submitting ? "Signing in…" : "Sign in"}
          </button>
        </div>
      </form>
    </div>
  );
}

function LogoutBadge() {
  const [loggingOut, setLoggingOut] = useState(false);

  async function handleLogout() {
    if (loggingOut) return;
    setLoggingOut(true);
    try {
      await fetch("/api/logout", { method: "POST" });
    } finally {
      // A full reload is the simplest way to tear down the websocket
      // connection and re-run LoginGate's own check from scratch, rather
      // than trying to reset every piece of app state by hand.
      window.location.reload();
    }
  }

  return (
    <button
      type="button"
      className="logout-badge"
      onClick={handleLogout}
      disabled={loggingOut}
      title="Log out"
    >
      {loggingOut ? "…" : "Log out"}
    </button>
  );
}
