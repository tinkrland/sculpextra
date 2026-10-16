// vocabulary fixed by specs/build-spec.md: bin = buyer id, cin = creator
// id, sin = shop id. markets and territories are always iso 3166-1
// alpha-2 in internal data. none of this core is user-facing, so no
// user-facing strings live here.

export type AccountFamily = "buyer" | "creator";
export type QueueId = "buyer" | "buyer_to_be" | "creator_support" | "creator_question";
export type SourceChannel = "web_form" | "in_app" | "email";

export type CaseState = "open" | "ticketed" | "deflected" | "rate_limited" | "merged";
export type TicketState = "new" | "triaged" | "in_progress" | "waiting_on_user" | "resolved" | "closed";

// gate verdicts are context from the tell adapters. only the email
// eligibility gate blocks intake (themailtell); phone line-type state
// (thephonetell) and address-shape verdicts (thelocaletell, where the
// po-box ban lives) attach as case context, never as blockers here.
export type GateName = "themailtell" | "thephonetell" | "thelocaletell";
export interface GateVerdict {
  gate: GateName;
  verdict: "pass" | "fail" | "info";
  detail?: string;
}

export interface OrderSegmentSnapshot {
  segment_id: string;
  shop_sin: string;
  item_count: number;
  value: number;
  escrow_state: string; // frozen at ticket creation, e.g. "held"
}

export interface PayoutSnapshot {
  next_payout_date: string; // iso date; creators get paid on the 15th
  pending_amount: number;
}

export interface Case {
  id: string;
  account_family: AccountFamily;
  account_ref: string; // bin or cin. one or the other, never both
  market: string; // iso 3166-1 alpha-2
  language: string; // bcp-47
  source_channel: SourceChannel;
  subject: string;
  body: string;
  intent_tag_raw: string;
  intent_tag: string; // fixed taxonomy, see taxonomy.ts
  state: CaseState;
  merged_into_ticket: string | null;
  created_at: string; // iso 8601 utc
}

export interface AssignmentInputs {
  account_family: AccountFamily;
  order_attached: boolean;
  payout_context_present: boolean;
  intent_tag: string;
}

export interface AssignmentDecision {
  queue: QueueId;
  rule: string; // which branch fired, for audit
  inputs: Readonly<AssignmentInputs>;
}

export interface Ticket {
  id: string;
  case_ref: string;
  queue: QueueId;
  state: TicketState;
  order_refs: readonly string[]; // 0..n: multi-store checkout spans n orders
  order_segments: readonly OrderSegmentSnapshot[]; // escrow state frozen per segment
  payout_snapshot: PayoutSnapshot | null; // creator_support only
  deflection_summary: string | null; // phase 2
  assigned_agent: string | null;
  rate_limited_chip: boolean; // context chip for triage, never priority
  reopened_from: string | null; // ancestor ticket when this is a reopen
  created_at: string;
  closed_at: string | null;
}
