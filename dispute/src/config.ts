import type { ClaimType } from "./types";

// one frozen config object, like ticketing: every rule below is a
// value, never a code path. changing any of it is a config change,
// not a code change (spec: dispute-architecture.md §14).

export interface DisputeConfig {
  // claim type taxonomy, config-owned (§3). misrouting between
  // ip_infringement and license_violation is measured, never
  // silently corrected.
  claim_types: readonly ClaimType[];

  // §14.1 OWNER RULING (recorded 2026-10-17, per owner
  // instruction): a split provisional default by claimant class.
  // a large studio's C&D is informing us, not asking for a review:
  // a facially complete notice naming a listing takes it down,
  // redbubble-style (dmca safe-harbor posture: reversible, logged,
  // creator notified, counter-notice window per statute). an
  // outside artist filing a claim is asking us to review it:
  // notify_only pending the review - no auto-delist on their word.
  provisional_default: {
    individual_artist: "delist" | "notify_only";
    legal_notice: "delist" | "notify_only";
  };

  // dmca statutory parameters, statute-versioned: a statute bump
  // is a config change + counsel review, not a code change (§9).
  statute_version: string;
  counter_notice_window_days: number;
  restore_window_days: number;

  // §14.2 queue + limits
  reviewer_concurrency_cap: number;
  rate_limit_per_claimant_day: number;
  registry_rate_limit_per_day: number; // tightened, never blocking
  duplicate_merge_window_hours: number;
  reopen_window_days: number;
  contact_gate_required: boolean;

  // evidence: on-demand runs are costed per port (§6)
  evidence_costs: Readonly<Record<EvidenceKindRequest, number>>;

  // public content hosts for inquiry deflection links (the
  // response-library link-validation discipline applies)
  content_link_hosts: readonly string[];

  // the provenance explanation page (the educational screen links
  // out to it; the template-provenance shortcut attaches it)
  provenance_explanation_ref: string;
}

export type EvidenceKindRequest =
  | "similarity_report"
  | "release_history"
  | "provenance_lookup"
  | "chain_of_title"
  | "watermark_trace";

export const DEFAULT_CONFIG: DisputeConfig = Object.freeze({
  claim_types: [
    "ip_infringement",
    "license_violation",
    "trademark_or_publicity",
    "other_ip",
  ] as readonly ClaimType[],
  provisional_default: {
    individual_artist: "notify_only" as const,
    legal_notice: "delist" as const,
  },
  statute_version: "dmca_us_17_usc_512_g_2026",
  counter_notice_window_days: 10,
  restore_window_days: 14,
  reviewer_concurrency_cap: 4,
  rate_limit_per_claimant_day: 3,
  registry_rate_limit_per_day: 1,
  duplicate_merge_window_hours: 72,
  reopen_window_days: 30,
  contact_gate_required: true,
  evidence_costs: {
    similarity_report: 2,
    release_history: 1,
    provenance_lookup: 1,
    chain_of_title: 2,
    watermark_trace: 3,
  },
  content_link_hosts: ["docs.sculptura.com", "kb.sculptura.com", "academy.sculptura.com"],
  provenance_explanation_ref: "https://docs.sculptura.com/provenance",
});

// claim types routed to counsel-facing triage early (§3): similarity
// reports are not authoritative for these.
export const COUNSEL_TRIAGE_TYPES: ReadonlySet<ClaimType> = new Set([
  "trademark_or_publicity",
  "other_ip",
]);
