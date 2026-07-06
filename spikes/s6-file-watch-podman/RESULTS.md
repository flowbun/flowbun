# S6: File watching on bind mount under Podman/Fedora

## Question
Does Node/Bun `fs.watch` on a bind-mounted host directory reliably see host-side file changes from inside a Podman container on this machine (Fedora Asahi Remix, aarch64), or is the mtime-polling fallback required?

## Method
Container runtime: Podman 5.8.2 (native Linux, no VM layer), rootless, overlay storage driver. Image: `oven/bun:latest` (project's actual target base image; pulled in ~7s, no need to fall back to node:alpine).

Host directory `watched-dir/` (2 starter files) bind-mounted into the container at `/data` with `-v $(pwd)/watched-dir:/data:Z`. A second read-only mount exposed the test scripts at `/scripts`.

Inside the container, `scripts/watcher.ts` ran `fs.watch("/data", { recursive: false }, cb)` and logged every event (with ISO timestamp) both to stdout and to `/data/fswatch-log.txt` (on the bind mount itself, so the log survives container exit and is readable from the host). It also wrote a file into `/data` from inside the container 500ms after starting, to check reverse (container→host) visibility.

A driver script (`run-spike.sh`) started the container in the background, waited 1.5s for the watcher to initialize, then from the HOST performed, each spaced ~300ms apart:
1. create `newfile.txt`
2. append to `file1.txt` (modify)
3. rename `file2.txt` → `file2-renamed.txt`
4. delete `newfile.txt`

then waited ~3s, waited for the container to exit (self-terminates after an 8s duration), and dumped both `podman logs` and the on-disk log file.

A second pass reset the directory and ran `scripts/poll-watcher.ts` (stat every file every 500ms, diff against last-seen mtimes) against the identical host-op sequence, to confirm the mtime-polling fallback also works, independent of the fs.watch result.

For comparison, the fs.watch pass was additionally repeated against native Docker Engine 29.6.1 (also running directly on this Linux kernel, no Docker Desktop/VM) using the same driver script.

## Results
- fs.watch: file created on host, detected in container: yes (`EVENT type=rename filename=newfile.txt`, Node/Bun reports file-appear as `rename`)
- fs.watch: file modified on host, detected in container: yes (`EVENT type=change filename=file1.txt`)
- fs.watch: file renamed on host, detected in container: yes (`EVENT type=rename filename=file2.txt` — only the old name is reported, which is standard Node `fs.watch` behavior on Linux, not container-specific)
- fs.watch: file deleted on host, detected in container: yes (`EVENT type=rename filename=newfile.txt` on delete — again Node/Bun report deletes as `rename`, a known fs.watch quirk unrelated to containers)
- Container-to-host write visibility (reverse direction): observed — file written from inside the container (`container-wrote-this.txt`) appeared on the host bind mount essentially immediately (confirmed within the same event loop tick the driver checked, well under 1s)
- mtime-polling fallback: detected all host-side changes: yes — create, modify, rename (surfaced as delete-old + create-new, expected for pure mtime/dirent diffing), and delete were all logged within one 500ms poll interval of the host operation

All four host-side operations were detected by fs.watch in every run, including a repeat run and an equivalent run under Docker Engine (see Notes) — results were consistent, not a one-off.

## Verdict
PASS (fs.watch works reliably on this host+runtime combo)

## Notes
- Podman 5.8.2, rootless, storage driver `overlay`, kernel `7.0.13-400.asahi.fc43.aarch64+16k` (Fedora Linux Asahi Remix 43). Docker Engine 29.6.1 (community, native install, not Docker Desktop) showed identical behavior on the same kernel.
- The key reason fs.watch is expected to work here, contrary to the "notoriously unreliable" framing: that framing mostly applies to Docker Desktop on macOS/Windows, where the container runs inside a Linux VM and the bind mount is proxied through a non-native filesystem bridge (osxfs/gRPC-FUSE/virtiofs/9p over WSL2), which does not forward host inotify events into the VM's inotify subsystem. On native Linux — which is what both Podman and Docker Engine are here, with no VM indirection — the container shares the host kernel directly, and a bind mount is a plain additional mountpoint of the same underlying filesystem/inode, so host-side inotify events propagate into the container's inotify watches normally. This machine (Fedora Asahi, bare-metal Linux) is exactly that "no VM" case, which is why the result differs from the commonly-cited failure mode.
- Bun's `fs.watch` behaves like Node's here: renames/deletes both surface as `eventType: "rename"`, and only the pre-rename filename is reported (no explicit new-name event) — a Node-API quirk to account for in the coordinator's logic, not a reliability problem.
- The bind mount also emitted self-referential `change` events for `fswatch-log.txt` itself (since the watcher's own log writes land inside the same watched directory) — a reminder to keep any watcher's own state/log files outside the directory it's watching in the real implementation, to avoid feedback-loop noise.
- Given the PASS result, the mtime-polling fallback is not strictly required for this machine, but it was verified working (with 500ms poll interval) as a safety net / for portability to environments (e.g. Docker Desktop, CI runners in VMs) where fs.watch may not propagate reliably.
- Full raw logs from the actual run are preserved in `run-output.log` in this directory.
