# S4: Typecheck-on-reload latency

## Question
Is a synthetic-file `tsc --noEmit --incremental` wire-assignability check fast enough (warm, ~<2s) to run on every Flowbun save-to-reload?

## Method
Generated 30 fake block modules (`blocks/block00.ts`..`block29.ts`, via `generate.ts`) split into 5 families of 6 blocks each with distinct `Inputs`/`Outputs` shapes (plain number+timestamp, string payload, nested object with metadata, numeric array, boolean flag+value) so they aren't literal copies. Generated one synthetic `wires.ts` that type-only-imports all 30 block modules and, for a 30-wire graph (linear chains within each family plus 5 extra fork/join wires, so it's not purely linear), asserts source-output → destination-input assignability via a `type AssertAssignable<Dest, Src extends Dest> = true;` helper instantiated once per wire. Verified the technique actually catches errors: broke `block08.ts`'s input type (`text: string` → `text: number`) and confirmed `tsc` reported both the block-internal error and, specifically, `wires.ts(56,49): error TS2344 ... does not satisfy the constraint` pointing at the exact broken wire; reverted and confirmed a clean run afterward (exit 0). Used a dedicated `tsconfig.check.json` (`incremental: true`, `tsBuildInfoFile: ./.tsbuildinfo`, `noEmit: true`, entry `files: ["wires.ts"]`) so blocks are pulled in via normal import resolution. TypeScript 6.0.3 (via `bun add -D typescript` inside the spike dir), Bun 1.3.13. Timed with `/usr/bin/time -v` wall-clock elapsed time around `tsc -p tsconfig.check.json --noEmit --incremental`, 3 repetitions per scenario.

## Results
- Cold tsc --noEmit --incremental: ~430ms (range across runs: 410-470ms)
- Warm (no changes): ~380ms (range: 370-390ms)
- Warm (after trivial edit to one block): ~460ms (range: 460-460ms, i.e. flat across 3 runs)
- Warm (after type-breaking wire change): ~490ms, error correctly detected: yes

## Verdict
PASS (warm check comfortably under ~2s) — all scenarios landed in the 370-490ms band, roughly 4-5x under the ~2s target, with plenty of headroom.

## Notes
- TypeScript 6.0.3, Bun 1.3.13, on an ARM64 Fedora Asahi machine (Apple Silicon under Linux). Wall-clock numbers include the full `tsc` process (Node/V8-equivalent JS engine) startup cost each time, which on this machine is a meaningful fraction of the total — cold and warm runs came out surprisingly close (430ms vs 380ms), suggesting that for a program this small, incremental `.tsbuildinfo` reuse isn't yet the dominant factor; process-startup and full-program binding/checking overhead dominate over incremental savings at this scale.
- Because startup overhead dominates at 30 blocks, this result likely does NOT extrapolate linearly to much larger flows — the *type-checking* work itself will grow with block/wire count (and especially with structurally complex or generic-heavy Inputs/Outputs), while the fixed per-invocation startup cost stays flat. So expect warm times to grow sub-linearly at first (dominated by fixed cost) then more steeply as flows get large enough that the actual checking work outweighs startup. 30 blocks with ~30 wires is a plausible "medium" flow size for early Flowbun use, but a stress test at 100-300 blocks would be the natural follow-up spike if flows are expected to grow that large.
- The trivial-edit and type-break scenarios were slightly slower (and flatter across repeats) than the untouched warm baseline, consistent with `tsc` needing to re-check the changed file's dependents even with `incremental: true`; still nowhere near the 2s budget.
- This machine may be faster or slower than target deployment hardware; treat absolute numbers as directional, not a hard SLA guarantee. The core finding — that per-reload overhead is dominated by fixed process cost rather than incremental-checking cost at this scale — is the more durable takeaway.
