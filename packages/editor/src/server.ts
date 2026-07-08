import index from "./client/index.html";

const PORT = Number(Bun.env.FLOWBUN_EDITOR_PORT ?? 4200);
const WS_PORT = Bun.env.FLOWBUN_WS_PORT ?? "8787";
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
