#!/usr/bin/env bun
// Two entrypoint processes under one container (per the original design):
// the coordinator (supervisor + HA boundary + websocket API + watcher) and
// the editor (static/dev server for the React app). If either dies, the
// whole container exits non-zero rather than silently running half-broken
// — let the container runtime's restart policy handle recovery.

const children: ReturnType<typeof Bun.spawn>[] = [];
let shuttingDown = false;

function spawnChild(name: string, cmd: string[]): void {
  const proc = Bun.spawn({
    cmd,
    stdio: ["inherit", "inherit", "inherit"],
    onExit(_proc, exitCode, signalCode) {
      if (shuttingDown) return;
      console.error(`[entrypoint] ${name} exited unexpectedly (code=${exitCode}, signal=${signalCode})`);
      shutdown(1);
    },
  });
  children.push(proc);
}

function shutdown(code: number): void {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) child.kill();
  process.exit(code);
}

process.on("SIGTERM", () => shutdown(0));
process.on("SIGINT", () => shutdown(0));

spawnChild("coordinator", [process.execPath, "run", "packages/coordinator/src/main.ts"]);
spawnChild("editor", [process.execPath, "run", "packages/editor/src/server.ts"]);
