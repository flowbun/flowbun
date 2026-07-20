import { join } from "node:path";
import {
  checkCredentials,
  getAuthConfig,
  isAuthorized,
  SESSION_COOKIE,
  signSession,
} from "flowbun/auth";
import index from "./client/index.html";

const PORT = Number(Bun.env.FLOWBUN_EDITOR_PORT ?? 4200);
const WS_PORT = Bun.env.FLOWBUN_WS_PORT ?? "8787";
const DATA_DIR =
  Bun.env.FLOWBUN_DATA_DIR ?? join(import.meta.dir, "..", "..", "..", "data");
// Matches flowbun/auth's own session TTL — used only for the cookie's
// Max-Age, not for anything session-validity-related (verifySession()
// checks the JWT's own "exp" claim, not this).
const SESSION_COOKIE_MAX_AGE_SECONDS = Math.floor(10 * 365.25 * 24 * 60 * 60);
// If FLOWBUN_COORDINATOR_WS is set explicitly, always use it. Otherwise
// derive the coordinator's address from whatever host/IP the browser
// actually used to reach this page — "localhost" would be wrong for
// anyone accessing this over the LAN (a different device, or the
// container's published port via the host's real IP), since the browser
// resolves "localhost" against itself, not this server.
const EXPLICIT_COORDINATOR_WS = Bun.env.FLOWBUN_COORDINATOR_WS;

Bun.serve({
  port: PORT,
  development: { hmr: true, console: true },
  routes: {
    "/": index,
    // A small runtime-config endpoint so the coordinator's address isn't
    // baked into the client bundle at build time — the browser fetches this
    // once on boot; keeps both dev servers independently restartable/movable.
    "/config.json": (req) => {
      const coordinatorWsUrl =
        EXPLICIT_COORDINATOR_WS ??
        `ws://${new URL(req.url).hostname}:${WS_PORT}/ws`;
      return Response.json({ coordinatorWsUrl });
    },
    // Tells the client whether to show a login screen at all, and whether
    // the current request already carries a valid session — checked once
    // on boot, before the client ever attempts the websocket connection
    // (see LoginGate.tsx). The real enforcement point is the coordinator's
    // own "/ws" upgrade handler (ws-server.ts), not this: this endpoint is
    // just UX, exactly like the rest of the editor having no privileged
    // access of its own.
    "/api/session": (req) => {
      const config = getAuthConfig();
      return Response.json({
        authRequired: config !== null,
        authenticated: config === null || isAuthorized(req, DATA_DIR),
      });
    },
    "/api/login": async (req) => {
      if (req.method !== "POST") {
        return new Response("method not allowed", { status: 405 });
      }
      const config = getAuthConfig();
      if (!config) return new Response("auth not configured", { status: 404 });
      const body = await req.json().catch(() => null);
      const username = typeof body?.username === "string" ? body.username : "";
      const password = typeof body?.password === "string" ? body.password : "";
      if (!checkCredentials(config, username, password)) {
        return new Response("invalid credentials", { status: 401 });
      }
      const token = signSession(DATA_DIR, username);
      return new Response(null, {
        status: 204,
        headers: {
          // No `Secure` attribute: this app is designed to run plain HTTP
          // on a home LAN (see README's Docker section), not behind TLS —
          // requiring Secure would silently break the cookie there.
          "Set-Cookie": `${SESSION_COOKIE}=${token}; Path=/; Max-Age=${SESSION_COOKIE_MAX_AGE_SECONDS}; HttpOnly; SameSite=Lax`,
        },
      });
    },
    "/api/logout": (req) => {
      if (req.method !== "POST") {
        return new Response("method not allowed", { status: 405 });
      }
      return new Response(null, {
        status: 204,
        headers: {
          "Set-Cookie": `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`,
        },
      });
    },
    // SPA fallback: the client renders its own routes (/flow/:file,
    // /flow/:file/node/:nodeId) via the History API, so a hard refresh or a
    // pasted deep link at one of those paths must still get the same
    // index.html — there's no server-side knowledge of "flows" here at all,
    // it's purely client-side routing. More specific routes above still win.
    "/*": index,
  },
});

console.log(
  `[editor] http://localhost:${PORT}  (coordinator ws port: ${EXPLICIT_COORDINATOR_WS ?? WS_PORT}, host derived per-request if not explicit)`,
);
