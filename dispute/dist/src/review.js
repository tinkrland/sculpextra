"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ReviewQueue = exports.ReviewError = void 0;
const config_1 = require("./config");
const events_1 = require("./events");
// the review queue (§7): routing mirrors the ticketing discipline
// on claim records. review sets are keyed (claim_type, market,
// language); counsel-triage claims (trademark_or_publicity,
// other_ip) route to the counsel-facing set. round-robin under
// per-reviewer caps; priority is age-only. priority never
// influences assignment: an older claim simply reaches the queue
// first. timers are caller-owned.
class ReviewError extends Error {
}
exports.ReviewError = ReviewError;
const OPEN_STATES = new Set(["under_review", "provisional_action_logged", "decided"]);
class ReviewQueue {
    config;
    claimOf;
    logAssignment;
    reviewers = new Map();
    cursors = new Map();
    constructor(config, claimOf, logAssignment) {
        this.config = config;
        this.claimOf = claimOf;
        this.logAssignment = logAssignment;
    }
    addReviewer(profile) {
        if (!profile.id)
            throw new ReviewError("reviewer id required");
        if (this.reviewers.has(profile.id))
            throw new ReviewError(`reviewer ${profile.id} already registered`);
        this.reviewers.set(profile.id, (0, events_1.deepFreeze)(structuredClone(profile)));
    }
    // assign a claim to an eligible reviewer. returns the reviewer
    // id, or null when nobody matches the review set or every
    // match is at cap (the claim stays queued).
    assignClaim(claimId, now) {
        const claim = this.claimOf(claimId);
        if (!claim)
            throw new ReviewError(`unknown claim: ${claimId}`);
        if (!OPEN_STATES.has(claim.state)) {
            throw new ReviewError(`claim ${claimId} is ${claim.state}, not open for review`);
        }
        // counsel triage: the type set, plus every legal_notice claim
        // regardless of type (§3.1)
        const counsel = config_1.COUNSEL_TRIAGE_TYPES.has(claim.claim_type) || claim.claimant_class === "legal_notice";
        const eligible = [...this.reviewers.values()].filter((r) => {
            if (r.counsel !== counsel)
                return false;
            if (!r.handles.some((h) => h.claim_type === claim.claim_type && h.market === claim.market && h.language === claim.locale))
                return false;
            const cap = r.concurrency_cap ?? this.config.reviewer_concurrency_cap;
            return this.activeOf(r.id) < cap;
        });
        if (eligible.length === 0)
            return null;
        const key = `${claim.claim_type}|${claim.market}|${claim.locale}`;
        const cursor = this.cursors.get(key) ?? 0;
        const chosen = eligible[cursor % eligible.length];
        this.cursors.set(key, cursor + 1);
        this.logAssignment(claimId, chosen.id, now);
        return chosen.id;
    }
    // ordering helper for callers feeding the queue: age-only
    byAge() {
        return (a, b) => {
            const ca = this.claimOf(a);
            const cb = this.claimOf(b);
            if (!ca || !cb)
                return 0;
            return Date.parse(ca.submitted_at) - Date.parse(cb.submitted_at);
        };
    }
    activeOf(reviewerId) {
        let n = 0;
        for (const id of this.assigned) {
            const c = this.claimOf(id);
            if (c && OPEN_STATES.has(c.state) && this.assignedTo.get(id) === reviewerId)
                n += 1;
        }
        return n;
    }
    assigned = new Set();
    assignedTo = new Map();
    registerAssignment(claimId, reviewerId) {
        this.assigned.add(claimId);
        this.assignedTo.set(claimId, reviewerId);
    }
    reviewerOf(claimId) {
        return this.assignedTo.get(claimId);
    }
}
exports.ReviewQueue = ReviewQueue;
