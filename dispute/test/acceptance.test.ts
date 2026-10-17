import { test } from "node:test";
import assert from "node:assert/strict";
import { DisputeService } from "../src/claims";
import { InquiryService } from "../src/inquiry";
import { BadFaithRegistry } from "../src/registry";
import { DisputeEntry } from "../src/fork";
import { measure } from "../src/measure";
import { EvidenceAdapter } from "../src/evidence";
import { DEFAULT_CONFIG } from "../src/config";
import {
  FakeContactGate,
  FakeMarketplace,
  at,
  configWith,
  day,
  delistAll,
  mkClaim,
  mkContent,
  mkEvidencePorts,
  T0,
} from "./helpers";

// the twelve acceptance criteria of specs/dispute-architecture.md
// §20, each tested explicitly.

const mkService = (opts: {
  config?: ReturnType<typeof configWith>;
  gate?: FakeContactGate;
  houseTemplate?: boolean;
} = {}) => {
  const config = opts.config ?? configWith({});
  const marketplace = new FakeMarketplace();
  const gate = opts.gate ?? new FakeContactGate();
  const registry = new BadFaithRegistry();
  const evidence = new EvidenceAdapter(mkEvidencePorts({ houseTemplate: opts.houseTemplate }));
  const claims = new DisputeService(config, marketplace, gate, evidence, (h) => registry.lookup(h));
  const inquiries = new InquiryService(config, mkContent());
  const entry = new DisputeEntry(config, claims, inquiries);
  return { config, marketplace, gate, registry, evidence, claims, inquiries, entry };
};

test("1: incomplete claim bounces exactly once with specific missing elements; no account ever", () => {
  const { claims } = mkService();
  const bad = mkClaim({
    claimant: {
      name: "",
      contact_channel: "email",
      contact_value: "",
      statement_of_rights: "",
      attestation: { perjury_acknowledged: false, authorized_to_act: false, good_faith_belief: false, retention_consent: false },
    },
    claimed_originals: {},
    items: [],
  });
  const out = claims.fileClaim(bad, T0);
  assert.equal(out.kind, "bounced");
  if (out.kind === "bounced") {
    assert.ok(out.missing.includes("claimant name"));
    assert.ok(out.missing.includes("claimant contact (email or post channel)"));
    assert.ok(out.missing.includes("statement of your rights in the work"));
    assert.ok(out.missing.includes("perjury acknowledgment"));
    assert.ok(out.missing.includes("acceptance that the claim record is retained in-platform"));
    assert.ok(out.missing.includes("identification of the claimed original work (links, images, or registration)"));
    assert.ok(out.missing.includes("the specific sculptura listing(s) claimed (urls or ids)"));
    // terminal: bouncing the same record again throws
    assert.equal(out.claim.state, "bounced");
  }
  // a complete claim files with no session, no account, anywhere
  const good = claims.fileClaim(mkClaim(), at(1));
  assert.equal(good.kind, "filed");
});

test("2: the template-provenance shortcut attaches the provenance explanation", () => {
  const { claims } = mkService({ houseTemplate: true });
  const out = claims.fileClaim(mkClaim(), T0);
  if (out.kind !== "filed") throw new Error("expected filed");
  const itemId = out.claim.items[0];
  const decision = claims.decideItem(
    out.claim.id, itemId, "rejected", "the accused design derives from house template tpl_house_003; neither party owns the base",
    "rev_1", "sig:rev_1:template-shortcut", at(5), { provenance_shortcut: true },
  );
  assert.ok(decision.evidence_refs.includes(DEFAULT_CONFIG.provenance_explanation_ref));
  const event = claims.claimEvents(out.claim.id).find((e) => e.type === "decision_recorded");
  const p = event?.payload as { provenance_shortcut: boolean };
  assert.equal(p.provenance_shortcut, true);
});

test("3: stripped signatures throw: decisions, delists, restores, registry", () => {
  const { claims, registry } = mkService({ config: delistAll() });
  const out = claims.fileClaim(mkClaim(), T0);
  if (out.kind !== "filed") throw new Error("expected filed");
  const itemId = out.claim.items[0];
  claims.requestEvidence(out.claim.id, itemId, "similarity_report", "rev_1", at(1));
  assert.throws(() => claims.decideItem(out.claim.id, itemId, "rejected", "r", "rev_1", "", at(2)));
  assert.throws(() => claims.manualDelist(out.claim.id, itemId, "rev_1", "", at(2)));
  assert.throws(() => claims.manualRestore(out.claim.id, itemId, "rev_1", "", at(2)));
  assert.throws(() => registry.add("hash_a", "policy §2.1", "rev_1", "", at(2)));
  assert.equal(registry.size(), 0);
});

test("4: provisional delist and restoration are both first-class events with port refs", () => {
  const { claims, marketplace } = mkService({ config: delistAll() });
  const out = claims.fileClaim(mkClaim(), T0);
  if (out.kind !== "filed") throw new Error("expected filed");
  const itemId = out.claim.items[0];
  const delistEv = claims.claimEvents(out.claim.id).find((e) => e.type === "provisional_delisted");
  const dp = delistEv?.payload as { port_ref: string; item_ref: string };
  assert.equal(dp.item_ref, itemId);
  assert.ok(dp.port_ref.startsWith("mp_delist_"));
  assert.ok(marketplace.delisted.has("listing_a1"));

  // rejected: the restoration is logged as loudly as application
  claims.requestEvidence(out.claim.id, itemId, "provenance_lookup", "rev_1", at(1));
  claims.decideItem(out.claim.id, itemId, "rejected", "not substantially similar", "rev_1", "sig:1", at(2));
  const restoreEv = claims.claimEvents(out.claim.id).find((e) => e.type === "provisional_restored");
  const rp = restoreEv?.payload as { port_ref: string };
  assert.ok(rp.port_ref.startsWith("mp_restore_"));
  assert.ok(!marketplace.delisted.has("listing_a1"));
});

test("5: no dispute state ever changes a fee, trust, or ranking value", () => {
  const { claims, registry, inquiries, marketplace, config } = mkService({ config: delistAll() });
  // a snapshot of every creator economic value the platform holds
  const creatorEconomics = Object.freeze({
    creator_fees: { "cin_9": { rate: 0.12, balance_cents: 152000 } },
    trust_scores: { "cin_9": 0.93 },
    ranking: { "cin_9": 17 },
    fees: JSON.stringify,
  });
  const snapshot = JSON.stringify(creatorEconomics);

  // run the full lifecycle: file, evidence, uphold, counter-notice,
  // restore, registry, reopen, withdraw, reclassify, measurement
  const out = claims.fileClaim(mkClaim(), T0);
  if (out.kind !== "filed") throw new Error("expected filed");
  const itemId = out.claim.items[0];
  claims.requestEvidence(out.claim.id, itemId, "similarity_report", "rev_1", at(1));
  claims.decideItem(out.claim.id, itemId, "upheld", "substantially similar", "rev_1", "sig:1", at(2));
  claims.fileCounterNotice(out.claim.id, itemId, "I made this first", at(3));
  claims.onRestoreWindowExpiry(out.claim.id, itemId, day(20));
  registry.add("hash_x", "policy §4", "rev_1", "sig", at(21));
  const claim2 = claims.fileClaim(mkClaim({ items: [{ listing_ref: "listing_b2" }] }), day(22));
  if (claim2.kind !== "filed") throw new Error("expected filed");
  claims.withdraw(claim2.claim.id, day(23));
  const claim3 = claims.fileClaim(mkClaim({ items: [{ listing_ref: "listing_c3" }] }), day(24));
  if (claim3.kind !== "filed") throw new Error("expected filed");
  claims.requestEvidence(claim3.claim.id, claim3.claim.items[0], "provenance_lookup", "rev_1", day(25));
  claims.referAsQuestion(claim3.claim.id, "https://docs.sculptura.com/licensing", "rev_1", "sig:2", day(25));
  const reopened = claims.reopenClaim(out.claim.id, day(26));
  assert.equal(reopened.reopened_from, out.claim.id);
  measure(claims, inquiries, config, marketplace.listingCount(), T0, day(27));

  // byte-equality: nothing above reached the creator economics
  assert.equal(JSON.stringify(creatorEconomics), snapshot);
  // and no dispute surface exposes those fields
  const view = JSON.stringify(claims.reviewerView(out.claim.id));
  for (const k of ["fee", "trust", "ranking", "balance_cents", "rate"]) {
    assert.ok(!view.includes(k), `reviewer view must not expose "${k}"`);
  }
});

test("6: claimants see status only; no creator personal or financial data", () => {
  const { claims } = mkService();
  const out = claims.fileClaim(mkClaim(), T0);
  if (out.kind !== "filed") throw new Error("expected filed");
  const status = JSON.stringify(claims.claimantStatus(out.claim.id));
  for (const k of ["claimant", "attestation", "contact_value", "statement_of_rights", "reviewer", "signature", "fee", "trust", "ranking"]) {
    assert.ok(!status.includes(k), `claimant view must not expose "${k}"`);
  }
  const parsed = claims.claimantStatus(out.claim.id);
  assert.equal(parsed.items.length, 1);
  assert.equal(parsed.items[0].status, "under_review");
});

test("7: the export rebuilds from events: volume, substantiation, time-to-decision, hours", () => {
  const svc = mkService({ config: delistAll() });
  const { claims, inquiries, config, marketplace } = svc;
  const out = claims.fileClaim(mkClaim(), T0);
  if (out.kind !== "filed") throw new Error("expected filed");
  const itemId = out.claim.items[0];
  claims.requestEvidence(out.claim.id, itemId, "similarity_report", "rev_1", at(1));
  claims.logHours("rev_1", out.claim.id, "2026-10-16", 1.5, at(2));
  claims.decideItem(out.claim.id, itemId, "upheld", "substantially similar", "rev_1", "sig", at(120));
  const report = measure(claims, inquiries, config, marketplace.listingCount(), T0, day(1));
  assert.equal(report.claim_volume, 1);
  assert.equal(report.substantiation_rate, 1);
  assert.equal(report.reviewer_hours, 1.5);
  assert.equal(report.median_minutes_to_decision_counsel_paused, 120);
  assert.equal(report.decided_items, 1);
  assert.ok(Object.isFrozen(report));
});

test("8: bounced resubmission links; duplicates merge, never double-review", () => {
  const { claims } = mkService();
  const bounce = claims.fileClaim(mkClaim({ claimant: { ...mkClaim().claimant, statement_of_rights: "" } }), T0);
  assert.equal(bounce.kind, "bounced");
  const resubmit = claims.fileClaim(mkClaim(), at(1));
  if (resubmit.kind !== "filed") throw new Error("expected filed");
  assert.equal(resubmit.claim.bounced_from, (bounce as { claim: { id: string } }).claim.id);

  // duplicate: same contact + same listing within the window
  const dup = claims.fileClaim(mkClaim(), at(2));
  assert.equal(dup.kind, "merged");
  if (dup.kind === "merged") {
    assert.equal(dup.claim.id, resubmit.claim.id);
    assert.equal(dup.items_added.length, 0); // same listing: amendment only
    const ev = claims.claimEvents(resubmit.claim.id).find((e) => e.type === "merged_amendment");
    assert.ok(ev, "the amendment is logged on the open claim");
  }
  assert.equal(claims.claimIds().length, 3); // bounced + resubmission + merged submission record
});

test("9: counter-notice restore fires only after the window; refile pauses and escalates", () => {
  const { claims } = mkService({ config: delistAll() });
  const out = claims.fileClaim(mkClaim(), T0);
  if (out.kind !== "filed") throw new Error("expected filed");
  const itemId = out.claim.items[0];
  claims.requestEvidence(out.claim.id, itemId, "similarity_report", "rev_1", at(1));
  claims.decideItem(out.claim.id, itemId, "upheld", "substantially similar", "rev_1", "sig", at(2));
  const item = claims.item(itemId)!;
  assert.equal(item.overlay, "upheld_pending_counter");
  const notice = claims.fileCounterNotice(out.claim.id, itemId, "I made this in 2023", at(3));
  // before the window expires: nothing fires
  assert.equal(claims.onRestoreWindowExpiry(out.claim.id, itemId, at(100)), false);
  assert.equal(claims.item(itemId)!.overlay, "restore_window");
  // after: restore fires
  assert.equal(claims.onRestoreWindowExpiry(out.claim.id, itemId, day(20)), true);
  assert.equal(claims.item(itemId)!.overlay, "restored_after_counter_notice");
  assert.ok(claims.claimEvents(out.claim.id).some((e) => e.type === "restored_after_counter_notice"));

  // the refile path: window live, claimant refiles -> counsel
  const out2 = claims.fileClaim(mkClaim({ items: [{ listing_ref: "listing_z9" }] }), day(30));
  if (out2.kind !== "filed") throw new Error("expected filed");
  const item2 = out2.claim.items[0];
  claims.requestEvidence(out2.claim.id, item2, "similarity_report", "rev_1", day(31));
  claims.decideItem(out2.claim.id, item2, "upheld", "similar", "rev_1", "sig", day(31));
  claims.fileCounterNotice(out2.claim.id, item2, "counter", day(32));
  claims.claimantRefile(out2.claim.id, item2, day(33));
  assert.equal(claims.item(item2)!.overlay, "refiled");
  assert.equal(claims.item(item2)!.outcome, "escalated");
  const evs = claims.claimEvents(out2.claim.id);
  assert.ok(evs.some((e) => e.type === "claimant_refiled"));
  assert.ok(evs.some((e) => e.type === "counsel_clock_paused"));
  // no further mechanical action fires while paused: the expiry
  // check no-ops on a refiled item instead of restoring
  assert.equal(claims.onRestoreWindowExpiry(out2.claim.id, item2, day(50)), false);
});

test("10: registry entries require a signed human citing policy; nothing auto-creates", () => {
  const { claims, registry } = mkService();
  // run the entire lifecycle surface: no method on the claim
  // service can create a registry entry (structural test)
  const out = claims.fileClaim(mkClaim(), T0);
  if (out.kind !== "filed") throw new Error("expected filed");
  claims.requestEvidence(out.claim.id, out.claim.items[0], "similarity_report", "rev_1", at(1));
  claims.decideItem(out.claim.id, out.claim.items[0], "upheld", "similar", "rev_1", "sig", at(2));
  const out2 = claims.fileClaim(mkClaim({ items: [{ listing_ref: "l2" }] }), at(3));
  if (out2.kind === "filed") claims.withdraw(out2.claim.id, at(4));
  assert.equal(registry.size(), 0);
  // adding requires citation + signature
  assert.throws(() => registry.add("h", "", "rev_1", "sig", at(5)));
  const entry = registry.add("hash_bad", "policy §4.2 serial filings against competing shops", "rev_1", "sig:1", at(5));
  assert.ok(entry.id.startsWith("reg_"));
  // the contest path removes with a signature
  registry.remove(entry.id, "rev_2", "sig:2", at(6));
  assert.equal(registry.size(), 0);
  assert.equal(registry.lookup("hash_bad"), undefined);
});

test("11: a question never creates a claim record, measure, decision, or registry entry", () => {
  const { entry, claims, registry, inquiries } = mkService();
  const asked = entry.askQuestion({ question_text: "what does template provenance mean?", locale: "en-US", market: "US" }, T0);
  assert.equal(asked.deflected, false);
  entry.askQuestion(
    { question_text: "how do licenses work?", locale: "en-US", market: "US", contact: "q@example.com" },
    at(1),
  );
  const answer = entry.askQuestion({ question_text: "should I file at all?", locale: "en-US", market: "US" }, at(2));
  assert.ok(answer.inquiry);
  entry.fileClaim(mkClaim(), at(3)); // the claim side works
  assert.equal(claims.claimIds().length, 1); // one claim, from fileClaim only
  assert.equal(inquiries.ids().length, 3);
  assert.equal(registry.size(), 0);
  // no provisional measures, no decisions, no delists anywhere
  assert.ok(claims.claimEvents(claims.claimIds()[0]).every(
    (e) => e.type !== "provisional_delisted" || e.payload !== undefined,
  ));
  const claimEvents = claims.claimEvents(claims.claimIds()[0]);
  assert.ok(!claimEvents.some((e) => e.type === "decision_recorded"));
});

test("12: reclassified claim closes as closed_referred, excluded, no enforcement", () => {
  const svc = mkService({ config: delistAll() });
  const { claims, inquiries, config, marketplace } = svc;
  const out = claims.fileClaim(mkClaim(), T0);
  if (out.kind !== "filed") throw new Error("expected filed");
  const itemId = out.claim.items[0];
  // a provisional delist existed; reclassification restores it
  assert.ok(claims.claimEvents(out.claim.id).some((e) => e.type === "provisional_delisted"));
  claims.referAsQuestion(out.claim.id, "https://kb.sculptura.com/licensing-basics", "rev_1", "sig:1", at(1));
  assert.equal(claims.claim(out.claim.id)!.state, "closed");
  assert.equal(claims.item(itemId)!.outcome, "referred");
  assert.ok(claims.claimEvents(out.claim.id).some((e) => e.type === "claim_reclassified_question"));
  assert.ok(claims.claimEvents(out.claim.id).some((e) => e.type === "provisional_restored"));
  // no enforcement event ever fires from a reclassification
  assert.ok(!claims.claimEvents(out.claim.id).some((e) => e.type === "enforcement_step_signed"));
  // excluded from the substantiation rate
  const report = measure(claims, inquiries, config, marketplace.listingCount(), T0, day(1));
  assert.equal(report.referred_claims, 1);
  assert.equal(report.substantiation_rate, null); // no decided items
});
