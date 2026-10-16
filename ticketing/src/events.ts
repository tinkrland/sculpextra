// append-only event logs. every state change, note, deflection,
// response, and assignment is an event; there is no update and no
// delete, and events are deep-frozen so nobody can rewrite history.

export type Actor =
  | { kind: "system" }
  | { kind: "agent"; id: string }
  | { kind: "account"; ref: string };

export type CaseEventType =
  | "case_created"
  | "gate_verdict"
  | "intent_tagged"
  | "rate_limited"
  | "ticketed"
  | "merged"
  // phase 2, deflection pipeline:
  | "lookup_result"
  | "deflection_offered"
  | "deflection_accepted"
  | "human_requested";

export type TicketEventType =
  | "ticket_created"
  | "queue_assigned"
  | "agent_assigned"
  | "state_changed"
  | "note_added"
  | "response_sent"
  | "merged_contact"
  | "escalated"
  | "reopened"
  | "closed"
  // phase 4, proposal bridge + abuse signal:
  | "proposal_created"
  | "proposal_result"
  | "abuse_report_filed";

export interface CaseEvent {
  case_ref: string;
  seq: number; // per-case monotonic
  type: CaseEventType;
  actor: Actor;
  payload: unknown; // json, type-specific
  created_at: string;
}

export interface TicketEvent {
  ticket_ref: string;
  seq: number; // per-ticket monotonic
  type: TicketEventType;
  actor: Actor;
  payload: unknown;
  created_at: string;
}

export function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const key of Object.keys(value as Record<string, unknown>)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}

// one log instance per entity family. seq is assigned inside append:
// callers cannot choose it, so ordering cannot be forged after the
// fact. append returns the frozen event.
export class EventLog<E extends { seq: number }> {
  private readonly byRef = new Map<string, E[]>();

  public append(ref: string, make: (seq: number) => E): E {
    const existing = this.byRef.get(ref) ?? [];
    const seq = existing.length === 0 ? 1 : existing[existing.length - 1].seq + 1;
    const event = deepFreeze(make(seq));
    existing.push(event);
    this.byRef.set(ref, existing);
    return event;
  }

  // a frozen copy; mutating the result never touches the log
  public list(ref: string): readonly E[] {
    return Object.freeze([...(this.byRef.get(ref) ?? [])]);
  }

  public count(ref?: string): number {
    if (ref === undefined) {
      let total = 0;
      for (const rows of this.byRef.values()) total += rows.length;
      return total;
    }
    return (this.byRef.get(ref) ?? []).length;
  }
}
