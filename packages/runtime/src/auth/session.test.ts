import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkCredentials,
  checkLoginRateLimit,
  extractToken,
  getAuthConfig,
  isAuthorized,
  noteLoginFailure,
  noteLoginSuccess,
  SESSION_COOKIE,
  signSession,
  verifySession,
} from "./session";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "flowbun-auth-test-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("getAuthConfig", () => {
  const savedUser = Bun.env.FLOWBUN_AUTH_USERNAME;
  const savedPass = Bun.env.FLOWBUN_AUTH_PASSWORD;

  afterEach(() => {
    if (savedUser === undefined) delete Bun.env.FLOWBUN_AUTH_USERNAME;
    else Bun.env.FLOWBUN_AUTH_USERNAME = savedUser;
    if (savedPass === undefined) delete Bun.env.FLOWBUN_AUTH_PASSWORD;
    else Bun.env.FLOWBUN_AUTH_PASSWORD = savedPass;
  });

  test("null when neither env var is set", () => {
    delete Bun.env.FLOWBUN_AUTH_USERNAME;
    delete Bun.env.FLOWBUN_AUTH_PASSWORD;
    expect(getAuthConfig()).toBeNull();
  });

  test("null when only one env var is set", () => {
    Bun.env.FLOWBUN_AUTH_USERNAME = "alice";
    delete Bun.env.FLOWBUN_AUTH_PASSWORD;
    expect(getAuthConfig()).toBeNull();
  });

  test("returns the config once both are set", () => {
    Bun.env.FLOWBUN_AUTH_USERNAME = "alice";
    Bun.env.FLOWBUN_AUTH_PASSWORD = "hunter2";
    expect(getAuthConfig()).toEqual({ username: "alice", password: "hunter2" });
  });
});

describe("checkCredentials", () => {
  const config = { username: "alice", password: "hunter2" };

  test("true for the exact username+password", () => {
    expect(checkCredentials(config, "alice", "hunter2")).toBe(true);
  });

  test("false for a wrong password", () => {
    expect(checkCredentials(config, "alice", "wrong")).toBe(false);
  });

  test("false for a wrong username", () => {
    expect(checkCredentials(config, "bob", "hunter2")).toBe(false);
  });

  test("false when either side is empty", () => {
    expect(checkCredentials(config, "", "")).toBe(false);
  });

  test("survives comparing strings of very different lengths without throwing", () => {
    expect(checkCredentials(config, "a", "b".repeat(10_000))).toBe(false);
  });
});

describe("signSession / verifySession", () => {
  test("round-trips: a freshly signed token verifies", () => {
    const token = signSession(dir, "alice");
    expect(verifySession(dir, token)).toBe(true);
  });

  test("the secret persists across calls -- a token signed in one call still verifies in a later one", () => {
    const token = signSession(dir, "alice");
    // Simulate a second process/request reading the same on-disk secret
    // rather than reusing this process's in-memory cache: this is the
    // scenario a container restart is exercising for real.
    expect(verifySession(dir, token)).toBe(true);
    expect(verifySession(dir, token)).toBe(true);
  });

  test("rejects a token signed with a different flow's/dataDir's secret", () => {
    const otherDir = mkdtempSync(join(tmpdir(), "flowbun-auth-test-other-"));
    try {
      const token = signSession(otherDir, "alice");
      expect(verifySession(dir, token)).toBe(false);
    } finally {
      rmSync(otherDir, { recursive: true, force: true });
    }
  });

  function decodeParts(token: string): {
    header: string;
    payload: string;
    signature: string;
    claims: { sub: string; iat: number; exp: number };
  } {
    const [header, payload, signature] = token.split(".");
    if (
      header === undefined ||
      payload === undefined ||
      signature === undefined
    ) {
      throw new Error(`not a well-formed token: ${token}`);
    }
    const claims = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8"),
    );
    return { header, payload, signature, claims };
  }

  test("rejects a tampered payload (username swapped post-signing)", () => {
    const token = signSession(dir, "alice");
    const { header, signature, claims } = decodeParts(token);
    const forgedPayload = Buffer.from(
      JSON.stringify({ ...claims, sub: "eve" }),
    ).toString("base64url");
    const forged = `${header}.${forgedPayload}.${signature}`;
    expect(verifySession(dir, forged)).toBe(false);
  });

  test("rejects an expired token", () => {
    const token = signSession(dir, "alice");
    const { header, claims } = decodeParts(token);
    const expiredPayload = Buffer.from(
      JSON.stringify({ ...claims, exp: Math.floor(Date.now() / 1000) - 60 }),
    ).toString("base64url");
    // Re-sign over the tampered payload using the same on-disk secret this
    // dir already has, so this test isolates "exp in the past" rather than
    // also tripping the signature check above.
    const secretHex = readFileSync(
      join(dir, "state", "auth-secret.key"),
      "utf8",
    );
    const secret = Buffer.from(secretHex.trim(), "hex");
    const signature = createHmac("sha256", secret)
      .update(`${header}.${expiredPayload}`)
      .digest("base64url");
    expect(verifySession(dir, `${header}.${expiredPayload}.${signature}`)).toBe(
      false,
    );
  });

  test("rejects malformed tokens", () => {
    expect(verifySession(dir, "not-a-jwt")).toBe(false);
    expect(verifySession(dir, "a.b")).toBe(false);
    expect(verifySession(dir, "")).toBe(false);
    expect(verifySession(dir, null)).toBe(false);
    expect(verifySession(dir, undefined)).toBe(false);
  });
});

describe("extractToken", () => {
  test("reads a Bearer authorization header", () => {
    const req = new Request("http://x/", {
      headers: { authorization: "Bearer abc.def.ghi" },
    });
    expect(extractToken(req)).toBe("abc.def.ghi");
  });

  test("reads the session cookie", () => {
    const req = new Request("http://x/", {
      headers: { cookie: `foo=bar; ${SESSION_COOKIE}=abc.def.ghi; baz=qux` },
    });
    expect(extractToken(req)).toBe("abc.def.ghi");
  });

  test("prefers the Authorization header over a cookie if both are present", () => {
    const req = new Request("http://x/", {
      headers: {
        authorization: "Bearer from-header",
        cookie: `${SESSION_COOKIE}=from-cookie`,
      },
    });
    expect(extractToken(req)).toBe("from-header");
  });

  test("null when neither is present", () => {
    expect(extractToken(new Request("http://x/"))).toBeNull();
  });
});

describe("isAuthorized", () => {
  const savedUser = Bun.env.FLOWBUN_AUTH_USERNAME;
  const savedPass = Bun.env.FLOWBUN_AUTH_PASSWORD;

  afterEach(() => {
    if (savedUser === undefined) delete Bun.env.FLOWBUN_AUTH_USERNAME;
    else Bun.env.FLOWBUN_AUTH_USERNAME = savedUser;
    if (savedPass === undefined) delete Bun.env.FLOWBUN_AUTH_PASSWORD;
    else Bun.env.FLOWBUN_AUTH_PASSWORD = savedPass;
  });

  test("true with no credentials attached when auth isn't configured", () => {
    delete Bun.env.FLOWBUN_AUTH_USERNAME;
    delete Bun.env.FLOWBUN_AUTH_PASSWORD;
    expect(isAuthorized(new Request("http://x/"), dir)).toBe(true);
  });

  test("false with no session when auth is configured", () => {
    Bun.env.FLOWBUN_AUTH_USERNAME = "alice";
    Bun.env.FLOWBUN_AUTH_PASSWORD = "hunter2";
    expect(isAuthorized(new Request("http://x/"), dir)).toBe(false);
  });

  test("true with a valid session when auth is configured", () => {
    Bun.env.FLOWBUN_AUTH_USERNAME = "alice";
    Bun.env.FLOWBUN_AUTH_PASSWORD = "hunter2";
    const token = signSession(dir, "alice");
    const req = new Request("http://x/", {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(isAuthorized(req, dir)).toBe(true);
  });
});

describe("checkLoginRateLimit / noteLoginFailure / noteLoginSuccess", () => {
  // loginAttempts is module-global state, keyed by caller -- a fresh random
  // key per test keeps these independent of each other and of any other
  // test file that happens to exercise the same module.
  function freshKey(): string {
    return crypto.randomUUID();
  }

  test("a fresh key is always allowed", () => {
    expect(checkLoginRateLimit(freshKey())).toEqual({ allowed: true });
  });

  test("stays allowed below the failure threshold", () => {
    const key = freshKey();
    noteLoginFailure(key);
    noteLoginFailure(key);
    expect(checkLoginRateLimit(key)).toEqual({ allowed: true });
  });

  test("locks out once the failure threshold is reached, with a positive retryAfterSeconds", () => {
    const key = freshKey();
    for (let i = 0; i < 5; i++) noteLoginFailure(key);
    const result = checkLoginRateLimit(key);
    expect(result.allowed).toBe(false);
    expect(result.retryAfterSeconds).toBeGreaterThan(0);
  });

  test("noteLoginSuccess clears an in-progress failure count", () => {
    const key = freshKey();
    noteLoginFailure(key);
    noteLoginFailure(key);
    noteLoginFailure(key);
    noteLoginFailure(key);
    noteLoginSuccess(key);
    // A 5th failure right after a success starts a fresh window/count, not
    // a continuation of the pre-success streak -- shouldn't lock out yet.
    noteLoginFailure(key);
    expect(checkLoginRateLimit(key)).toEqual({ allowed: true });
  });

  test("each key is throttled independently", () => {
    const lockedKey = freshKey();
    const freeKey = freshKey();
    for (let i = 0; i < 5; i++) noteLoginFailure(lockedKey);
    expect(checkLoginRateLimit(lockedKey).allowed).toBe(false);
    expect(checkLoginRateLimit(freeKey)).toEqual({ allowed: true });
  });
});
