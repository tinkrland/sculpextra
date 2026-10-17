import { test } from "node:test";
import assert from "node:assert/strict";
import { DisputeService } from "../src/claims";
import { InquiryService } from "../src/inquiry";
import { BadFaithRegistry } from "../src/registry";
import { ReviewQueue } from "../src/review";
import { EvidenceAdapter } from "../src/evidence";
import { measure } from "../src/measure";
import {
  FakeContactGate,
  FakeMarketplace,
  at,
  delistAll,
  fullAttestation,
  configWith,
  day,
  mkClaim,
  mkContent,
  mkEvidencePorts,
  T0,
} from "./helpers";
import type { DisputeConfig } from "../src/config";
import type { ClaimEvent } from "../src/events";

const mkAll = (opts: {
  config?: DisputeConfig;
  houseTemplate?: boolean;
  contentAnswers?: { doc_id: string; url: string }[];
  contentMatch?: (q: string) => boolean;
} = {}) => {
  const config = opts.config ?? configWith({});
  const marketplace = new FakeMarketplace();
  const gate = new FakeContactGate();
  const registry = new BadFaithRegistry();
  const evidence = new EvidenceAdapter(mkEvidencePorts({ houseTemplate: opts.houseTemplate }));
  const claims = new DisputeService(config, marketplace, gate, evidence, (h) => registry.lookup(h));
  const inquiries = new InquiryService(config, mkContent(opts.contentAnswers ?? [], opts.contentMatch));
  const review = new ReviewQueue(config, (id) => claims.claim(id), (cid, rid, now) => {
    claims.claimEvents(cid); // no-op read; assignment logged below
    const log = (claims as unknown as { log: { append: (r: string, f: (s: number) => ClaimEvent) => void } }).log;
    log.append(cid, (seq) => ({
      claim_ref: cid,
      seq,
      type: "reviewer_assigned",
      actor: { kind: "reviewer", id: rid },
      payload: { reviewer_id: rid },
      created_at: now,
    }));
    review.registerAssignment(cid, rid);
  });
  return { config, marketplace, gate, registry, evidence, claims, inquiries, review };
};

test("the contact gate bounces unreachable claimants without judging merits", () => {
  const svc = mkAll();
  svc.gate.reachable = false;
  const out = svc.claims.fileClaim(mkClaim(), T0);
  assert.equal(out.kind, "bounced");
  if (out.kind === "bounced") {
    assert.ok(out.missing.some((m) => m.includes("unreachable")));
    assert.equal(out.claim.state, "bounced");
  }
  // the verdict is a chip in the log, never a routing input
  const events = svc.claims.claimEvents(out.claim.id) as readonly ClaimEvent[];
  const verdict = events.find((e) => e.type === "contact_gate_verdict");
  const p = verdict?.payload as { verdict_chip: string };
  assert.equal(p.verdict_chip, "unreachable");
});

test("rate limits trip and stay visible; registry tightens, never blocks", () => {
  const svc = mkAll({ config: configWith({ rate_limit_per_claimant_day: 2, registry_rate_limit_per_day: 1 }) });
  const c1 = svc.claims.fileClaim(mkClaim({ items: [{ listing_ref: "l1" }] }), T0);
  const c2 = svc.claims.fileClaim(mkClaim({ items: [{ listing_ref: "l2" }] }), at(1));
  const c3 = svc.claims.fileClaim(mkClaim({ items: [{ listing_ref: "l3" }] }), at(2));
  assert.equal((c1 as { rate_limited_chip: boolean }).rate_limited_chip, false);
  assert.equal((c2 as { rate_limited_chip: boolean }).rate_limited_chip, false);
  assert.equal((c3 as { rate_limited_chip: boolean }).rate_limited_chip, true); // third same-day filing trips
  const chipClaim = (c3 as { claim: { id: string } }).claim.id;
  assert.ok(svc.claims.claimEvents(chipClaim).some((e) => e.type === "rate_limited"));
  // the filing STILL went through: never block filing outright
  assert.equal(svc.claims.claim(chipClaim)!.state, "under_review");

  // a registry entry tightens the limit to 1/day but never blocks
  const hash = svc.claims.contactHashOf(svc.claims.claim(chipClaim)!);
  svc.registry.add(hash, "policy §4.2", "rev_1", "sig", at(3));
  const c4 = svc.claims.fileClaim(mkClaim({ items: [{ listing_ref: "l4" }] }), at(4));
  assert.equal((c4 as { rate_limited_chip: boolean }).rate_limited_chip, true);
  assert.equal((c4 as { registry_chip: boolean }).registry_chip, true);
  assert.equal(svc.claims.claim((c4 as { claim: { id: string } }).claim.id)!.state, "under_review");
});

test("multi-listing claim: per-item measures, mixed outcomes, closes on last decision", () => {
  const svc = mkAll({ config: delistAll() });
  const out = svc.claims.fileClaim(
    mkClaim({ items: [{ listing_ref: "m1" }, { listing_ref: "m2" }, { listing_ref: "m3" }] }),
    T0,
  );
  if (out.kind !== "filed") throw new Error("expected filed");
  const [i1, i2, i3] = out.claim.items;
  assert.equal(svc.marketplace.delisted.size, 3); // per-item provisional delists

  svc.claims.requestEvidence(out.claim.id, i1, "similarity_report", "rev_1", at(1));
  svc.claims.requestEvidence(out.claim.id, i2, "provenance_lookup", "rev_1", at(1));
  svc.claims.decideItem(out.claim.id, i1, "rejected", "not similar", "rev_1", "s1", at(2));
  assert.equal(svc.claims.claim(out.claim.id)!.state, "decided"); // first decision
  assert.equal(svc.claims.claim(out.claim.id)!.state !== "closed", true);
  svc.claims.decideItem(out.claim.id, i2, "rejected", "house template base", "rev_1", "s2", at(3), { provenance_shortcut: true });
  assert.ok(!svc.marketplace.delisted.has("m1"));
  assert.ok(!svc.marketplace.delisted.has("m2"));
  assert.ok(svc.marketplace.delisted.has("m3")); // m3 still delisted, claim open
  svc.claims.requestEvidence(out.claim.id, i3, "similarity_report", "rev_1", at(4));
  svc.claims.decideItem(out.claim.id, i3, "upheld", "substantially similar", "rev_1", "s3", at(5));
  // mixed outcome closes as upheld_delisted (an upheld item dominates)
  const claim = svc.claims.claim(out.claim.id)!;
  assert.equal(claim.state, "closed");
  const closed = svc.claims.claimEvents(out.claim.id).find((e) => e.type === "claim_closed");
  assert.equal((closed?.payload as { outcome: string }).outcome, "upheld_delisted");
  assert.ok(svc.marketplace.delisted.has("m3"));
  void i2;
});

test("a claim against an already-delisted listing needs no provisional measure", () => {
  const svc = mkAll({ config: delistAll() });
  svc.marketplace.delisted.add("already_gone");
  const out = svc.claims.fileClaim(mkClaim({ items: [{ listing_ref: "already_gone" }] }), T0);
  if (out.kind !== "filed") throw new Error("expected filed");
  const events = svc.claims.claimEvents(out.claim.id);
  const delist = events.filter((e) => e.type === "provisional_delisted");
  assert.equal(delist.length, 0); // no second delist
  const notify = events.find((e) => e.type === "provisional_notify_only");
  assert.equal((notify?.payload as { reason?: string }).reason, "listing already delisted");
});

test("escalation pauses the clock; counsel return resumes and the claim can close", () => {
  const svc = mkAll();
  const out = svc.claims.fileClaim(mkClaim(), T0);
  if (out.kind !== "filed") throw new Error("expected filed");
  const item = out.claim.items[0];
  svc.claims.requestEvidence(out.claim.id, item, "chain_of_title", "rev_1", at(1));
  svc.claims.decideItem(out.claim.id, item, "escalated", "contested-territory ip, substantiated", "rev_1", "s1", at(2));
  assert.equal(svc.claims.claim(out.claim.id)!.state, "escalated_counsel");
  assert.ok(svc.claims.claimEvents(out.claim.id).some((e) => e.type === "counsel_clock_paused"));
  // counsel owns posture; nothing mechanical fires while paused
  svc.claims.counselReturn(out.claim.id, "counsel_1", at(600));
  assert.ok(svc.claims.claimEvents(out.claim.id).some((e) => e.type === "counsel_clock_resumed"));
  // the reviewer re-decides after counsel: the item is escalated, a
  // new claim decision path would be reopen; here the claim closes
  // escalated once every item is terminal
  assert.equal(svc.claims.claim(out.claim.id)!.state, "closed");
  const closed = svc.claims.claimEvents(out.claim.id).find((e) => e.type === "claim_closed");
  assert.equal((closed?.payload as { outcome: string }).outcome, "escalated_counsel");
});

test("time-to-decision subtracts the counsel pause exactly", () => {
  const svc = mkAll();
  // two items: one escalates (pausing the clock at 10min), counsel
  // returns at 610min, the second item decides at 700min. wall time
  // to decision is 700min; the pause interval (600min) subtracts
  // exactly, so time-to-decision measures 100min.
  const out = svc.claims.fileClaim(
    mkClaim({ items: [{ listing_ref: "p1" }, { listing_ref: "p2" }] }),
    T0,
  );
  if (out.kind !== "filed") throw new Error("expected filed");
  const [i1, i2] = out.claim.items;
  svc.claims.requestEvidence(out.claim.id, i1, "chain_of_title", "rev_1", at(1));
  svc.claims.decideItem(out.claim.id, i1, "escalated", "counsel first", "rev_1", "s1", at(10));
  assert.ok(svc.claims.claimEvents(out.claim.id).some((e) => e.type === "counsel_clock_paused"));
  svc.claims.counselReturn(out.claim.id, "counsel_1", at(610));
  assert.ok(svc.claims.claimEvents(out.claim.id).some((e) => e.type === "counsel_clock_resumed"));
  svc.claims.requestEvidence(out.claim.id, i2, "similarity_report", "rev_1", at(611));
  svc.claims.decideItem(out.claim.id, i2, "rejected", "not similar", "rev_1", "s2", at(700));
  assert.equal(svc.claims.claim(out.claim.id)!.state, "closed");
  const report = measure(svc.claims, svc.inquiries, svc.config, svc.marketplace.listingCount(), T0, day(2));
  assert.equal(report.median_minutes_to_decision_counsel_paused, 100);
  assert.equal(report.escalated_items, 1);
  assert.equal(report.substantiation_rate, 0); // one merits decision, zero upheld
});

test("reopen links within 30 days, and throws past the window", () => {
  const svc = mkAll();
  const out = svc.claims.fileClaim(mkClaim(), T0);
  if (out.kind !== "filed") throw new Error("expected filed");
  const item = out.claim.items[0];
  svc.claims.requestEvidence(out.claim.id, item, "similarity_report", "rev_1", at(1));
  svc.claims.decideItem(out.claim.id, item, "rejected", "not similar", "rev_1", "s1", at(2));
  assert.equal(svc.claims.claim(out.claim.id)!.state, "closed");
  const reopened = svc.claims.reopenClaim(out.claim.id, day(29));
  assert.equal(reopened.reopened_from, out.claim.id);
  assert.equal(reopened.state, "under_review");
  assert.equal(svc.claims.claimEvents(reopened.id).some((e) => e.type === "claim_reopened"), true);
  assert.throws(() => svc.claims.reopenClaim(out.claim.id, day(31)));
});

test("the inquiry fork deflects, queues, and hands off without ever filing", () => {
  const svc = mkAll({
    contentAnswers: [{ doc_id: "prov_1", url: "https://docs.sculptura.com/provenance" }],
    contentMatch: (q) => q.includes("provenance"),
  });
  const d1 = svc.inquiries.askQuestion({ question_text: "what is provenance?", locale: "en-US", market: "US" }, T0);
  assert.equal(d1.deflected, true); // answered by public content
  const d2 = svc.inquiries.askQuestion({ question_text: "my unique weird situation?", locale: "en-US", market: "US", contact: "x@example.com" }, at(1));
  assert.equal(d2.deflected, false);
  assert.equal(svc.inquiries.openQuestions().length, 1);
  // a question that is really a claim gets the form link, nothing auto-files
  svc.inquiries.answerQuestion(d2.inquiry.id, "this sounds like a claim; the form is here", "rev_1", at(2), { claim_form: true });
  const ans = svc.inquiries.eventsOf(d2.inquiry.id).find((e) => e.type === "question_answered");
  assert.equal((ans?.payload as { referred_to_claim_form: boolean }).referred_to_claim_form, true);
  assert.equal(svc.claims.claimIds().length, 0); // still zero claims
  const report = measure(svc.claims, svc.inquiries, svc.config, svc.marketplace.listingCount(), T0, day(1));
  assert.equal(report.fork.questions_asked, 2);
  assert.equal(report.fork.deflection_rate, 0.5);
  assert.equal(report.fork.referral_to_claim_rate, 1);
  assert.equal(report.claim_volume, 0);
});

test("counsel-triage types route to the counsel-facing reviewer set", () => {
  const svc = mkAll();
  svc.review.addReviewer({
    id: "rev_std",
    counsel: false,
    handles: [{ claim_type: "ip_infringement", market: "US", language: "en-US" }],
  });
  svc.review.addReviewer({
    id: "counsel_triage",
    counsel: true,
    handles: [{ claim_type: "trademark_or_publicity", market: "US", language: "en-US" }],
  });
  const ip = svc.claims.fileClaim(mkClaim({ items: [{ listing_ref: "r1" }] }), T0);
  if (ip.kind !== "filed") throw new Error("expected filed");
  assert.equal(svc.review.assignClaim(ip.claim.id, at(1)), "rev_std");
  const tm = svc.claims.fileClaim(
    mkClaim({
      claim_type: "trademark_or_publicity",
      claimant: { ...mkClaim().claimant, contact_value: "tm@example.com" },
      items: [{ listing_ref: "r2" }],
    }),
    at(2),
  );
  if (tm.kind !== "filed") throw new Error("expected filed");
  assert.equal(svc.review.assignClaim(tm.claim.id, at(3)), "counsel_triage");
  // wrong market: nobody matches, the claim stays queued
  const de = svc.claims.fileClaim(
    mkClaim({
      market: "DE",
      claimant: { ...mkClaim().claimant, contact_value: "de@example.com" },
      items: [{ listing_ref: "r3" }],
    }),
    at(4),
  );
  if (de.kind !== "filed") throw new Error("expected filed");
  assert.equal(svc.review.assignClaim(de.claim.id, at(5)), null);
});

test("a studio cease-and-desist is a legal_notice claim: takedown on intake (ruled), counsel review, separate measurement", () => {
  const svc = mkAll(); // the shipped ruling: legal notices delist, individuals notify
  svc.review.addReviewer({
    id: "rev_std",
    counsel: false,
    handles: [{ claim_type: "ip_infringement", market: "US", language: "en-US" }],
  });
  svc.review.addReviewer({
    id: "counsel_triage",
    counsel: true,
    handles: [{ claim_type: "ip_infringement", market: "US", language: "en-US" }],
  });

  const studio = svc.claims.fileClaim(
    mkClaim({
      claimant_class: "legal_notice",
      claimant: {
        name: "Meridian Studio",
        contact_channel: "email",
        contact_value: "counsel@meridian.example",
        statement_of_rights: "Meridian holds the copyright in the referenced work",
        attestation: fullAttestation, // ignored for legal notices
      },
      legal_notice: {
        notice_ref: "C&D-2026-114",
        representation: "Feld & Associates",
        response_deadline: day(10),
      },
      items: [{ listing_ref: "studio_case" }],
    }),
    T0,
  );
  if (studio.kind !== "filed") throw new Error("expected filed");
  const claim = studio.claim;
  assert.equal(claim.claimant_class, "legal_notice");
  assert.equal(claim.legal_notice?.notice_ref, "C&D-2026-114");

  // the ruling (14.1): a facially complete notice naming a
  // listing takes it down on intake, redbubble-style - reversible,
  // logged, creator notified
  assert.equal(svc.marketplace.delisted.has("studio_case"), true);
  const delistEv = svc.claims.claimEvents(claim.id).find((e) => e.type === "provisional_delisted");
  const dp = delistEv?.payload as { item_ref: string; port_ref: string };
  assert.ok(dp.port_ref.startsWith("mp_delist_"));
  assert.ok(svc.claims.claimEvents(claim.id).some((e) => e.type === "creator_notified"));
  // an individual artist in the same window stays up: review posture
  const solo = svc.claims.fileClaim(mkClaim({ items: [{ listing_ref: "solo_stays_up" }] }), at(1));
  if (solo.kind !== "filed") throw new Error("expected filed");
  assert.equal(svc.marketplace.delisted.has("solo_stays_up"), false);
  assert.ok(svc.claims.claimEvents(solo.claim.id).some((e) => e.type === "provisional_notify_only"));
  // and the standard reviewer set is skipped for the notice: counsel from intake
  assert.equal(svc.review.assignClaim(claim.id, at(1)), "counsel_triage");

  // the response deadline is a chip in the reviewer view, never a trigger
  const view = svc.claims.reviewerView(claim.id);
  assert.equal(view.counsel_triage, true);
  assert.equal((view as { legal_notice: { response_deadline: string } }).legal_notice.response_deadline, day(10));

  // counsel upholds: the delist stands, the counter-notice window
  // is exposed, and the ladder is fed exactly like an individual
  // claim's - same signed record, same enforcement event
  const itemId = claim.items[0];
  svc.claims.requestEvidence(claim.id, itemId, "similarity_report", "counsel_triage", at(3));
  const decision = svc.claims.decideItem(claim.id, itemId, "upheld", "the listing reproduces the noticed work", "counsel_triage", "sig:counsel:upheld", at(4));
  assert.ok(svc.claims.claimEvents(claim.id).some((e) => e.type === "enforcement_step_signed"));
  assert.ok(decision.signature.includes("counsel"));
  assert.equal(svc.claims.item(itemId)!.overlay, "upheld_pending_counter");
  // a rejected notice restores as loudly as it delisted
  const notice2 = svc.claims.fileClaim(
    mkClaim({
      claimant_class: "legal_notice",
      claimant: { ...mkClaim().claimant, contact_value: "counsel2@meridian.example", name: "Meridian Studio 2" },
      legal_notice: { notice_ref: "C&D-2026-115", representation: "Feld & Associates" },
      items: [{ listing_ref: "studio_case_2" }],
    }),
    at(5),
  );
  if (notice2.kind !== "filed") throw new Error("expected filed");
  const item2 = notice2.claim.items[0];
  assert.ok(svc.marketplace.delisted.has("studio_case_2")); // ruled takedown
  svc.claims.requestEvidence(notice2.claim.id, item2, "similarity_report", "counsel_triage", at(6));
  svc.claims.decideItem(notice2.claim.id, item2, "rejected", "the claim names the wrong design", "counsel_triage", "sig:counsel:rej", at(7));
  assert.equal(svc.marketplace.delisted.has("studio_case_2"), false);
  assert.ok(svc.claims.claimEvents(notice2.claim.id).some((e) => e.type === "provisional_restored"));

  // measurement splits by class: studio notices and artist claims
  // never muddy each other's numbers
  const individual = svc.claims.fileClaim(mkClaim({ items: [{ listing_ref: "solo_case" }] }), at(8));
  if (individual.kind !== "filed") throw new Error("expected filed");
  svc.claims.requestEvidence(individual.claim.id, individual.claim.items[0], "provenance_lookup", "rev_1", at(9));
  svc.claims.decideItem(individual.claim.id, individual.claim.items[0], "rejected", "house template", "rev_1", "sig:1", at(10), { provenance_shortcut: true });
  const report = measure(svc.claims, svc.inquiries, svc.config, svc.marketplace.listingCount(), T0, day(2));
  assert.equal(report.by_class.legal_notice.claim_volume, 2);
  assert.equal(report.by_class.legal_notice.substantiation_rate, 0.5); // one upheld, one rejected
  assert.equal(report.by_class.individual_artist.claim_volume, 2); // solo_stays_up + solo_case
  assert.equal(report.claim_volume, 4); // blended stays available
});

test("a legal notice without its required elements bounces with the notice-specific list", () => {
  const svc = mkAll();
  const out = svc.claims.fileClaim(
    mkClaim({ claimant_class: "legal_notice", legal_notice: { notice_ref: "", representation: "" } }),
    T0,
  );
  assert.equal(out.kind, "bounced");
  if (out.kind === "bounced") {
    assert.ok(out.missing.some((m) => m.includes("legal notice reference")));
    assert.ok(out.missing.some((m) => m.includes("representation")));
    // the attestation elements are NOT demanded of a legal notice
    assert.ok(!out.missing.some((m) => m.includes("perjury")));
    assert.ok(!out.missing.some((m) => m.includes("retained in-platform")));
  }
});
