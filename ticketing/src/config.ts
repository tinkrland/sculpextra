import type { QueueId } from "./types";
import { deepFreeze } from "./events";

// the config surface. every knob the spec names as configurable lives
// here; changing behavior is a config change, not a code change.
// burst multipliers and spike windows land in phase 5 and will extend
// this object, not replace it.

export interface CoreConfig {
  // per-account ticket rate limits per queue per day
  rate_limits: Record<QueueId, number>;
  // duplicate merge window: same account + same intent tag within
  // this window merges into the open ticket
  merge_window_hours: number;
  // reopen window: close within this window reopens as a linked
  // ticket; beyond it, a fresh contact
  reopen_window_days: number;
  // first human response targets, minutes, for measurement
  first_response_minutes: Record<QueueId, number>;
}

export const DEFAULT_CONFIG: Readonly<CoreConfig> = deepFreeze({
  rate_limits: {
    buyer: 5,
    buyer_to_be: 5,
    creator_support: 4,
    creator_question: 4,
  },
  merge_window_hours: 48,
  reopen_window_days: 14,
  first_response_minutes: {
    buyer: 240,
    buyer_to_be: 120,
    creator_support: 480,
    creator_question: 480,
  },
});
