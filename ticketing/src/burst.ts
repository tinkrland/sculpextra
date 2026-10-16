import type { QueueId } from "./types";
import type { BurstConfig, CoreConfig, SpikeWindow } from "./config";

// phase 5: burst mode. spike windows are config-owned (spec: e.g.
// the 15th for creator queues, drop windows for buyer queues);
// burst widens capacity only - the multiplier applies to
// concurrency caps, never to priority rules. all window math is
// utc; "HH:MM" ranges may wrap midnight (start > end), and
// weekdays_utc (0 = sunday) / days_of_month narrow the match.

export class BurstWindowError extends Error {}

function parseHourMinute(v: string, what: string): number {
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(v);
  if (!m) throw new BurstWindowError(`invalid ${what} "${v}": expected HH:MM`);
  return Number(m[1]) * 60 + Number(m[2]);
}

export function inSpikeWindow(w: SpikeWindow, ts: string): boolean {
  const t = new Date(ts);
  if (Number.isNaN(t.getTime())) throw new BurstWindowError(`invalid timestamp "${ts}"`);
  const start = parseHourMinute(w.start_utc, "start_utc");
  const end = parseHourMinute(w.end_utc, "end_utc");
  const minutesUtc = t.getUTCHours() * 60 + t.getUTCMinutes();
  const matchesTime =
    start <= end
      ? minutesUtc >= start && minutesUtc < end
      : minutesUtc >= start || minutesUtc < end; // wraps midnight
  if (!matchesTime) return false;
  if (w.weekdays_utc && !w.weekdays_utc.includes(t.getUTCDay())) return false;
  if (w.days_of_month && !w.days_of_month.includes(t.getUTCDate())) return false;
  return true;
}

export function burstActive(
  config: CoreConfig,
  queue: QueueId,
  ts: string,
): boolean {
  const b = config.burst[queue];
  if (!b || b.multiplier <= 1 || b.windows.length === 0) return false;
  return b.windows.some((w) => inSpikeWindow(w, ts));
}

// the effective cap: base when no window is live, base x multiplier
// (floored) during a spike. widens only: never below the base cap,
// even for a misconfigured multiplier below 1.
export function effectiveCap(
  baseCap: number,
  config: CoreConfig,
  queue: QueueId,
  ts: string,
): number {
  if (!burstActive(config, queue, ts)) return baseCap;
  return Math.max(baseCap, Math.floor(baseCap * config.burst[queue].multiplier));
}
