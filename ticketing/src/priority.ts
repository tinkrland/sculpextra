// priority is age-based only. order value, trust, spend history, fraud
// and vpn flags are context, never ranking inputs (spec: routing). the
// score is minutes since the ticket opened; phase 3 may add a
// configurable curve, but it stays a function of age alone.

export function priorityScore(openedAt: string, now: string): number {
  const opened = Date.parse(openedAt);
  const current = Date.parse(now);
  if (Number.isNaN(opened) || Number.isNaN(current)) {
    throw new Error("priorityScore needs two iso 8601 timestamps");
  }
  return Math.max(0, (current - opened) / 60_000);
}
