import type {
  FlowPackageSummary,
  InstalledFlowPackage,
  NpmPackageEntry,
} from "flowbun/ws";
import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { generateRequestId } from "../../lib/requestId";
import { useFlowbunSocket } from "../../ws/FlowbunSocketContext";
import { ConfirmDialog } from "./ConfirmDialog";

type Tab = "flowbun" | "npm";

/**
 * Opened from SystemStatsModal's "Manage packages…" button. Two tabs:
 * "Flowbun packages" (browse/install/update/uninstall registry packages of
 * blocks + example wiring — see coordinator's flow-packages.ts) and "npm
 * packages" (data/'s own npm dependencies — see npm-packages.ts).
 *
 * The registry is only fetched when the user clicks Refresh (per the
 * original design: no network traffic just from opening the modal); the
 * installed lists load immediately since both are local-only reads.
 */
export function PackagesModal({ onClose }: { onClose: () => void }) {
  const { send } = useFlowbunSocket();
  const [tab, setTab] = useState<Tab>("flowbun");

  // Shared across both tabs: one operation at a time, one output/error
  // surface — mirrors how every mutation in this app reports (raw text,
  // shown verbatim).
  const [busy, setBusy] = useState(false);
  const [output, setOutput] = useState<string | null>(null);
  const [opError, setOpError] = useState<string | null>(null);

  // --- flowbun tab state ---
  const [installed, setInstalled] = useState<InstalledFlowPackage[] | null>(
    null,
  );
  const [available, setAvailable] = useState<FlowPackageSummary[] | null>(null);
  const [registrySource, setRegistrySource] = useState<string | null>(null);
  const [registryError, setRegistryError] = useState<string | null>(null);
  const [installTarget, setInstallTarget] = useState<FlowPackageSummary | null>(
    null,
  );
  const [uninstallTarget, setUninstallTarget] = useState<string | null>(null);
  const [forceUpdateTarget, setForceUpdateTarget] = useState<{
    name: string;
    files: string[];
  } | null>(null);

  // --- npm tab state ---
  const [npmPackages, setNpmPackages] = useState<NpmPackageEntry[] | null>(
    null,
  );
  const [npmListError, setNpmListError] = useState<string | null>(null);
  const [spec, setSpec] = useState("");
  const [npmRemoveTarget, setNpmRemoveTarget] = useState<string | null>(null);

  const refreshInstalled = useCallback(async () => {
    const r = await send({
      type: "pkg.flow.list",
      requestId: generateRequestId(),
    });
    if (r.type !== "pkg.flow.listResult") return;
    if (r.ok) setInstalled(r.packages);
  }, [send]);

  const refreshNpm = useCallback(async () => {
    const r = await send({
      type: "pkg.npm.list",
      requestId: generateRequestId(),
    });
    if (r.type !== "pkg.npm.listResult") {
      setNpmListError("unexpected response from server");
      return;
    }
    if (r.ok) {
      setNpmPackages(r.packages);
      setNpmListError(null);
    } else {
      setNpmListError(r.error);
    }
  }, [send]);

  useEffect(() => {
    refreshInstalled();
    refreshNpm();
  }, [refreshInstalled, refreshNpm]);

  async function refreshRegistry() {
    setBusy(true);
    setRegistryError(null);
    try {
      const r = await send({
        type: "pkg.flow.registry",
        requestId: generateRequestId(),
      });
      if (r.type !== "pkg.flow.registryResult") {
        setRegistryError("unexpected response from server");
        return;
      }
      if (r.ok) {
        setAvailable(r.packages);
        setRegistrySource(r.source);
      } else {
        setRegistryError(r.error);
      }
    } finally {
      setBusy(false);
    }
  }

  /** Re-syncs whatever local/remote views an operation just invalidated. */
  async function refreshAfterFlowOp() {
    await refreshInstalled();
    await refreshNpm(); // installs can add npm deps
    if (available !== null) await refreshRegistry(); // update installedVersion badges
  }

  async function handleInstall(
    name: string,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    setBusy(true);
    setOutput(null);
    setOpError(null);
    try {
      const r = await send({
        type: "pkg.flow.install",
        requestId: generateRequestId(),
        name,
      });
      if (r.type !== "pkg.flow.installResult") {
        return { ok: false, error: "unexpected response from server" };
      }
      if (!r.ok) return { ok: false, error: r.error };
      setOutput(
        r.typecheck.ok
          ? r.output
          : `${r.output}\n\ntypecheck FAILED:\n${r.typecheck.output}`,
      );
      await refreshAfterFlowOp();
      return { ok: true };
    } finally {
      setBusy(false);
    }
  }

  async function handleUninstall(
    name: string,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    setBusy(true);
    setOutput(null);
    setOpError(null);
    try {
      const r = await send({
        type: "pkg.flow.uninstall",
        requestId: generateRequestId(),
        name,
      });
      if (r.type !== "pkg.flow.uninstallResult") {
        return { ok: false, error: "unexpected response from server" };
      }
      if (!r.ok) return { ok: false, error: r.error };
      setOutput(
        r.modifiedFiles.length > 0
          ? `${r.output}\nLocally modified files were removed (recoverable from history): ${r.modifiedFiles.join(", ")}`
          : r.output,
      );
      await refreshAfterFlowOp();
      return { ok: true };
    } finally {
      setBusy(false);
    }
  }

  async function handleUpdate(name: string, force: boolean) {
    setBusy(true);
    setOutput(null);
    setOpError(null);
    try {
      const r = await send({
        type: "pkg.flow.update",
        requestId: generateRequestId(),
        name,
        force,
      });
      if (r.type !== "pkg.flow.updateResult") {
        setOpError("unexpected response from server");
        return;
      }
      if (!r.ok) {
        // Locally modified files: escalate to an explicit force-confirm
        // instead of surfacing a dead-end error.
        if (r.modifiedFiles && r.modifiedFiles.length > 0) {
          setForceUpdateTarget({ name, files: r.modifiedFiles });
        } else {
          setOpError(r.error);
        }
        return;
      }
      setOutput(
        r.typecheck.ok
          ? r.output
          : `${r.output}\n\ntypecheck FAILED:\n${r.typecheck.output}`,
      );
      await refreshAfterFlowOp();
    } finally {
      setBusy(false);
    }
  }

  async function handleNpmAdd() {
    const trimmed = spec.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    setOutput(null);
    setOpError(null);
    try {
      const r = await send({
        type: "pkg.npm.add",
        requestId: generateRequestId(),
        spec: trimmed,
      });
      if (r.type !== "pkg.npm.addResult") {
        setOpError("unexpected response from server");
        return;
      }
      if (r.ok) {
        setOutput(r.output);
        setSpec("");
        await refreshNpm();
      } else {
        setOpError(r.error);
      }
    } finally {
      setBusy(false);
    }
  }

  async function handleNpmRemove(
    name: string,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    setBusy(true);
    setOutput(null);
    setOpError(null);
    try {
      const r = await send({
        type: "pkg.npm.remove",
        requestId: generateRequestId(),
        name,
      });
      if (r.type !== "pkg.npm.removeResult") {
        return { ok: false, error: "unexpected response from server" };
      }
      if (r.ok) {
        setOutput(r.output);
        await refreshNpm();
        return { ok: true };
      }
      return { ok: false, error: r.error };
    } finally {
      setBusy(false);
    }
  }

  const installedByName = new Map((installed ?? []).map((p) => [p.name, p]));

  function renderFlowbunTab() {
    return (
      <>
        <div className="packages-modal-registry-bar">
          <button
            type="button"
            className="packages-modal-action"
            onClick={refreshRegistry}
            disabled={busy}
          >
            {available === null ? "Load registry" : "Refresh"}
          </button>
          {registrySource && (
            <span className="detail-label packages-modal-source">
              {registrySource}
            </span>
          )}
        </div>
        {registryError && (
          <div className="create-dialog-error">{registryError}</div>
        )}
        {opError && <div className="create-dialog-error">{opError}</div>}

        <h4 className="detail-section-title">Installed</h4>
        <div className="packages-modal-list">
          {installed === null && <div className="detail-label">Loading…</div>}
          {installed?.length === 0 && (
            <div className="detail-label">No flowbun packages installed.</div>
          )}
          {installed?.map((pkg) => {
            const latest = available?.find((a) => a.name === pkg.name)
              ?.versions[0];
            const updateAvailable =
              latest !== undefined && latest.version !== pkg.version;
            return (
              <div className="packages-modal-row" key={pkg.name}>
                <div className="packages-modal-row-info">
                  <code>{pkg.name}</code>
                  <span className="detail-label">
                    {pkg.version}
                    {updateAvailable ? ` → ${latest.version} available` : ""}
                  </span>
                </div>
                <div className="packages-modal-row-actions">
                  {updateAvailable && (
                    <button
                      type="button"
                      className="packages-modal-action"
                      onClick={() => handleUpdate(pkg.name, false)}
                      disabled={busy}
                    >
                      Update
                    </button>
                  )}
                  <button
                    type="button"
                    className="packages-modal-remove"
                    onClick={() => setUninstallTarget(pkg.name)}
                    disabled={busy}
                  >
                    Uninstall
                  </button>
                </div>
              </div>
            );
          })}
        </div>

        <h4 className="detail-section-title">Available</h4>
        <div className="packages-modal-list">
          {available === null && (
            <div className="detail-label">
              Click "Load registry" to browse available packages.
            </div>
          )}
          {available
            ?.filter((p) => !installedByName.has(p.name))
            .map((pkg) => {
              const latest = pkg.versions[0];
              if (!latest) return null;
              return (
                <div className="packages-modal-row" key={pkg.name}>
                  <div className="packages-modal-row-info">
                    <code>
                      {pkg.name}{" "}
                      <span className="detail-label">{latest.version}</span>
                    </code>
                    <span className="detail-label packages-modal-desc">
                      {latest.description}
                    </span>
                    <span className="detail-label">
                      {
                        latest.blocks.filter((b) => !b.includes("__tests__"))
                          .length
                      }{" "}
                      block(s), {latest.wiring.length} example flow(s)
                      {Object.keys(latest.npmDependencies).length > 0
                        ? `, npm: ${Object.keys(latest.npmDependencies).join(", ")}`
                        : ""}
                    </span>
                  </div>
                  <button
                    type="button"
                    className="packages-modal-action"
                    onClick={() => setInstallTarget(pkg)}
                    disabled={busy || !latest.compatible}
                    title={
                      latest.compatible
                        ? undefined
                        : `requires flowbun ${latest.flowbun}`
                    }
                  >
                    {latest.compatible ? "Install" : "Incompatible"}
                  </button>
                </div>
              );
            })}
          {available !== null &&
            available.filter((p) => !installedByName.has(p.name)).length ===
              0 && (
              <div className="detail-label">
                Everything in the registry is already installed.
              </div>
            )}
        </div>
      </>
    );
  }

  function renderNpmTab() {
    return (
      <>
        <p className="detail-label">
          Installed into data/'s own package.json — persists across restarts,
          importable from any block.
        </p>

        <div className="packages-modal-add">
          <input
            type="text"
            value={spec}
            onChange={(e) => {
              setSpec(e.target.value);
              setOpError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleNpmAdd();
            }}
            placeholder="e.g. nanoid or nanoid@5"
            disabled={busy}
          />
          <button
            type="button"
            className="create-dialog-submit"
            onClick={handleNpmAdd}
            disabled={!spec.trim() || busy}
          >
            {busy ? "Working…" : "Add"}
          </button>
        </div>

        {npmListError && (
          <div className="create-dialog-error">{npmListError}</div>
        )}
        {opError && <div className="create-dialog-error">{opError}</div>}

        <div className="packages-modal-list">
          {npmPackages === null && !npmListError && (
            <div className="detail-label">Loading…</div>
          )}
          {npmPackages?.length === 0 && (
            <div className="detail-label">No packages installed yet.</div>
          )}
          {npmPackages?.map((pkg) => (
            <div className="packages-modal-row" key={pkg.name}>
              <div className="packages-modal-row-info">
                <code>{pkg.name}</code>
                <span className="detail-label">
                  {pkg.requestedRange}
                  {pkg.resolvedVersion
                    ? ` → ${pkg.resolvedVersion}`
                    : " (not installed)"}
                </span>
              </div>
              <button
                type="button"
                className="packages-modal-remove"
                onClick={() => setNpmRemoveTarget(pkg.name)}
                disabled={busy}
              >
                Remove
              </button>
            </div>
          ))}
        </div>
      </>
    );
  }

  return (
    <>
      {createPortal(
        <div
          className="create-dialog-overlay"
          onClick={(e) => {
            if (e.target === e.currentTarget) onClose();
          }}
          onKeyDown={(e) => e.key === "Escape" && onClose()}
          role="dialog"
          aria-modal="true"
          aria-label="Manage packages"
        >
          <div className="create-dialog-panel packages-modal-panel">
            <h3>Packages</h3>
            <div className="packages-modal-tabs">
              <button
                type="button"
                className={`packages-modal-tab ${tab === "flowbun" ? "active" : ""}`}
                onClick={() => setTab("flowbun")}
              >
                Flowbun packages
              </button>
              <button
                type="button"
                className={`packages-modal-tab ${tab === "npm" ? "active" : ""}`}
                onClick={() => setTab("npm")}
              >
                npm packages
              </button>
            </div>

            {tab === "flowbun" ? renderFlowbunTab() : renderNpmTab()}

            {output && (
              <pre className="flow-detail-typecheck-output">{output}</pre>
            )}

            <div className="create-dialog-actions">
              <button type="button" onClick={onClose}>
                Close
              </button>
            </div>
          </div>
        </div>,
        document.body,
      )}
      {installTarget && (
        <ConfirmDialog
          title={`Install ${installTarget.name}?`}
          message={
            <>
              {installTarget.versions[0]?.description}
              <br />
              <br />
              Installing a flowbun package means running third-party code with
              access to your Home Assistant. Example flows are installed
              disabled — review and enable them yourself.
            </>
          }
          confirmLabel="Install"
          onConfirm={() => handleInstall(installTarget.name)}
          onClose={() => setInstallTarget(null)}
        />
      )}
      {uninstallTarget && (
        <ConfirmDialog
          title={`Uninstall ${uninstallTarget}?`}
          message={
            <>
              Removes every block and example flow{" "}
              <code>{uninstallTarget}</code> installed. Blocks still used by
              your own flows will stop the uninstall with an error naming them.
              Files remain recoverable from history.
            </>
          }
          confirmLabel="Uninstall"
          onConfirm={() => handleUninstall(uninstallTarget)}
          onClose={() => setUninstallTarget(null)}
        />
      )}
      {forceUpdateTarget && (
        <ConfirmDialog
          title={`Overwrite local changes to ${forceUpdateTarget.name}?`}
          message={
            <>
              These files have been modified since install and will be
              overwritten by the update (recoverable from history):
              <br />
              <code>{forceUpdateTarget.files.join(", ")}</code>
            </>
          }
          confirmLabel="Overwrite & update"
          onConfirm={async () => {
            await handleUpdate(forceUpdateTarget.name, true);
            return { ok: true };
          }}
          onClose={() => setForceUpdateTarget(null)}
        />
      )}
      {npmRemoveTarget && (
        <ConfirmDialog
          title={`Remove ${npmRemoveTarget}?`}
          message={
            <>
              Uninstalls <code>{npmRemoveTarget}</code> from data/'s npm
              dependencies. Any block still importing it will fail typecheck
              until you re-add it or remove the import.
            </>
          }
          confirmLabel="Remove"
          onConfirm={() => handleNpmRemove(npmRemoveTarget)}
          onClose={() => setNpmRemoveTarget(null)}
        />
      )}
    </>
  );
}
