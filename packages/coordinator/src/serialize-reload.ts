/**
 * A total-order execution queue: each call to the returned function waits
 * for every prior call's function to settle (success or failure) before
 * running its own — regardless of how long any of them take — and its
 * returned promise resolves/rejects according to its own function's
 * outcome, not any earlier one's.
 *
 * See main.ts's own comment on why reload operations need this:
 * reloadBlocksAndRestartAll() reassigns the coordinator's shared block
 * registry, and both reloadWiringFileInner() and createFlow() read it via
 * assembleFlow() — without a total order between them, a wiring reload
 * triggered moments after a new block file's own reload could run BEFORE
 * that reload finished registering it, and throw "references unknown
 * block" even though both files were already correctly saved on disk.
 * Found by actually hitting it, not by inspection.
 */
export function createReloadSerializer(): <T>(
  fn: () => Promise<T>,
) => Promise<T> {
  let chain: Promise<unknown> = Promise.resolve();
  return function serializeReload<T>(fn: () => Promise<T>): Promise<T> {
    const run = chain.then(fn, fn);
    chain = run;
    return run;
  };
}
