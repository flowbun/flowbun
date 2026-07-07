import index from "./client/index.html";

const PORT = Number(Bun.env.FLOWBUN_EDITOR_PORT ?? 4200);
const COORDINATOR_WS =
  Bun.env.FLOWBUN_COORDINATOR_WS ?? "ws://localhost:8787/ws";

Bun.serve({
  port: PORT,
  development: { hmr: true, console: true },
  routes: {
    "/": index,
    // A small runtime-config endpoint so the coordinator's address isn't
    // baked into the client bundle at build time — the browser fetches this
    // once on boot; keeps both dev servers independently restartable/movable.
    "/config.json": () => Response.json({ coordinatorWsUrl: COORDINATOR_WS }),
  },
});

console.log(
  `[editor] http://localhost:${PORT}  (coordinator ws: ${COORDINATOR_WS})`,
);
