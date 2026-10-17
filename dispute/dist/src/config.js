"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.COUNSEL_TRIAGE_TYPES = exports.DEFAULT_CONFIG = void 0;
exports.DEFAULT_CONFIG = Object.freeze({
    claim_types: [
        "ip_infringement",
        "license_violation",
        "trademark_or_publicity",
        "other_ip",
    ],
    provisional_default: "notify_only",
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
exports.COUNSEL_TRIAGE_TYPES = new Set([
    "trademark_or_publicity",
    "other_ip",
]);
