import type { Milliseconds } from "../fleet/brand.ts";

/** 0.4s, 12s, 2m03s, 1h04m: never more precise than it is worth reading. */
export const duration = (ms: Milliseconds) => {
  const seconds = Math.max(0, ms) / 1000;
  if (seconds < 10) return `${(Math.floor(seconds * 10) / 10).toFixed(1)}s`;
  if (seconds < 60) return `${String(Math.floor(seconds))}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${String(minutes)}m${String(Math.floor(seconds % 60)).padStart(2, "0")}s`;
  return `${String(Math.floor(minutes / 60))}h${String(minutes % 60).padStart(2, "0")}m`;
};
