/** 0.4s, 12s, 2m03s, 1h04m: as the terminal shows times. */
export const duration = (ms: number): string => {
  const seconds = Math.max(0, ms) / 1000;
  if (seconds < 10) return `${(Math.floor(seconds * 10) / 10).toFixed(1)}s`;
  if (seconds < 60) return `${String(Math.floor(seconds))}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${String(minutes)}m${String(Math.floor(seconds % 60)).padStart(2, "0")}s`;
  return `${String(Math.floor(minutes / 60))}h${String(minutes % 60).padStart(2, "0")}m`;
};

/** How long ago, as a reader rounds it. */
export const ago = (ms: number): string => {
  const seconds = Math.floor(Math.max(0, ms) / 1000);
  if (seconds < 10) return "just now";
  if (seconds < 60) return `${String(seconds)}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${String(minutes)}m ago`;
  const hours = Math.floor(minutes / 60);
  return hours < 48 ? `${String(hours)}h ago` : `${String(Math.floor(hours / 24))}d ago`;
};

/** A run's id starts with its UTC time: 20261018T201502Z-a1b2c3. */
export const startedAt = (iso: string): number => Date.parse(iso);
