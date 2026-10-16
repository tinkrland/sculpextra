// priority is age-based only. order value, trust, spend history, fraud
// and vpn flags are context, never ranking inputs (spec: routing). the
// score is a function of minutes open, shaped by a configurable curve:
// each curve segment scores the age window [after_minutes, next
// segment) at per_minute. the default curve is the identity (one point
// per minute). no input besides age exists, by construction.

export interface PriorityCurveSegment {
  after_minutes: number;
  per_minute: number;
}

export const DEFAULT_PRIORITY_CURVE: readonly PriorityCurveSegment[] = [
  { after_minutes: 0, per_minute: 1 },
];

export function priorityScore(
  openedAt: string,
  now: string,
  curve: readonly PriorityCurveSegment[] = DEFAULT_PRIORITY_CURVE,
): number {
  const opened = Date.parse(openedAt);
  const current = Date.parse(now);
  if (Number.isNaN(opened) || Number.isNaN(current)) {
    throw new Error("priorityScore needs two iso 8601 timestamps");
  }
  const minutes = Math.max(0, (current - opened) / 60_000);
  if (curve.length === 0) {
    throw new Error("priority curve needs at least one segment");
  }
  const segments = [...curve].sort((a, b) => a.after_minutes - b.after_minutes);
  if (segments[0].after_minutes > 0) {
    throw new Error("priority curve must cover age 0");
  }
  let score = 0;
  for (let i = 0; i < segments.length; i++) {
    const from = segments[i].after_minutes;
    const to = i + 1 < segments.length ? segments[i + 1].after_minutes : minutes;
    if (minutes <= from) break;
    score += (Math.min(minutes, to) - from) * segments[i].per_minute;
  }
  return score;
}
