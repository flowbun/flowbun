/**
 * `crypto.randomUUID()` only exists in secure contexts (HTTPS or
 * `localhost`) — browsers omit it entirely on a plain-HTTP LAN address,
 * which is exactly how this editor is meant to be reachable (see
 * server.ts's per-request coordinator-address derivation). These IDs are
 * just client-generated request/response correlation tokens, not a
 * security boundary, so any sufficiently random unique string works.
 * `crypto.getRandomValues()` has no such secure-context restriction.
 */
export function generateRequestId(): string {
  if (typeof crypto?.randomUUID === "function") {
    return crypto.randomUUID();
  }
  if (typeof crypto?.getRandomValues === "function") {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    // Iteration callback params are plain `number` (unlike indexed access
    // under noUncheckedIndexedAccess), so this sets the UUID version/variant
    // bits without any indexed read/write.
    const hex = Array.from(bytes, (b, i) => {
      const v = i === 6 ? (b & 0x0f) | 0x40 : i === 8 ? (b & 0x3f) | 0x80 : b;
      return v.toString(16).padStart(2, "0");
    }).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}
