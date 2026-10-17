import type { EvidenceKindRequest } from "./config";

// data model (spec: dispute-architecture.md §4). ids opaque. every
// record carries created_at/updated_at. the filing party is an
// outside claimant: no bin, no cin, no account, by design.

export type ClaimType =
  | "ip_infringement"
  | "license_violation"
  | "trademark_or_publicity"
  | "other_ip";

export type Market = string; // iso 3166-1 alpha-2, informational only

// the claimant class (§3.1): an individual artist claiming their
// own work vs. a rights holder / studio / counsel filing through
// a formal legal channel. orthogonal to claim type; drives
// routing, the attestation-vs-notice intake elements, and the
// measurement split.
export type ClaimantClass = "individual_artist" | "legal_notice";

export interface LegalNoticeBlock {
  // the notice itself is the primary artifact: letter/case id,
  // representation, response deadline if stated. the deadline is
  // a caller-owned timer surfaced as a chip; expiry never fires
  // anything - it only warns.
  notice_ref: string;
  representation: string;
  response_deadline?: string;
}

// claim level state machine (§15); item outcomes live on items
export type ClaimState =
  | "new"
  | "bounced"
  | "under_review"
  | "provisional_action_logged"
  | "decided"
  | "rejected_restored"
  | "upheld_delisted"
  | "escalated_counsel"
  | "closed_referred"
  | "withdrawn"
  | "reopened"
  | "closed";

// per-item outcome: a claim closes when every item is decided
export type ItemOutcome = "pending" | "rejected" | "upheld" | "escalated" | "withdrawn" | "referred";

// dmca counter-notice overlay (§9, delist posture only)
export type ItemOverlay =
  | "none"
  | "upheld_pending_counter"
  | "counter_notice_filed"
  | "restore_window"
  | "restored_after_counter_notice"
  | "refiled";

export interface Attestation {
  perjury_acknowledged: boolean;
  authorized_to_act: boolean;
  good_faith_belief: boolean;
  // retention consent is its own element: the claim record is
  // retained in-platform
  retention_consent: boolean;
}

export interface ClaimantBlock {
  name: string;
  contact_channel: "email" | "post";
  contact_value: string;
  statement_of_rights: string;
  attestation: Attestation;
}

export interface ClaimedOriginal {
  urls?: readonly string[];
  image_refs?: readonly string[];
  registration_numbers?: readonly string[];
}

export interface ClaimInput {
  claim_type: ClaimType;
  claimant_class: ClaimantClass; // §3.1; default individual_artist
  locale: string;
  market: Market;
  claimant: ClaimantBlock;
  // required for legal_notice claims; ignored otherwise
  legal_notice?: LegalNoticeBlock;
  claimed_originals: ClaimedOriginal;
  items: readonly { listing_ref: string }[];
  resubmission_of?: string;
}

export interface ClaimItem {
  id: string;
  claim_ref: string;
  listing_ref: string;
  provisional: "none" | "delisted" | "notify_only";
  provisional_ref: string | null;
  outcome: ItemOutcome;
  overlay: ItemOverlay;
  decision_ref: string | null;
}

export interface Claim {
  id: string;
  claim_type: string;
  claimant_class: ClaimantClass;
  legal_notice: Readonly<LegalNoticeBlock> | null;
  state: ClaimState;
  locale: string;
  market: Market;
  claimant: Readonly<ClaimantBlock>;
  claimed_originals: Readonly<ClaimedOriginal>;
  items: readonly string[];
  bounced_from: string | null;
  reopened_from: string | null;
  submitted_at: string;
  created_at: string;
  updated_at: string;
}

// evidence artifacts are immutable once attached
export type EvidenceKind = EvidenceKindRequest | "claimant_upload";

export interface EvidenceArtifact {
  id: string;
  claim_ref: string;
  item_ref: string | null;
  kind: EvidenceKind;
  payload_ref: string;
  produced_by: string;
  attached_at: string;
}

// only this record type moves enforcement (invariant 2/3): the
// signature is a required human field, not a machine value.
export interface DecisionRecord {
  id: string;
  claim_ref: string;
  item_ref: string;
  outcome: Exclude<ItemOutcome, "pending">;
  reasoning: string;
  reviewer_id: string;
  signature: string;
  decided_at: string;
  evidence_refs: readonly string[];
}

export interface CounterNotice {
  id: string;
  item_ref: string;
  creator_statement: string;
  filed_at: string;
  restore_window_expires_at: string;
}

export interface RegistryEntry {
  id: string;
  contact_hash: string;
  policy_citation: string;
  signed_by: string;
  signature: string;
  added_at: string;
}

export interface Inquiry {
  id: string;
  question_text: string;
  locale: string;
  market: Market;
  contact: string | null;
  state: "new" | "answered" | "closed";
  created_at: string;
}

export interface ReviewerHours {
  reviewer_id: string;
  claim_ref: string;
  date: string;
  hours: number;
}

// ---- consumed interfaces (all behind adapters) ----

// contact reachability only, verdicts as chips, never a routing
// input (same discipline as themailtell in ticketing)
export interface ContactGatePort {
  validate(channel: string, value: string): { reachable: boolean; verdict_chip: string };
}

export interface MarketplacePort {
  isDelisted(listingRef: string): boolean;
  delist(listingRef: string, itemRef: string): string;
  restore(listingRef: string, itemRef: string): string;
  listingCount(): number;
}

// the inquiry path borrows the ticketing deflection machinery over
// public content rather than inventing a second deflector (§5.1)
export interface PublicContentAnswer {
  doc_id: string;
  title: string;
  snippet: string;
  url: string;
}

export interface PublicContentPort {
  lookup(query: string): {
    answers: readonly PublicContentAnswer[];
    engine_path: string;
    latency_ms: number;
  };
}

export interface SimilarityReportPort {
  run(claimedOriginalRef: string, listingRef: string): {
    payload_ref: string;
    produced_by: string;
    score: number;
    band: string;
  };
}

export interface ReleaseHistoryPort {
  timeline(listingRef: string, claimedOriginalRefs: readonly string[]): {
    payload_ref: string;
    produced_by: string;
  };
}

export interface ProvenancePort {
  lookup(listingRef: string): {
    payload_ref: string;
    produced_by: string;
    template_ref: string | null;
    house_template: boolean;
  };
}

export interface ChainOfTitlePort {
  lookup(listingRef: string, claimantName: string): {
    payload_ref: string;
    produced_by: string;
  };
}

export interface WatermarkPort {
  trace(fileRef: string): {
    payload_ref: string;
    produced_by: string;
    source_order_ref: string | null;
  };
}
