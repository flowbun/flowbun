import { useEffect, useState } from "react";

/**
 * The header's connection-dot is easy to miss, so a dropped connection also
 * gets this more visible banner — but only once the app has actually been
 * connected before. On first load "not connected yet" is just the normal
 * startup state (the dot already covers that), not something worth
 * interrupting the user over.
 */
export function ConnectionBanner({ connected }: { connected: boolean }) {
  const [everConnected, setEverConnected] = useState(false);
  const [show, setShow] = useState(false);

  useEffect(() => {
    if (connected) {
      setEverConnected(true);
      setShow(false);
      return;
    }
    if (!everConnected) return;
    // Debounced so a reconnect that resolves within one retry/heartbeat
    // cycle doesn't flash the banner on and off.
    const timer = setTimeout(() => setShow(true), 800);
    return () => clearTimeout(timer);
  }, [connected, everConnected]);

  if (!show) return null;
  return (
    <div className="connection-banner" role="status">
      Connection lost — reconnecting…
    </div>
  );
}
