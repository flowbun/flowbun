import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Opt-in auth: off by default (every existing deployment keeps working
 * exactly as before, no login at all), on the moment both
 * FLOWBUN_AUTH_USERNAME and FLOWBUN_AUTH_PASSWORD are set. Consumed by both
 * the editor's HTTP routes (server.ts) and the coordinator's ws upgrade
 * (ws-server.ts) — this is the one shared place that decides what "logged
 * in" means for either process, so they can never disagree with each other.
 *
 * Sessions are long-lived (10 years) by design, not an oversight: this is
 * meant for one household's own LAN, not a multi-tenant service, so "log in
 * once, stay in" is the right tradeoff over repeatedly re-prompting whoever
 * already has the password.
 */
const SESSION_TTL_SECONDS = Math.floor(10 * 365.25 * 24 * 60 * 60);

export const SESSION_COOKIE = "flowbun_session";

export interface AuthConfig {
  username: string;
  password: string;
}

export function getAuthConfig(): AuthConfig | null {
  const username = Bun.env.FLOWBUN_AUTH_USERNAME;
  const password = Bun.env.FLOWBUN_AUTH_PASSWORD;
  if (!username || !password) return null;
  return { username, password };
}

/**
 * Hashes both sides to a fixed-length digest before comparing, so neither a
 * length mismatch nor a byte mismatch is observable via timing — safer than
 * a direct string/Buffer compare even though these values originate from
 * plaintext env vars rather than a hashed credential store.
 */
function constantTimeEqual(a: string, b: string): boolean {
  const key = "flowbun-auth-compare";
  const ah = createHmac("sha256", key).update(a).digest();
  const bh = createHmac("sha256", key).update(b).digest();
  return timingSafeEqual(ah, bh);
}

export function checkCredentials(
  config: AuthConfig,
  username: string,
  password: string,
): boolean {
  return (
    constantTimeEqual(username, config.username) &&
    constantTimeEqual(password, config.password)
  );
}

const LOGIN_MAX_ATTEMPTS = 5;
const LOGIN_WINDOW_MS = 5 * 60_000;
const LOGIN_LOCKOUT_MS = 5 * 60_000;

interface LoginAttemptState {
  failures: number;
  windowStart: number;
  lockedUntil: number;
}

/**
 * Per-key (by caller's IP -- see editor's server.ts) in-memory login
 * throttle: checkCredentials() itself is timing-safe, but nothing was
 * stopping unlimited attempts against it. In-memory and un-keyed-by-dataDir
 * is deliberate, matching this module's single-household-LAN scope (see the
 * module doc comment above) -- it resets on a restart, which is fine since
 * the goal is slowing down a live brute-force script, not persisting a ban
 * list.
 */
const loginAttempts = new Map<string, LoginAttemptState>();

export interface LoginRateLimitResult {
  allowed: boolean;
  retryAfterSeconds?: number;
}

/** Call before checking credentials -- refuses the attempt outright while
 * locked out, without touching checkCredentials at all. */
export function checkLoginRateLimit(key: string): LoginRateLimitResult {
  const state = loginAttempts.get(key);
  if (!state) return { allowed: true };
  const now = Date.now();
  if (now < state.lockedUntil) {
    return {
      allowed: false,
      retryAfterSeconds: Math.ceil((state.lockedUntil - now) / 1000),
    };
  }
  return { allowed: true };
}

/** Call after a failed checkCredentials(). Locks the key out for
 * LOGIN_LOCKOUT_MS once LOGIN_MAX_ATTEMPTS failures land inside one
 * LOGIN_WINDOW_MS window. */
export function noteLoginFailure(key: string): void {
  const now = Date.now();
  let state = loginAttempts.get(key);
  if (!state || now - state.windowStart > LOGIN_WINDOW_MS) {
    state = { failures: 0, windowStart: now, lockedUntil: 0 };
    loginAttempts.set(key, state);
  }
  state.failures += 1;
  if (state.failures >= LOGIN_MAX_ATTEMPTS) {
    state.lockedUntil = now + LOGIN_LOCKOUT_MS;
  }
}

/** Call after a successful checkCredentials() -- a legitimate login clears
 * whatever failure count this key had been accumulating. */
export function noteLoginSuccess(key: string): void {
  loginAttempts.delete(key);
}

/**
 * The JWT signing key lives under data/state/ (bind-mounted, and already
 * gitignored by data/.gitignore's own "state/" entry — the same place
 * flowbun.sqlite lives) rather than an env var: it's generated once, on
 * first use, by whichever of the coordinator/editor processes reaches here
 * first, and reused after that so a container restart doesn't invalidate
 * every existing session — the entire point of a 10-year TTL. The "wx" flag
 * makes first-boot safe even though the coordinator and editor start as
 * sibling processes (docker-entrypoint.ts) and could both race to create
 * it: whichever loses the race just re-reads what the winner wrote.
 */
function getOrCreateSecret(dataDir: string): Buffer {
  const dir = join(dataDir, "state");
  const path = join(dir, "auth-secret.key");
  try {
    const secret = Buffer.from(readFileSync(path, "utf8").trim(), "hex");
    // Heals permissions on a secret file created before mode:0o600 was
    // added below -- this key can mint 10-year sessions for a control API
    // that can write and execute arbitrary code (see AGENTS.md), so it
    // should never have been left world-readable in the first place.
    try {
      chmodSync(path, 0o600);
    } catch {
      // Best-effort: a read-only filesystem or permissions mismatch here
      // shouldn't block auth from working at all.
    }
    return secret;
  } catch {
    // Fall through to create.
  }
  mkdirSync(dir, { recursive: true });
  const secret = randomBytes(32);
  try {
    writeFileSync(path, secret.toString("hex"), { flag: "wx", mode: 0o600 });
    return secret;
  } catch {
    // Lost the create race to a sibling process -- read what it wrote.
    return Buffer.from(readFileSync(path, "utf8").trim(), "hex");
  }
}

const secretCache = new Map<string, Buffer>();
function secretFor(dataDir: string): Buffer {
  let secret = secretCache.get(dataDir);
  if (!secret) {
    secret = getOrCreateSecret(dataDir);
    secretCache.set(dataDir, secret);
  }
  return secret;
}

function base64url(input: Buffer): string {
  return input.toString("base64url");
}

/**
 * A minimal hand-rolled JWT (HS256 only) rather than a new dependency: the
 * only thing that ever verifies one of these tokens is verifySession()
 * below, which always signs/checks with HS256 itself and never trusts the
 * token's own "alg" header — the standard mitigation for the classic
 * alg:none / algorithm-confusion class of JWT vulnerabilities — and the
 * claim set is fixed and tiny (sub/iat/exp), simple enough that hand-rolling
 * it is lower risk than pulling in a general-purpose JWT library for it.
 */
export function signSession(dataDir: string, username: string): string {
  const secret = secretFor(dataDir);
  const header = base64url(
    Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })),
  );
  const now = Math.floor(Date.now() / 1000);
  const payload = base64url(
    Buffer.from(
      JSON.stringify({
        sub: username,
        iat: now,
        exp: now + SESSION_TTL_SECONDS,
      }),
    ),
  );
  const signature = base64url(
    createHmac("sha256", secret).update(`${header}.${payload}`).digest(),
  );
  return `${header}.${payload}.${signature}`;
}

export function verifySession(
  dataDir: string,
  token: string | undefined | null,
): boolean {
  if (!token) return false;
  const parts = token.split(".");
  if (parts.length !== 3) return false;
  const [header, payload, signature] = parts;
  if (
    header === undefined ||
    payload === undefined ||
    signature === undefined
  ) {
    return false;
  }
  const secret = secretFor(dataDir);
  const expectedSig = base64url(
    createHmac("sha256", secret).update(`${header}.${payload}`).digest(),
  );
  if (
    expectedSig.length !== signature.length ||
    !timingSafeEqual(Buffer.from(expectedSig), Buffer.from(signature))
  ) {
    return false;
  }
  try {
    const claims = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8"),
    );
    return typeof claims.exp === "number" && Date.now() / 1000 < claims.exp;
  } catch {
    return false;
  }
}

/**
 * Shared by both the editor's HTTP routes and the coordinator's ws upgrade
 * — pulls a session token from either an httpOnly cookie (browser clients,
 * set by POST /api/login) or an "Authorization: Bearer" header (script/curl
 * clients — consistent with this repo's design that anything the editor can
 * do, a script hitting the same endpoints can too).
 */
export function extractToken(req: Request): string | null {
  const auth = req.headers.get("authorization");
  if (auth?.startsWith("Bearer ")) return auth.slice("Bearer ".length);
  const cookie = req.headers.get("cookie");
  if (!cookie) return null;
  for (const part of cookie.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === SESSION_COOKIE) {
      return part.slice(eq + 1).trim();
    }
  }
  return null;
}

/** True when auth isn't configured at all (unauthenticated by default), or
 * when it is and the request carries a valid, unexpired session. */
export function isAuthorized(req: Request, dataDir: string): boolean {
  const config = getAuthConfig();
  if (!config) return true;
  return verifySession(dataDir, extractToken(req));
}
