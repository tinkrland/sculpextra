import type { Claim } from "./types";
import type { DisputeConfig } from "./config";
import { COUNSEL_TRIAGE_TYPES } from "./config";
import { deepFreeze } from "./events";

// the review queue (§7): routing mirrors the ticketing discipline
// on claim records. review sets are keyed (claim_type, market,
// language); counsel-triage claims (trademark_or_publicity,
// other_ip) route to the counsel-facing set. round-robin under
// per-reviewer caps; priority is age-only. priority never
// influences assignment: an older claim simply reaches the queue
// first. timers are caller-owned.

export class ReviewError extends Error {}

export interface ReviewerProfile {
  id: string;
  handles: readonly { claim_type: string; market: string; language: string }[];
  counsel: boolean; // counsel-facing reviewer set
  concurrency_cap?: number;
}

const OPEN_STATES = new Set(["under_review", "provisional_action_logged", "decided"]);

export class ReviewQueue {
  private readonly reviewers = new Map<string, ReviewerProfile>();
  private readonly cursors = new Map<string, number>();

  constructor(
    private readonly config: DisputeConfig,
    private readonly claimOf: (id: string) => Claim | undefined,
    private readonly logAssignment: (claimId: string, reviewerId: string, now: string) => void,
  ) {}

  public addReviewer(profile: ReviewerProfile): void {
    if (!profile.id) throw new ReviewError("reviewer id required");
    if (this.reviewers.has(profile.id)) throw new ReviewError(`reviewer ${profile.id} already registered`);
    this.reviewers.set(profile.id, deepFreeze(structuredClone(profile)));
  }

  // assign a claim to an eligible reviewer. returns the reviewer
  // id, or null when nobody matches the review set or every
  // match is at cap (the claim stays queued).
  public assignClaim(claimId: string, now: string): string | null {
    const claim = this.claimOf(claimId);
    if (!claim) throw new ReviewError(`unknown claim: ${claimId}`);
    if (!OPEN_STATES.has(claim.state)) {
      throw new ReviewError(`claim ${claimId} is ${claim.state}, not open for review`);
    }
    const counsel = COUNSEL_TRIAGE_TYPES.has(claim.claim_type as never);
    const eligible = [...this.reviewers.values()].filter((r) => {
      if (r.counsel !== counsel) return false;
      if (!r.handles.some(
        (h) => h.claim_type === claim.claim_type && h.market === claim.market && h.language === claim.locale,
      )) return false;
      const cap = r.concurrency_cap ?? this.config.reviewer_concurrency_cap;
      return this.activeOf(r.id) < cap;
    });
    if (eligible.length === 0) return null;
    const key = `${claim.claim_type}|${claim.market}|${claim.locale}`;
    const cursor = this.cursors.get(key) ?? 0;
    const chosen = eligible[cursor % eligible.length];
    this.cursors.set(key, cursor + 1);
    this.logAssignment(claimId, chosen.id, now);
    return chosen.id;
  }

  // ordering helper for callers feeding the queue: age-only
  public byAge(): (a: string, b: string) => number {
    return (a, b) => {
      const ca = this.claimOf(a);
      const cb = this.claimOf(b);
      if (!ca || !cb) return 0;
      return Date.parse(ca.submitted_at) - Date.parse(cb.submitted_at);
    };
  }

  private activeOf(reviewerId: string): number {
    let n = 0;
    for (const id of this.assigned) {
      const c = this.claimOf(id);
      if (c && OPEN_STATES.has(c.state) && this.assignedTo.get(id) === reviewerId) n += 1;
    }
    return n;
  }

  private readonly assigned = new Set<string>();
  private readonly assignedTo = new Map<string, string>();

  public registerAssignment(claimId: string, reviewerId: string): void {
    this.assigned.add(claimId);
    this.assignedTo.set(claimId, reviewerId);
  }

  public reviewerOf(claimId: string): string | undefined {
    return this.assignedTo.get(claimId);
  }
}
