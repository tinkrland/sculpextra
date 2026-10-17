import { createHash } from "node:crypto";
import type { ClaimEvent } from "./events";
import type {
  Claim,
  ClaimInput,
  ClaimItem,
  ClaimantClass,
  ContactGatePort,
  CounterNotice,
  DecisionRecord,
  EvidenceArtifact,
  EvidenceKind,
  Inquiry,
  ItemOverlay,
  MarketplacePort,
  RegistryEntry,
  ReviewerHours,
} from "./types";
import type { DisputeConfig, EvidenceKindRequest } from "./config";
import { COUNSEL_TRIAGE_TYPES, DEFAULT_CONFIG } from "./config";
import { Actor, EventLog, deepFreeze } from "./events";
import { assertClaimTransition, assertOverlayTransition, daysBetween, TERMINAL_OUTCOMES } from "./state";
import type { EvidenceRunner } from "./evidence";

// the claim lifecycle service: intake gating, provisional
// measures, the dmca loop, signed decisions, reopen/withdraw/
// reclassification. mirrors the ticketing disciplines: append-only
// events, signals never verdicts, human-gated enforcement. claims
// never require a sculptura account (invariant: account-free
// forever). only a signed DecisionRecord moves enforcement; the
// similarity machinery and all other evidence are signal data.

export class DisputeError extends Error {}

const system: Actor = { kind: "system" };
const reviewerActor = (id: string): Actor => ({ kind: "reviewer", id });
const claimantActor = (ref: string): Actor => ({ kind: "claimant", ref });

export type FileOutcome =
  | { kind: "bounced"; claim: Claim; missing: readonly string[] }
  | { kind: "merged"; claim: Claim; items_added: readonly string[] }
  | { kind: "filed"; claim: Claim; rate_limited_chip: boolean; registry_chip: boolean };

export interface ClaimantStatusItem {
  item_id: string;
  listing_ref: string;
  status: "under_review" | "reviewed_not_upheld" | "upheld" | "escalated" | "withdrawn" | "referred";
}

// the privacy-scrubbed claimant view (invariant 4/6): status and
// outcomes only. never internal ids beyond the claim's own, never
// creator personal or financial data, never fee/trust/ranking.
export interface ClaimantStatusView {
  claim_id: string;
  submitted_at: string;
  state: Claim["state"];
  items: readonly ClaimantStatusItem[];
}

export class DisputeService {
  private counter = 0;
  private itemCounter = 0;
  private decisionCounter = 0;
  private readonly claims = new Map<string, Claim>();
  private readonly items = new Map<string, ClaimItem>();
  private readonly decisions = new Map<string, DecisionRecord>();
  private readonly artifacts = new Map<string, EvidenceArtifact>();
  private readonly counters = new Map<string, CounterNotice>();
  private readonly hours = new Map<string, ReviewerHours>();
  private readonly filedPerContactDay = new Map<string, number>();
  private readonly log = new EventLog<ClaimEvent>();

  constructor(
    private readonly config: DisputeConfig = DEFAULT_CONFIG,
    private readonly marketplace: MarketplacePort,
    private readonly contactGate: ContactGatePort | null = null,
    private readonly evidencePorts: EvidenceRunner | null = null,
    private readonly registryLookup: ((contactHash: string) => RegistryEntry | undefined) | null = null,
  ) {}

  // ---- the educational screen (§5): never hides the form ----
  public educationalScreen() {
    return deepFreeze({
      naming_discipline: {
        ip_infringement: "you allege the listed design copies your original work (authorship contested)",
        license_violation: "you allege use beyond a grant you hold (e.g. personal-use-only license)",
        trademark_or_publicity: "marks or likeness, not design authorship",
        other_ip: "every other ip claim",
      },
      provenance_disclosure:
        "if the design derives from a sculptura house template, neither party owns the base; many claims resolve by knowing this before filing",
      provenance_explanation_ref: this.config.provenance_explanation_ref,
      form_visible: true,
    });
  }

  // ---- intake: the completeness gate, bounce exactly once ----
  public fileClaim(input: ClaimInput, now: string): FileOutcome {
    const contactHash = this.hashContact(input.claimant);
    this.counter += 1;
    const id = `claim_${this.counter}`;
    const claimantClass: ClaimantClass = input.claimant_class ?? "individual_artist";
    const base: Claim = deepFreeze({
      id,
      claim_type: input.claim_type,
      claimant_class: claimantClass,
      legal_notice: claimantClass === "legal_notice" ? (input.legal_notice ?? null) : null,
      state: "new",
      locale: input.locale,
      market: input.market,
      claimant: input.claimant,
      claimed_originals: input.claimed_originals,
      items: [],
      bounced_from: input.resubmission_of ?? this.latestBouncedOf(contactHash) ?? null,
      reopened_from: null,
      submitted_at: now,
      created_at: now,
      updated_at: now,
    });
    this.claims.set(id, base);
    this.log.append(id, (seq) => ({
      claim_ref: id,
      seq,
      type: "claim_submitted",
      actor: claimantActor(contactHash),
      payload: {
        claim_type: input.claim_type,
        claimant_class: claimantClass,
        market: input.market,
        locale: input.locale,
        items: input.items.map((i) => i.listing_ref),
        response_deadline: claimantClass === "legal_notice" ? (input.legal_notice?.response_deadline ?? null) : null,
      },
      created_at: now,
    }));

    // contact gate: reachability only, verdict as chip. unreachable
    // contact is a bounce reason (the claimant could not be
    // notified), never a rejection of the claim's merits.
    if (this.config.contact_gate_required && this.contactGate) {
      const verdict = this.contactGate.validate(input.claimant.contact_channel, input.claimant.contact_value);
      this.log.append(id, (seq) => ({
        claim_ref: id,
        seq,
        type: "contact_gate_verdict",
        actor: system,
        payload: { reachable: verdict.reachable, verdict_chip: verdict.verdict_chip },
        created_at: now,
      }));
      if (!verdict.reachable) {
        return this.bounce(id, ["contact channel unreachable (we could not verify a way to notify you)"], now);
      }
    }

    // completeness: all required elements or bounce, exactly once,
    // with the specific missing elements listed
    const missing = this.missingElements(input);
    if (missing.length > 0) {
      return this.bounce(id, missing, now);
    }

    // duplicate merge: same claimant contact + same listing within
    // the window merges into the open claim as an amendment event,
    // never a second review
    const duplicate = this.findOpenDuplicate(contactHash, input.items.map((i) => i.listing_ref), now);
    if (duplicate) {
      const added: ClaimItem[] = [];
      for (const listing of input.items.map((i) => i.listing_ref)) {
        const existing = [...this.items.values()].find(
          (it) => it.claim_ref === duplicate.id && it.listing_ref === listing,
        );
        if (!existing) {
          added.push(this.createItem(duplicate.id, listing, now));
        }
      }
      this.log.append(duplicate.id, (seq) => ({
        claim_ref: duplicate.id,
        seq,
        type: "merged_amendment",
        actor: claimantActor(contactHash),
        payload: {
          merged_from_submission: id,
          items_added: added.map((it) => it.id),
          amended_items: input.items.map((i) => i.listing_ref),
        },
        created_at: now,
      }));
      // the bounced-looking submission record closes silently as a
      // merged amendment; it is never a second review
      this.claims.set(id, deepFreeze(structuredClone({ ...base, state: "bounced" as const, updated_at: now })));
      for (const it of added) this.applyProvisionalDefault(it, now);
      this.updateClaim(duplicate.id, now, (c) => ({ ...c }));
      return { kind: "merged", claim: this.claims.get(duplicate.id)!, items_added: Object.freeze(added.map((it) => it.id)) };
    }

    // rate limits: per-claimant-contact per day; trips log an event
    // and are visible to reviewers; never block filing outright
    const registryEntry = this.registryLookup?.(contactHash);
    const limit = registryEntry ? this.config.registry_rate_limit_per_day : this.config.rate_limit_per_claimant_day;
    const dayKey = `${contactHash}|${now.slice(0, 10)}`;
    const count = this.filedPerContactDay.get(dayKey) ?? 0;
    const tripped = count >= limit;
    if (tripped) {
      this.log.append(id, (seq) => ({
        claim_ref: id,
        seq,
        type: "rate_limited",
        actor: system,
        payload: { limit, registry_tightened: Boolean(registryEntry) },
        created_at: now,
      }));
    }
    this.filedPerContactDay.set(dayKey, count + 1);

    // facially complete: items created, provisional default fires
    for (const i of input.items) {
      const item = this.createItem(id, i.listing_ref, now);
      this.applyProvisionalDefault(item, now);
    }
    this.transition(id, "under_review", now);
    return {
      kind: "filed",
      claim: this.claims.get(id)!,
      rate_limited_chip: tripped,
      registry_chip: Boolean(registryEntry),
    };
  }

  // ---- evidence: on demand, immutable once attached (§6) ----
  public requestEvidence(
    claimId: string,
    itemId: string,
    kind: EvidenceKindRequest,
    reviewerId: string,
    now: string,
  ): EvidenceArtifact {
    const item = this.mustItem(itemId);
    if (item.claim_ref !== claimId) throw new DisputeError(`item ${itemId} is not on claim ${claimId}`);
    if (!this.evidencePorts) throw new DisputeError("no evidence ports configured");
    this.log.append(claimId, (seq) => ({
      claim_ref: claimId,
      seq,
      type: "evidence_requested",
      actor: reviewerActor(reviewerId),
      payload: { item_ref: itemId, kind, cost_units: this.config.evidence_costs[kind] },
      created_at: now,
    }));
    const artifact = this.evidencePorts.run(kind, this.mustClaim(claimId), item);
    const stored: EvidenceArtifact = deepFreeze(structuredClone({
      id: `ev_${this.artifacts.size + 1}`,
      claim_ref: claimId,
      item_ref: itemId,
      kind,
      payload_ref: artifact.payload_ref,
      produced_by: artifact.produced_by,
      attached_at: now,
    }));
    this.artifacts.set(stored.id, stored);
    this.log.append(claimId, (seq) => ({
      claim_ref: claimId,
      seq,
      type: "evidence_attached",
      actor: system,
      payload: { artifact_id: stored.id, item_ref: itemId, kind, payload_ref: artifact.payload_ref, produced_by: artifact.produced_by },
      created_at: now,
    }));
    return stored;
  }

  public artifactsOf(claimId: string): readonly EvidenceArtifact[] {
    return Object.freeze([...this.artifacts.values()].filter((a) => a.claim_ref === claimId));
  }

  // ---- decisions: the only enforcement mover (invariant 2/3) ----
  public decideItem(
    claimId: string,
    itemId: string,
    outcome: "rejected" | "upheld" | "escalated",
    reasoning: string,
    reviewerId: string,
    signature: string,
    now: string,
    opts?: { provenance_shortcut?: boolean },
  ): DecisionRecord {
    if (!signature?.trim()) {
      throw new DisputeError("a decision requires a human signature; nothing moves without one");
    }
    const claim = this.mustClaim(claimId);
    const item = this.mustItem(itemId);
    if (item.claim_ref !== claimId) throw new DisputeError(`item ${itemId} is not on claim ${claimId}`);
    if (!["under_review", "provisional_action_logged", "decided", "escalated_counsel"].includes(claim.state)) {
      throw new DisputeError(`claim ${claimId} is ${claim.state}, not open for decisions`);
    }
    if (TERMINAL_OUTCOMES.has(item.outcome)) {
      throw new DisputeError(`item ${itemId} is already decided (${item.outcome})`);
    }
    // the decision composer gates on evidence review, not on score
    // thresholds: at least one artifact must be attached for the
    // item (or the provenance shortcut attaches its own)
    const attached = this.artifactsOf(claimId).filter((a) => a.item_ref === itemId);
    if (attached.length === 0 && !opts?.provenance_shortcut) {
      throw new DisputeError("the decision composer gates on evidence review: attach evidence first");
    }

    this.decisionCounter += 1;
    const evidenceRefs = opts?.provenance_shortcut
      ? [...attached.map((a) => a.id), this.config.provenance_explanation_ref]
      : attached.map((a) => a.id);
    const record: DecisionRecord = deepFreeze({
      id: `dec_${this.decisionCounter}`,
      claim_ref: claimId,
      item_ref: itemId,
      outcome,
      reasoning,
      reviewer_id: reviewerId,
      signature,
      decided_at: now,
      evidence_refs: Object.freeze(evidenceRefs),
    });
    this.decisions.set(record.id, record);
    this.log.append(claimId, (seq) => ({
      claim_ref: claimId,
      seq,
      type: "decision_recorded",
      actor: reviewerActor(reviewerId),
      payload: {
        decision_id: record.id,
        item_ref: itemId,
        outcome,
        signature,
        evidence_refs: record.evidence_refs,
        provenance_shortcut: Boolean(opts?.provenance_shortcut),
      },
      created_at: now,
    }));

    // outcome effects
    if (outcome === "rejected") {
      if (item.provisional === "delisted") this.restoreProvisional(claimId, item, reviewerActor(reviewerId), now);
      this.setItem(itemId, now, (it) => ({ ...it, outcome: "rejected", decision_ref: record.id }));
    } else if (outcome === "upheld") {
      // delist stands (or a notify-only upheld item now delists):
      // only via the signed decision record
      if (item.provisional !== "delisted") {
        const portRef = this.marketplace.delist(item.listing_ref, itemId);
        this.log.append(claimId, (seq) => ({
          claim_ref: claimId,
          seq,
          type: "provisional_delisted",
          actor: reviewerActor(reviewerId),
          payload: { item_ref: itemId, listing_ref: item.listing_ref, port_ref: portRef, on_uphold: true, signature },
          created_at: now,
        }));
        this.setItem(itemId, now, (it) => ({ ...it, provisional: "delisted", provisional_ref: portRef }));
      }
      const fresh = this.mustItem(itemId);
      if (fresh.provisional === "delisted") {
        this.setItem(itemId, now, (it) => ({ ...it, overlay: "upheld_pending_counter", outcome: "upheld", decision_ref: record.id }));
        this.notifyCreator(claimId, itemId, "upheld with counter-notice window exposed", signature, now);
      } else {
        this.setItem(itemId, now, (it) => ({ ...it, outcome: "upheld", decision_ref: record.id }));
        this.notifyCreator(claimId, itemId, "upheld", signature, now);
      }
      // the dispute system only emits evidence events; the ladder
      // itself is a separate human-signed policy doc (§11)
      this.log.append(claimId, (seq) => ({
        claim_ref: claimId,
        seq,
        type: "enforcement_step_signed",
        actor: reviewerActor(reviewerId),
        payload: { decision_ref: record.id, item_ref: itemId, signature, signal: "upheld", note: "evidence event for the repeat-infringer ladder" },
        created_at: now,
      }));
    } else {
      // escalated: the claim pauses, counsel owns posture, nothing
      // mechanical fires while paused. the state machine passes
      // through decided before the pause (§15).
      this.setItem(itemId, now, (it) => ({ ...it, outcome: "escalated", decision_ref: record.id }));
      if (claim.state === "under_review" || claim.state === "provisional_action_logged") {
        this.transition(claimId, "decided", now);
      }
      const cur = this.claims.get(claimId)!;
      if (cur.state !== "escalated_counsel") {
        this.transition(claimId, "escalated_counsel", now);
        this.log.append(claimId, (seq) => ({
          claim_ref: claimId,
          seq,
          type: "counsel_clock_paused",
          actor: reviewerActor(reviewerId),
          payload: { paused_at: now, reason: "escalated to counsel" },
          created_at: now,
        }));
      }
    }

    // claim bookkeeping: decided on first decision; terminal when
    // every item is decided
    const after = this.claims.get(claimId)!;
    if (after.state === "under_review" || after.state === "provisional_action_logged") {
      this.transition(claimId, "decided", now);
    }
    this.closeIfComplete(claimId, now);
    return record;
  }

  // counsel returns: the clock resumes, review continues
  public counselReturn(claimId: string, counselId: string, now: string): void {
    const claim = this.mustClaim(claimId);
    assertClaimTransition(claim.state, "decided");
    this.transition(claimId, "decided", now);
    this.log.append(claimId, (seq) => ({
      claim_ref: claimId,
      seq,
      type: "counsel_clock_resumed",
      actor: { kind: "counsel", id: counselId },
      payload: { resumed_at: now },
      created_at: now,
    }));
    this.closeIfComplete(claimId, now);
  }

  // type correction (§3): the reviewer may correct the claim type
  // with a logged event; misrouting is measured, never silently
  // corrected. not a merits decision and not enforcement: no
  // signature moves anything, but the correction is attributed.
  public correctType(claimId: string, toType: string, reviewerId: string, now: string): Claim {
    const claim = this.mustClaim(claimId);
    if (!this.config.claim_types.includes(toType as never)) {
      throw new DisputeError(`unknown claim type: ${toType}`);
    }
    if (claim.claim_type === toType) throw new DisputeError("type correction equals the current type");
    this.log.append(claimId, (seq) => ({
      claim_ref: claimId,
      seq,
      type: "type_corrected",
      actor: reviewerActor(reviewerId),
      payload: { from: claim.claim_type, to: toType, reviewer_id: reviewerId },
      created_at: now,
    }));
    this.updateClaim(claimId, now, (c) => ({ ...c, claim_type: toType }));
    return this.claims.get(claimId)!;
  }

  // a claim that is really a question (§10): closed_referred, a
  // referral link attached, no merits decision, no enforcement
  public referAsQuestion(claimId: string, referralLink: string, reviewerId: string, signature: string, now: string): Claim {
    if (!signature?.trim()) throw new DisputeError("a reclassification requires a human signature");
    const claim = this.mustClaim(claimId);
    if (!["under_review", "provisional_action_logged"].includes(claim.state)) {
      throw new DisputeError(`claim ${claimId} is ${claim.state}, not referable`);
    }
    this.log.append(claimId, (seq) => ({
      claim_ref: claimId,
      seq,
      type: "claim_reclassified_question",
      actor: reviewerActor(reviewerId),
      payload: { referral_link: referralLink, signature, reviewer_id: reviewerId },
      created_at: now,
    }));
    for (const itemId of claim.items) {
      const item = this.mustItem(itemId);
      if (item.provisional === "delisted") this.restoreProvisional(claimId, item, reviewerActor(reviewerId), now);
      this.setItem(itemId, now, (it) => ({ ...it, outcome: "referred", provisional: "none" }));
    }
    this.transition(claimId, "closed_referred", now);
    this.transition(claimId, "closed", now);
    this.log.append(claimId, (seq) => ({
      claim_ref: claimId,
      seq,
      type: "claim_closed",
      actor: system,
      payload: { outcome: "closed_referred", excluded_from_substantiation: true },
      created_at: now,
    }));
    return this.claims.get(claimId)!;
  }

  // withdrawal: logged, never bad-faith evidence by itself
  public withdraw(claimId: string, now: string, itemId?: string): Claim {
    const claim = this.mustClaim(claimId);
    if (itemId) {
      const item = this.mustItem(itemId);
      if (TERMINAL_OUTCOMES.has(item.outcome)) throw new DisputeError(`item ${itemId} is already decided`);
      if (item.provisional === "delisted") this.restoreProvisional(claimId, item, system, now);
      this.setItem(itemId, now, (it) => ({ ...it, outcome: "withdrawn", provisional: "none" }));
      this.log.append(claimId, (seq) => ({
        claim_ref: claimId,
        seq,
        type: "claim_withdrawn",
        actor: claimantActor(claimId),
        payload: { item_ref: itemId, scope: "item" },
        created_at: now,
      }));
      this.closeIfComplete(claimId, now);
      return this.claims.get(claimId)!;
    }
    for (const id of claim.items) {
      const item = this.mustItem(id);
      if (!TERMINAL_OUTCOMES.has(item.outcome)) {
        if (item.provisional === "delisted") this.restoreProvisional(claimId, item, system, now);
        this.setItem(id, now, (it) => ({ ...it, outcome: "withdrawn", provisional: "none" }));
      }
    }
    this.log.append(claimId, (seq) => ({
      claim_ref: claimId,
      seq,
      type: "claim_withdrawn",
      actor: claimantActor(claimId),
      payload: { scope: "claim" },
      created_at: now,
    }));
    this.transition(claimId, "withdrawn", now);
    this.transition(claimId, "closed", now);
    this.log.append(claimId, (seq) => ({
      claim_ref: claimId,
      seq,
      type: "claim_closed",
      actor: system,
      payload: { outcome: "withdrawn", excluded_from_substantiation: true },
      created_at: now,
    }));
    return this.claims.get(claimId)!;
  }

  // reopen: within 30 days, links to history (chain discipline)
  public reopenClaim(claimId: string, now: string): Claim {
    const old = this.mustClaim(claimId);
    if (old.state !== "closed") throw new DisputeError(`claim ${claimId} is ${old.state}, not closed`);
    const age = daysBetween(old.updated_at, now);
    if (age > this.config.reopen_window_days) {
      throw new DisputeError(`reopen window is ${this.config.reopen_window_days} days; file a new claim linked to the old`);
    }
    this.counter += 1;
    const id = `claim_${this.counter}`;
    const reopened: Claim = deepFreeze({
      id,
      claim_type: old.claim_type,
      claimant_class: old.claimant_class,
      legal_notice: old.legal_notice,
      state: "reopened",
      locale: old.locale,
      market: old.market,
      claimant: old.claimant,
      claimed_originals: old.claimed_originals,
      items: [],
      bounced_from: null,
      reopened_from: old.id,
      submitted_at: now,
      created_at: now,
      updated_at: now,
    });
    this.claims.set(id, reopened);
    this.log.append(id, (seq) => ({
      claim_ref: id,
      seq,
      type: "claim_reopened",
      actor: system,
      payload: { reopened_from: old.id, age_days: age },
      created_at: now,
    }));
    for (const itemId of old.items) {
      const prior = this.mustItem(itemId);
      const item = this.createItem(id, prior.listing_ref, now);
      void item;
    }
    this.transition(id, "under_review", now);
    return this.claims.get(id)!;
  }

  // ---- the dmca loop (§9): timers caller-owned ----
  public fileCounterNotice(claimId: string, itemId: string, creatorStatement: string, now: string): CounterNotice {
    const item = this.mustItem(itemId);
    if (item.claim_ref !== claimId) throw new DisputeError(`item ${itemId} is not on claim ${claimId}`);
    if (item.outcome !== "upheld") throw new DisputeError("the counter-notice window exists only on upheld items");
    assertOverlayTransition(item.overlay, "counter_notice_filed");
    const expires = new Date(
      Date.parse(now) + this.config.restore_window_days * 86_400_000,
    ).toISOString();
    this.setItem(itemId, now, (it) => ({ ...it, overlay: "counter_notice_filed" }));
    const notice: CounterNotice = deepFreeze({
      id: `cn_${this.counters.size + 1}`,
      item_ref: itemId,
      creator_statement: creatorStatement,
      filed_at: now,
      restore_window_expires_at: expires,
    });
    this.counters.set(notice.id, notice);
    this.log.append(claimId, (seq) => ({
      claim_ref: claimId,
      seq,
      type: "counter_notice_filed",
      actor: system,
      payload: { item_ref: itemId, counter_notice_id: notice.id, statute_version: this.config.statute_version },
      created_at: now,
    }));
    this.log.append(claimId, (seq) => ({
      claim_ref: claimId,
      seq,
      type: "restore_window_started",
      actor: system,
      payload: { item_ref: itemId, expires_at: expires, window_days: this.config.restore_window_days },
      created_at: now,
    }));
    this.setItem(itemId, now, (it) => ({ ...it, overlay: "restore_window" }));
    return notice;
  }

  // the caller runs the clock; this fires only after the window
  // with no refile (acceptance 9)
  public onRestoreWindowExpiry(claimId: string, itemId: string, now: string): boolean {
    const item = this.mustItem(itemId);
    if (item.overlay !== "restore_window") return false;
    const notice = [...this.counters.values()].find((c) => c.item_ref === itemId);
    if (!notice) throw new DisputeError(`no counter notice on item ${itemId}`);
    if (Date.parse(now) < Date.parse(notice.restore_window_expires_at)) return false;
    assertOverlayTransition(item.overlay, "restored_after_counter_notice");
    const portRef = this.marketplace.restore(item.listing_ref, itemId);
    this.setItem(itemId, now, (it) => ({ ...it, overlay: "restored_after_counter_notice", provisional: "none" }));
    this.log.append(claimId, (seq) => ({
      claim_ref: claimId,
      seq,
      type: "restored_after_counter_notice",
      actor: system,
      payload: { item_ref: itemId, port_ref: portRef, statute_version: this.config.statute_version },
      created_at: now,
    }));
    // the dmca overlay is item-level and may run after the claim
    // closed on the upheld decision; the overlay events append
    // either way, no claim state moves
    if (this.claims.get(claimId)!.state !== "closed") this.closeIfComplete(claimId, now);
    return true;
  }

  // claimant refile within the window: counsel owns it, the clock
  // pauses, no further mechanical action fires
  public claimantRefile(claimId: string, itemId: string, now: string): void {
    const item = this.mustItem(itemId);
    if (item.overlay !== "restore_window") throw new DisputeError("refile exists only during the restore window");
    assertOverlayTransition(item.overlay, "refiled");
    this.setItem(itemId, now, (it) => ({ ...it, overlay: "refiled", outcome: "escalated" }));
    this.log.append(claimId, (seq) => ({
      claim_ref: claimId,
      seq,
      type: "claimant_refiled",
      actor: system,
      payload: { item_ref: itemId },
      created_at: now,
    }));
    this.log.append(claimId, (seq) => ({
      claim_ref: claimId,
      seq,
      type: "counsel_clock_paused",
      actor: system,
      payload: { paused_at: now, reason: "claimant refile within the restore window" },
      created_at: now,
    }));
  }

  // ---- manual provisional measures: human-gated, signed ----
  public manualDelist(claimId: string, itemId: string, reviewerId: string, signature: string, now: string): ClaimItem {
    if (!signature?.trim()) throw new DisputeError("a manual delist requires a human signature");
    const item = this.mustItem(itemId);
    if (item.claim_ref !== claimId) throw new DisputeError(`item ${itemId} is not on claim ${claimId}`);
    if (item.provisional === "delisted") throw new DisputeError("item already delisted");
    const portRef = this.marketplace.delist(item.listing_ref, itemId);
    this.log.append(claimId, (seq) => ({
      claim_ref: claimId,
      seq,
      type: "provisional_delisted",
      actor: reviewerActor(reviewerId),
      payload: { item_ref: itemId, listing_ref: item.listing_ref, port_ref: portRef, manual: true, signature },
      created_at: now,
    }));
    this.setItem(itemId, now, (it) => ({ ...it, provisional: "delisted", provisional_ref: portRef }));
    this.notifyCreator(claimId, itemId, "manual provisional delist", signature, now);
    return this.mustItem(itemId);
  }

  public manualRestore(claimId: string, itemId: string, reviewerId: string, signature: string, now: string): ClaimItem {
    if (!signature?.trim()) throw new DisputeError("a manual restore requires a human signature");
    const item = this.mustItem(itemId);
    this.restoreProvisional(claimId, item, reviewerActor(reviewerId), now);
    return this.mustItem(itemId);
  }

  // ---- reviewer hours: the support-cost export input ----
  public logHours(reviewerId: string, claimId: string, date: string, hours: number, now: string): ReviewerHours {
    if (hours <= 0) throw new DisputeError("hours must be positive");
    const row: ReviewerHours = deepFreeze({ reviewer_id: reviewerId, claim_ref: claimId, date, hours });
    this.hours.set(`${reviewerId}|${claimId}|${date}`, row);
    this.log.append(claimId, (seq) => ({
      claim_ref: claimId,
      seq,
      type: "hours_logged",
      actor: reviewerActor(reviewerId),
      payload: { date, hours },
      created_at: now,
    }));
    return row;
  }

  // ---- views ----
  // privacy-scrubbed claimant status: outcomes only (invariant 4/6)
  public claimantStatus(claimId: string): ClaimantStatusView {
    const claim = this.mustClaim(claimId);
    const items = claim.items.map((itemId) => {
      const it = this.mustItem(itemId);
      const status: ClaimantStatusItem["status"] =
        it.outcome === "rejected" ? "reviewed_not_upheld"
        : it.outcome === "upheld" ? "upheld"
        : it.outcome === "escalated" ? "escalated"
        : it.outcome === "withdrawn" ? "withdrawn"
        : it.outcome === "referred" ? "referred"
        : "under_review";
      return { item_id: it.id, listing_ref: it.listing_ref, status };
    });
    return deepFreeze({
      claim_id: claim.id,
      submitted_at: claim.submitted_at,
      state: claim.state,
      items: Object.freeze(items),
    });
  }

  // the reviewer view: everything except fee/trust/ranking (those
  // values are structurally absent from this system)
  public reviewerView(claimId: string) {
    const claim = this.mustClaim(claimId);
    const registryChip = Boolean(this.registryLookup?.(this.hashContact(claim.claimant)));
    return deepFreeze({
      claim_id: claim.id,
      claim_type: claim.claim_type,
      claimant_class: claim.claimant_class,
      legal_notice: claim.legal_notice,
      state: claim.state,
      market: claim.market,
      locale: claim.locale,
      claimant: claim.claimant,
      claimed_originals: claim.claimed_originals,
      counsel_triage:
        COUNSEL_TRIAGE_TYPES.has(claim.claim_type as never) || claim.claimant_class === "legal_notice",
      registry_chip: registryChip,
      items: Object.freeze(claim.items.map((id) => this.mustItem(id))),
      evidence: this.artifactsOf(claimId),
      decisions: Object.freeze([...this.decisions.values()].filter((d) => d.claim_ref === claimId)),
      hours: Object.freeze([...this.hours.values()].filter((h) => h.claim_ref === claimId)),
      events: this.log.list(claimId),
    });
  }

  // ---- read accessors ----
  public claim(id: string): Claim | undefined {
    return this.claims.get(id);
  }
  public item(id: string): ClaimItem | undefined {
    return this.items.get(id);
  }
  public decision(id: string): DecisionRecord | undefined {
    return this.decisions.get(id);
  }
  public claimEvents(id: string): readonly ClaimEvent[] {
    return this.log.list(id);
  }
  public claimIds(): readonly string[] {
    return Object.freeze([...this.claims.keys()]);
  }
  public hoursAll(): readonly ReviewerHours[] {
    return Object.freeze([...this.hours.values()]);
  }
  public contactHashOf(claim: Claim): string {
    return this.hashContact(claim.claimant);
  }

  // ---- internals ----
  private missingElements(input: ClaimInput): string[] {
    const missing: string[] = [];
    const c = input.claimant;
    if (!c.name?.trim()) missing.push("claimant name");
    if (!c.contact_channel || !c.contact_value?.trim()) missing.push("claimant contact (email or post channel)");
    if (!c.statement_of_rights?.trim()) missing.push("statement of your rights in the work");
    const claimantClass: ClaimantClass = input.claimant_class ?? "individual_artist";
    if (claimantClass === "legal_notice") {
      // the notice elements replace the good-faith attestation for a
      // formal legal filing (§3.1): the letter itself is the artifact
      const n = input.legal_notice;
      if (!n?.notice_ref?.trim()) missing.push("legal notice reference (letter or case id)");
      if (!n?.representation?.trim()) missing.push("representation (rights holder or firm)");
    } else {
      const a = c.attestation;
      if (!a.perjury_acknowledged) missing.push("perjury acknowledgment");
      if (!a.authorized_to_act) missing.push("authorization to act");
      if (!a.good_faith_belief) missing.push("good-faith belief statement");
      if (!a.retention_consent) missing.push("acceptance that the claim record is retained in-platform");
    }
    const o = input.claimed_originals;
    const hasOriginal = (o.urls?.length ?? 0) + (o.image_refs?.length ?? 0) + (o.registration_numbers?.length ?? 0) > 0;
    if (!hasOriginal) missing.push("identification of the claimed original work (links, images, or registration)");
    if (input.items.length === 0) missing.push("the specific sculptura listing(s) claimed (urls or ids)");
    if (!this.config.claim_types.includes(input.claim_type)) {
      missing.push(`a valid claim type (got "${input.claim_type}")`);
    }
    return missing;
  }

  private bounce(id: string, missing: readonly string[], now: string): FileOutcome {
    this.log.append(id, (seq) => ({
      claim_ref: id,
      seq,
      type: "claim_bounced",
      actor: system,
      payload: { missing: Object.freeze([...missing]) },
      created_at: now,
    }));
    this.transition(id, "bounced", now);
    return { kind: "bounced", claim: this.claims.get(id)!, missing: Object.freeze([...missing]) };
  }

  private createItem(claimId: string, listingRef: string, now: string): ClaimItem {
    this.itemCounter += 1;
    const item: ClaimItem = deepFreeze({
      id: `item_${this.itemCounter}`,
      claim_ref: claimId,
      listing_ref: listingRef,
      provisional: "none",
      provisional_ref: null,
      outcome: "pending",
      overlay: "none" as ItemOverlay,
      decision_ref: null,
    });
    this.items.set(item.id, item);
    this.updateClaim(claimId, now, (c) => ({ ...c, items: [...c.items, item.id] }));
    return item;
  }

  // the configured provisional default (§14.1, ruling stashed):
  // delist is reversible + logged + creator notified; notify_only
  // notifies without delisting. claims against already-delisted
  // listings need no measure (edge case, §18).
  private applyProvisionalDefault(item: ClaimItem, now: string): void {
    if (this.marketplace.isDelisted(item.listing_ref)) {
      this.log.append(item.claim_ref, (seq) => ({
        claim_ref: item.claim_ref,
        seq,
        type: "provisional_notify_only",
        actor: system,
        payload: { item_ref: item.id, listing_ref: item.listing_ref, reason: "listing already delisted" },
        created_at: now,
      }));
      this.setItem(item.id, now, (it) => ({ ...it, provisional: "notify_only" }));
      return;
    }
    // the ruled split default (§14.1): legal notices delist on a
    // facially complete filing (redbubble-style); individual
    // artists get notify_only pending review. the class-keyed
    // config is the only difference - same reversible, logged,
    // creator-notified measure either way.
    const posture = this.config.provisional_default[this.mustClaim(item.claim_ref).claimant_class];
    if (posture === "delist") {
      const portRef = this.marketplace.delist(item.listing_ref, item.id);
      this.log.append(item.claim_ref, (seq) => ({
        claim_ref: item.claim_ref,
        seq,
        type: "provisional_delisted",
        actor: system,
        payload: { item_ref: item.id, listing_ref: item.listing_ref, port_ref: portRef, default: true },
        created_at: now,
      }));
      this.setItem(item.id, now, (it) => ({ ...it, provisional: "delisted", provisional_ref: portRef }));
    } else {
      this.log.append(item.claim_ref, (seq) => ({
        claim_ref: item.claim_ref,
        seq,
        type: "provisional_notify_only",
        actor: system,
        payload: {
          item_ref: item.id,
          listing_ref: item.listing_ref,
          default: true,
          posture,
          claimant_class: this.mustClaim(item.claim_ref).claimant_class,
        },
        created_at: now,
      }));
      this.setItem(item.id, now, (it) => ({ ...it, provisional: "notify_only" }));
    }
    this.notifyCreator(item.claim_ref, item.id, "provisional default", null, now);
  }

  private restoreProvisional(claimId: string, item: ClaimItem, actor: Actor, now: string): void {
    const portRef = this.marketplace.restore(item.listing_ref, item.id);
    this.log.append(claimId, (seq) => ({
      claim_ref: claimId,
      seq,
      type: "provisional_restored",
      actor,
      payload: { item_ref: item.id, listing_ref: item.listing_ref, port_ref: portRef },
      created_at: now,
    }));
    this.setItem(item.id, now, (it) => ({ ...it, provisional: "none", provisional_ref: null }));
  }

  // creator notification carries the claim summary; never claimant
  // contact data beyond what the notice policy allows
  private notifyCreator(claimId: string, itemId: string, what: string, signature: string | null, now: string): void {
    this.log.append(claimId, (seq) => ({
      claim_ref: claimId,
      seq,
      type: "creator_notified",
      actor: system,
      payload: { item_ref: itemId, notification: what, signature },
      created_at: now,
    }));
  }

  private closeIfComplete(claimId: string, now: string): void {
    const claim = this.mustClaim(claimId);
    const items = claim.items.map((id) => this.mustItem(id));
    if (!items.every((it) => TERMINAL_OUTCOMES.has(it.outcome))) return;
    const anyUpheld = items.some((it) => it.outcome === "upheld");
    const anyEscalated = items.some((it) => it.outcome === "escalated");
    const terminal = anyUpheld ? "upheld_delisted" : anyEscalated ? "escalated_counsel" : "rejected_restored";
    const state = this.claims.get(claimId)!.state;
    if (state === "under_review" || state === "provisional_action_logged") {
      this.transition(claimId, "decided", now);
    }
    const cur = this.claims.get(claimId)!;
    if (cur.state === "escalated_counsel" && terminal !== "upheld_delisted") {
      // counsel must return before a terminal close
      return;
    }
    if (cur.state !== terminal) {
      assertClaimTransition(cur.state, terminal);
      this.transition(claimId, terminal, now);
    }
    this.transition(claimId, "closed", now);
    this.log.append(claimId, (seq) => ({
      claim_ref: claimId,
      seq,
      type: "claim_closed",
      actor: system,
      payload: { outcome: terminal },
      created_at: now,
    }));
  }

  private findOpenDuplicate(contactHash: string, listings: readonly string[], now: string): Claim | undefined {
    const horizon = Date.parse(now) - this.config.duplicate_merge_window_hours * 3_600_000;
    for (const claim of this.claims.values()) {
      if (["bounced", "closed", "withdrawn", "closed_referred"].includes(claim.state)) continue;
      if (this.hashContact(claim.claimant) !== contactHash) continue;
      if (Date.parse(claim.created_at) < horizon) continue;
      const claimListings = claim.items.map((id) => this.mustItem(id).listing_ref);
      if (listings.some((l) => claimListings.includes(l))) return claim;
    }
    return undefined;
  }

  private latestBouncedOf(contactHash: string): string | null {
    for (const id of [...this.claims.keys()].reverse()) {
      const c = this.claims.get(id)!;
      if (c.state === "bounced" && this.hashContact(c.claimant) === contactHash) return id;
    }
    return null;
  }

  private transition(id: string, to: Claim["state"], now: string): void {
    const claim = this.mustClaim(id);
    assertClaimTransition(claim.state, to);
    this.log.append(id, (seq) => ({
      claim_ref: id,
      seq,
      type: "state_changed",
      actor: system,
      payload: { from: claim.state, to },
      created_at: now,
    }));
    this.claims.set(id, deepFreeze(structuredClone({ ...claim, state: to, updated_at: now })));
  }

  private setItem(itemId: string, now: string, patch: (it: ClaimItem) => ClaimItem): void {
    const item = this.mustItem(itemId);
    this.items.set(itemId, deepFreeze(structuredClone({ ...patch(item) })));
    this.updateClaim(item.claim_ref, now, (c) => ({ ...c }));
  }

  private updateClaim(id: string, now: string, patch: (c: Claim) => Claim): void {
    const claim = this.mustClaim(id);
    this.claims.set(id, deepFreeze(structuredClone({ ...patch(claim), updated_at: now })));
  }

  private hashContact(claimant: { contact_channel: string; contact_value: string }): string {
    return createHash("sha256").update(`${claimant.contact_channel}:${claimant.contact_value}`).digest("hex");
  }

  private mustClaim(id: string): Claim {
    const c = this.claims.get(id);
    if (!c) throw new DisputeError(`unknown claim: ${id}`);
    return c;
  }

  private mustItem(id: string): ClaimItem {
    const it = this.items.get(id);
    if (!it) throw new DisputeError(`unknown item: ${id}`);
    return it;
  }
}
