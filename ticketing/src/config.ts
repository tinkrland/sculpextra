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
  // phase 2: deflection pipeline. enabled=false (or a null port) is
  // straight-to-ticket mode, used until deflection content exists.
  deflection: {
    enabled: boolean;
    // answers requested from retelldb per lookup
    top_k: number;
  };
  // phase 3: default per-agent concurrency cap per queue, used when
  // an agent profile does not carry its own cap
  agent_concurrency: Record<QueueId, number>;
  // phase 3: the priority curve over minutes open. age only: each
  // segment scores age_minutes..next segment at per_minute. the
  // default is the identity curve (one point per minute).
  priority_curve: readonly { after_minutes: number; per_minute: number }[];
  // phase 3: hosts that count as doc/kb/academy content links for the
  // response library. a canned answer must reference at least one.
  content_link_hosts: readonly string[];
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
  deflection: {
    enabled: true,
    top_k: 5,
  },
  agent_concurrency: {
    buyer: 3,
    buyer_to_be: 3,
    creator_support: 2,
    creator_question: 4,
  },
  priority_curve: [{ after_minutes: 0, per_minute: 1 }],
  content_link_hosts: ["docs.sculptura.com", "kb.sculptura.com", "academy.sculptura.com"],
});
