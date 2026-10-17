// append-only event logs, mirroring the ticketing discipline: every
// state change is an event, there is no update and no delete, and
// events are deep-frozen so nobody can rewrite history.

export type Actor =
  | { kind: "system" }
  | { kind: "reviewer"; id: string }
  | { kind: "counsel"; id: string }
  | { kind: "claimant"; ref: string };

export type ClaimEventType =
  | "claim_submitted"
  | "claim_bounced"
  | "contact_gate_verdict"
  | "rate_limited"
  | "merged_amendment"
  | "evidence_requested"
  | "evidence_attached"
  | "reviewer_assigned"
  | "hours_logged"
  | "provisional_delisted"
  | "provisional_restored"
  | "provisional_notify_only"
  | "creator_notified"
  | "counter_notice_filed"
  | "restore_window_started"
  | "restored_after_counter_notice"
  | "claimant_refiled"
  | "decision_recorded"
  | "escalated_counsel"
  | "counsel_clock_paused"
  | "counsel_clock_resumed"
  | "enforcement_step_signed"
  | "registry_entry_added"
  | "registry_entry_removed"
  | "claim_reopened"
  | "claim_closed"
  | "claim_reclassified_question"
  | "claim_withdrawn"
  | "type_corrected"
  | "state_changed";

export type InquiryEventType =
  | "question_asked"
  | "question_deflected"
  | "question_answered"
  | "question_closed";

export interface ClaimEvent {
  claim_ref: string;
  seq: number;
  type: ClaimEventType;
  actor: Actor;
  payload: unknown;
  created_at: string;
}

export interface InquiryEvent {
  inquiry_ref: string;
  seq: number;
  type: InquiryEventType;
  actor: Actor;
  payload: unknown;
  created_at: string;
}

export interface HasSeq {
  seq: number;
}

export class EventLog<E extends HasSeq> {
  private readonly byRef = new Map<string, E[]>();

  public append(ref: string, make: (seq: number) => E): E {
    const existing = this.byRef.get(ref) ?? [];
    const seq = existing.length === 0 ? 1 : existing[existing.length - 1].seq + 1;
    const event = deepFreeze(make(seq));
    existing.push(event);
    this.byRef.set(ref, existing);
    return event;
  }

  public list(ref: string): readonly E[] {
    return Object.freeze([...(this.byRef.get(ref) ?? [])]);
  }

  public refs(): readonly string[] {
    return Object.freeze([...this.byRef.keys()]);
  }
}

export function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const k of Object.keys(value as object)) {
      deepFreeze((value as Record<string, unknown>)[k]);
    }
    Object.freeze(value);
  }
  return value;
}
