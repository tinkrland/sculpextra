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

// ---- phase 2: deflection pipeline ----

// one self-serve answer from retelldb: a suggested answer plus the
// deep link it came from (doc, knowledgebase, or academy content).
// answers are ordered best-first; the deflection screen shows them
// in that order.
export interface SuggestedAnswer {
  doc_id: string;
  title: string;
  snippet: string;
  url: string;
}

// what retelldb returns for one lookup. engine_path is retelldb's
// own retrieval path (tag_traversal, vector_fallback, ...) kept for
// measurement; it never changes behavior here.
export interface RetellLookup {
  answers: readonly SuggestedAnswer[];
  engine_path: string;
  latency_ms: number;
}

// what the lookup asks for: the case text, the market and language
// (spec: intake), the account family as the audience hint, and the
// configured top_k.
export interface LookupRequest {
  text: string;
  market: string;
  language: string;
  audience_hint: AccountFamily;
  top_k: number;
}

// the port to retelldb. the core never speaks http: a channel-adapter
// implements this interface against the retelldb service and is
// injected. a null or failing port degrades to straight-to-ticket;
// deflection availability never blocks reaching a human.
export interface RetellDbPort {
  lookup(request: LookupRequest): RetellLookup;
}

// the deflection screen rendered to the user: the offered answers,
// in offer order. the screen is the only chance to deflect; the
// next interaction is either resolved or the single human click.
export interface DeflectionScreen {
  case_id: string;
  answers: readonly SuggestedAnswer[];
  engine_path: string;
}

// ---- phase 3: routing, workspace, response library ----

// one (queue, market, language) set an agent works. markets are
// iso 3166-1 alpha-2, languages bcp-47; routing matches exactly.
export interface RoutingKey {
  queue: QueueId;
  market: string;
  language: string;
}

// agent profile (architecture §2): the routing sets the agent
// handles, an optional own concurrency cap (defaulting to the
// per-queue config), and senior eligibility for senior queues
// (phase 4 escalation).
export interface AgentProfile {
  id: string;
  handles: readonly RoutingKey[];
  concurrency_cap?: number;
  senior?: boolean;
}

// the workspace ticket view: read-and-propose panels only, zero
// money-moving controls. everything here derives from the ticket,
// its case, and their events; the agent owns what gets sent.
export interface ContextChip {
  label: string;
  detail?: string;
}

export interface IdentityPanel {
  account_family: AccountFamily;
  account_ref: string;
  market: string;
  language: string;
  source_channel: SourceChannel;
  intent_tag: string;
  chips: readonly ContextChip[];
}

export interface DeflectionHistoryItem {
  what: "lookup" | "offered" | "accepted" | "human_requested";
  at: string;
  detail: string;
}

export interface TicketView {
  ticket: Ticket;
  identity: IdentityPanel;
  order_refs: readonly string[];
  order_segments: readonly OrderSegmentSnapshot[];
  payout: PayoutSnapshot | null; // creator_support only
  deflection_history: readonly DeflectionHistoryItem[];
  drafts: readonly SuggestedAnswer[]; // retelldb suggestions, drafts only
  priority: { score: number; age_minutes: number };
  chain: readonly string[]; // reopen chain, this ticket first
}

// a canned response. the body may carry free text, but the entry
// must reference doc/kb/academy content by link: no knowledge lives
// only in canned responses (spec: workspace). validated on save.
export interface ResponseLibraryEntry {
  id: string;
  queue: QueueId;
  market?: string; // optional scope; unset means any market
  language?: string; // optional scope; unset means any language
  body: string;
  links: readonly ContentLink[];
}

export type ContentSource = "doc" | "kb" | "academy";

export interface ContentLink {
  source: ContentSource;
  url: string;
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
