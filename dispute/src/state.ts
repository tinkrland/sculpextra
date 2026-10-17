import type { ClaimState, ItemOutcome, ItemOverlay } from "./types";

// the claim-level state machine (§15). illegal transitions throw,
// same discipline as ticketing. counsel escalation pauses the
// decision clock; the pause interval is an event pair so
// time-to-decision subtracts exactly.

export class IllegalTransitionError extends Error {
  public constructor(from: string, to: string) {
    super(`illegal claim transition: ${from} -> ${to}`);
  }
}

const LEGAL: Readonly<Record<ClaimState, readonly ClaimState[]>> = Object.freeze({
  new: ["bounced", "under_review"],
  bounced: [], // terminal; resubmission creates a new linked claim
  under_review: ["provisional_action_logged", "closed_referred", "withdrawn", "decided"],
  provisional_action_logged: ["decided", "closed_referred", "withdrawn"],
  decided: ["rejected_restored", "upheld_delisted", "escalated_counsel"],
  rejected_restored: ["closed"],
  upheld_delisted: ["closed"],
  escalated_counsel: ["decided", "closed"], // counsel_return -> decided
  closed_referred: ["closed"], // a reclassification is terminal on merits
  withdrawn: ["closed"],
  reopened: ["under_review"], // reopen: closed -> reopened -> under_review
  closed: ["reopened"],
});

export function assertClaimTransition(from: ClaimState, to: ClaimState): void {
  if (!LEGAL[from].includes(to)) {
    throw new IllegalTransitionError(from, to);
  }
}

// item outcomes: pending is the only open state; terminal outcomes
// never change (a re-tagged or re-decided item goes through reopen)
export const TERMINAL_OUTCOMES: ReadonlySet<ItemOutcome> = new Set([
  "rejected",
  "upheld",
  "escalated",
  "withdrawn",
  "referred",
]);

// the dmca counter-notice overlay (§9): an upheld+delisted item
// may receive a counter notice, a restore window, and then either
// restore-after-window or a claimant refile moving it to counsel.
export const OVERLAY_FLOW: Readonly<Record<ItemOverlay, readonly ItemOverlay[]>> = Object.freeze({
  none: ["upheld_pending_counter"],
  upheld_pending_counter: ["counter_notice_filed"],
  counter_notice_filed: ["restore_window"],
  restore_window: ["restored_after_counter_notice", "refiled"],
  restored_after_counter_notice: [],
  refiled: [],
});

export function assertOverlayTransition(from: ItemOverlay, to: ItemOverlay): void {
  if (!OVERLAY_FLOW[from].includes(to)) {
    throw new IllegalTransitionError(`overlay:${from}`, `overlay:${to}`);
  }
}

export function daysBetween(from: string, to: string): number {
  return (Date.parse(to) - Date.parse(from)) / 86_400_000;
}
