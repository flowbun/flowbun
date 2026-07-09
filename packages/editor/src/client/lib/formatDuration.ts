/** "2d 4h 12m" style — drops leading zero units (a 40-minute uptime reads
 * "40m", not "0d 0h 40m"), and only shows seconds once nothing coarser than
 * minutes applies (a "3d 2h 15m 09s" reading is more noise than signal). */
export function formatDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const days = Math.floor(s / 86400);
  const hours = Math.floor((s % 86400) / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  const seconds = s % 60;

  const parts: string[] = [];
  if (days) parts.push(`${days}d`);
  if (days || hours) parts.push(`${hours}h`);
  if (days || hours || minutes) parts.push(`${minutes}m`);
  if (!days && !hours && !minutes) parts.push(`${seconds}s`);
  return parts.join(" ");
}
