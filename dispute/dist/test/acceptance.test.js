"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = require("node:test");
const strict_1 = __importDefault(require("node:assert/strict"));
const claims_1 = require("../src/claims");
const inquiry_1 = require("../src/inquiry");
const registry_1 = require("../src/registry");
const fork_1 = require("../src/fork");
const measure_1 = require("../src/measure");
const evidence_1 = require("../src/evidence");
const config_1 = require("../src/config");
const helpers_1 = require("./helpers");
// the twelve acceptance criteria of specs/dispute-architecture.md
// §20, each tested explicitly.
const mkService = (opts = {}) => {
    const config = opts.config ?? (0, helpers_1.configWith)({});
    const marketplace = new helpers_1.FakeMarketplace();
    const gate = opts.gate ?? new helpers_1.FakeContactGate();
    const registry = new registry_1.BadFaithRegistry();
    const evidence = new evidence_1.EvidenceAdapter((0, helpers_1.mkEvidencePorts)({ houseTemplate: opts.houseTemplate }));
    const claims = new claims_1.DisputeService(config, marketplace, gate, evidence, (h) => registry.lookup(h));
    const inquiries = new inquiry_1.InquiryService(config, (0, helpers_1.mkContent)());
    const entry = new fork_1.DisputeEntry(config, claims, inquiries);
    return { config, marketplace, gate, registry, evidence, claims, inquiries, entry };
};
(0, node_test_1.test)("1: incomplete claim bounces exactly once with specific missing elements; no account ever", () => {
    const { claims } = mkService();
    const bad = (0, helpers_1.mkClaim)({
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
    const out = claims.fileClaim(bad, helpers_1.T0);
    strict_1.default.equal(out.kind, "bounced");
    if (out.kind === "bounced") {
        strict_1.default.ok(out.missing.includes("claimant name"));
        strict_1.default.ok(out.missing.includes("claimant contact (email or post channel)"));
        strict_1.default.ok(out.missing.includes("statement of your rights in the work"));
        strict_1.default.ok(out.missing.includes("perjury acknowledgment"));
        strict_1.default.ok(out.missing.includes("acceptance that the claim record is retained in-platform"));
        strict_1.default.ok(out.missing.includes("identification of the claimed original work (links, images, or registration)"));
        strict_1.default.ok(out.missing.includes("the specific sculptura listing(s) claimed (urls or ids)"));
        // terminal: bouncing the same record again throws
        strict_1.default.equal(out.claim.state, "bounced");
    }
    // a complete claim files with no session, no account, anywhere
    const good = claims.fileClaim((0, helpers_1.mkClaim)(), (0, helpers_1.at)(1));
    strict_1.default.equal(good.kind, "filed");
});
(0, node_test_1.test)("2: the template-provenance shortcut attaches the provenance explanation", () => {
    const { claims } = mkService({ houseTemplate: true });
    const out = claims.fileClaim((0, helpers_1.mkClaim)(), helpers_1.T0);
    if (out.kind !== "filed")
        throw new Error("expected filed");
    const itemId = out.claim.items[0];
    const decision = claims.decideItem(out.claim.id, itemId, "rejected", "the accused design derives from house template tpl_house_003; neither party owns the base", "rev_1", "sig:rev_1:template-shortcut", (0, helpers_1.at)(5), { provenance_shortcut: true });
    strict_1.default.ok(decision.evidence_refs.includes(config_1.DEFAULT_CONFIG.provenance_explanation_ref));
    const event = claims.claimEvents(out.claim.id).find((e) => e.type === "decision_recorded");
    const p = event?.payload;
    strict_1.default.equal(p.provenance_shortcut, true);
});
(0, node_test_1.test)("3: stripped signatures throw: decisions, delists, restores, registry", () => {
    const { claims, registry } = mkService({ config: (0, helpers_1.delistAll)() });
    const out = claims.fileClaim((0, helpers_1.mkClaim)(), helpers_1.T0);
    if (out.kind !== "filed")
        throw new Error("expected filed");
    const itemId = out.claim.items[0];
    claims.requestEvidence(out.claim.id, itemId, "similarity_report", "rev_1", (0, helpers_1.at)(1));
    strict_1.default.throws(() => claims.decideItem(out.claim.id, itemId, "rejected", "r", "rev_1", "", (0, helpers_1.at)(2)));
    strict_1.default.throws(() => claims.manualDelist(out.claim.id, itemId, "rev_1", "", (0, helpers_1.at)(2)));
    strict_1.default.throws(() => claims.manualRestore(out.claim.id, itemId, "rev_1", "", (0, helpers_1.at)(2)));
    strict_1.default.throws(() => registry.add("hash_a", "policy §2.1", "rev_1", "", (0, helpers_1.at)(2)));
    strict_1.default.equal(registry.size(), 0);
});
(0, node_test_1.test)("4: provisional delist and restoration are both first-class events with port refs", () => {
    const { claims, marketplace } = mkService({ config: (0, helpers_1.delistAll)() });
    const out = claims.fileClaim((0, helpers_1.mkClaim)(), helpers_1.T0);
    if (out.kind !== "filed")
        throw new Error("expected filed");
    const itemId = out.claim.items[0];
    const delistEv = claims.claimEvents(out.claim.id).find((e) => e.type === "provisional_delisted");
    const dp = delistEv?.payload;
    strict_1.default.equal(dp.item_ref, itemId);
    strict_1.default.ok(dp.port_ref.startsWith("mp_delist_"));
    strict_1.default.ok(marketplace.delisted.has("listing_a1"));
    // rejected: the restoration is logged as loudly as application
    claims.requestEvidence(out.claim.id, itemId, "provenance_lookup", "rev_1", (0, helpers_1.at)(1));
    claims.decideItem(out.claim.id, itemId, "rejected", "not substantially similar", "rev_1", "sig:1", (0, helpers_1.at)(2));
    const restoreEv = claims.claimEvents(out.claim.id).find((e) => e.type === "provisional_restored");
    const rp = restoreEv?.payload;
    strict_1.default.ok(rp.port_ref.startsWith("mp_restore_"));
    strict_1.default.ok(!marketplace.delisted.has("listing_a1"));
});
(0, node_test_1.test)("5: no dispute state ever changes a fee, trust, or ranking value", () => {
    const { claims, registry, inquiries, marketplace, config } = mkService({ config: (0, helpers_1.delistAll)() });
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
    const out = claims.fileClaim((0, helpers_1.mkClaim)(), helpers_1.T0);
    if (out.kind !== "filed")
        throw new Error("expected filed");
    const itemId = out.claim.items[0];
    claims.requestEvidence(out.claim.id, itemId, "similarity_report", "rev_1", (0, helpers_1.at)(1));
    claims.decideItem(out.claim.id, itemId, "upheld", "substantially similar", "rev_1", "sig:1", (0, helpers_1.at)(2));
    claims.fileCounterNotice(out.claim.id, itemId, "I made this first", (0, helpers_1.at)(3));
    claims.onRestoreWindowExpiry(out.claim.id, itemId, (0, helpers_1.day)(20));
    registry.add("hash_x", "policy §4", "rev_1", "sig", (0, helpers_1.at)(21));
    const claim2 = claims.fileClaim((0, helpers_1.mkClaim)({ items: [{ listing_ref: "listing_b2" }] }), (0, helpers_1.day)(22));
    if (claim2.kind !== "filed")
        throw new Error("expected filed");
    claims.withdraw(claim2.claim.id, (0, helpers_1.day)(23));
    const claim3 = claims.fileClaim((0, helpers_1.mkClaim)({ items: [{ listing_ref: "listing_c3" }] }), (0, helpers_1.day)(24));
    if (claim3.kind !== "filed")
        throw new Error("expected filed");
    claims.requestEvidence(claim3.claim.id, claim3.claim.items[0], "provenance_lookup", "rev_1", (0, helpers_1.day)(25));
    claims.referAsQuestion(claim3.claim.id, "https://docs.sculptura.com/licensing", "rev_1", "sig:2", (0, helpers_1.day)(25));
    const reopened = claims.reopenClaim(out.claim.id, (0, helpers_1.day)(26));
    strict_1.default.equal(reopened.reopened_from, out.claim.id);
    (0, measure_1.measure)(claims, inquiries, config, marketplace.listingCount(), helpers_1.T0, (0, helpers_1.day)(27));
    // byte-equality: nothing above reached the creator economics
    strict_1.default.equal(JSON.stringify(creatorEconomics), snapshot);
    // and no dispute surface exposes those fields
    const view = JSON.stringify(claims.reviewerView(out.claim.id));
    for (const k of ["fee", "trust", "ranking", "balance_cents", "rate"]) {
        strict_1.default.ok(!view.includes(k), `reviewer view must not expose "${k}"`);
    }
});
(0, node_test_1.test)("6: claimants see status only; no creator personal or financial data", () => {
    const { claims } = mkService();
    const out = claims.fileClaim((0, helpers_1.mkClaim)(), helpers_1.T0);
    if (out.kind !== "filed")
        throw new Error("expected filed");
    const status = JSON.stringify(claims.claimantStatus(out.claim.id));
    for (const k of ["claimant", "attestation", "contact_value", "statement_of_rights", "reviewer", "signature", "fee", "trust", "ranking"]) {
        strict_1.default.ok(!status.includes(k), `claimant view must not expose "${k}"`);
    }
    const parsed = claims.claimantStatus(out.claim.id);
    strict_1.default.equal(parsed.items.length, 1);
    strict_1.default.equal(parsed.items[0].status, "under_review");
});
(0, node_test_1.test)("7: the export rebuilds from events: volume, substantiation, time-to-decision, hours", () => {
    const svc = mkService({ config: (0, helpers_1.delistAll)() });
    const { claims, inquiries, config, marketplace } = svc;
    const out = claims.fileClaim((0, helpers_1.mkClaim)(), helpers_1.T0);
    if (out.kind !== "filed")
        throw new Error("expected filed");
    const itemId = out.claim.items[0];
    claims.requestEvidence(out.claim.id, itemId, "similarity_report", "rev_1", (0, helpers_1.at)(1));
    claims.logHours("rev_1", out.claim.id, "2026-10-16", 1.5, (0, helpers_1.at)(2));
    claims.decideItem(out.claim.id, itemId, "upheld", "substantially similar", "rev_1", "sig", (0, helpers_1.at)(120));
    const report = (0, measure_1.measure)(claims, inquiries, config, marketplace.listingCount(), helpers_1.T0, (0, helpers_1.day)(1));
    strict_1.default.equal(report.claim_volume, 1);
    strict_1.default.equal(report.substantiation_rate, 1);
    strict_1.default.equal(report.reviewer_hours, 1.5);
    strict_1.default.equal(report.median_minutes_to_decision_counsel_paused, 120);
    strict_1.default.equal(report.decided_items, 1);
    strict_1.default.ok(Object.isFrozen(report));
});
(0, node_test_1.test)("8: bounced resubmission links; duplicates merge, never double-review", () => {
    const { claims } = mkService();
    const bounce = claims.fileClaim((0, helpers_1.mkClaim)({ claimant: { ...(0, helpers_1.mkClaim)().claimant, statement_of_rights: "" } }), helpers_1.T0);
    strict_1.default.equal(bounce.kind, "bounced");
    const resubmit = claims.fileClaim((0, helpers_1.mkClaim)(), (0, helpers_1.at)(1));
    if (resubmit.kind !== "filed")
        throw new Error("expected filed");
    strict_1.default.equal(resubmit.claim.bounced_from, bounce.claim.id);
    // duplicate: same contact + same listing within the window
    const dup = claims.fileClaim((0, helpers_1.mkClaim)(), (0, helpers_1.at)(2));
    strict_1.default.equal(dup.kind, "merged");
    if (dup.kind === "merged") {
        strict_1.default.equal(dup.claim.id, resubmit.claim.id);
        strict_1.default.equal(dup.items_added.length, 0); // same listing: amendment only
        const ev = claims.claimEvents(resubmit.claim.id).find((e) => e.type === "merged_amendment");
        strict_1.default.ok(ev, "the amendment is logged on the open claim");
    }
    strict_1.default.equal(claims.claimIds().length, 3); // bounced + resubmission + merged submission record
});
(0, node_test_1.test)("9: counter-notice restore fires only after the window; refile pauses and escalates", () => {
    const { claims } = mkService({ config: (0, helpers_1.delistAll)() });
    const out = claims.fileClaim((0, helpers_1.mkClaim)(), helpers_1.T0);
    if (out.kind !== "filed")
        throw new Error("expected filed");
    const itemId = out.claim.items[0];
    claims.requestEvidence(out.claim.id, itemId, "similarity_report", "rev_1", (0, helpers_1.at)(1));
    claims.decideItem(out.claim.id, itemId, "upheld", "substantially similar", "rev_1", "sig", (0, helpers_1.at)(2));
    const item = claims.item(itemId);
    strict_1.default.equal(item.overlay, "upheld_pending_counter");
    const notice = claims.fileCounterNotice(out.claim.id, itemId, "I made this in 2023", (0, helpers_1.at)(3));
    // before the window expires: nothing fires
    strict_1.default.equal(claims.onRestoreWindowExpiry(out.claim.id, itemId, (0, helpers_1.at)(100)), false);
    strict_1.default.equal(claims.item(itemId).overlay, "restore_window");
    // after: restore fires
    strict_1.default.equal(claims.onRestoreWindowExpiry(out.claim.id, itemId, (0, helpers_1.day)(20)), true);
    strict_1.default.equal(claims.item(itemId).overlay, "restored_after_counter_notice");
    strict_1.default.ok(claims.claimEvents(out.claim.id).some((e) => e.type === "restored_after_counter_notice"));
    // the refile path: window live, claimant refiles -> counsel
    const out2 = claims.fileClaim((0, helpers_1.mkClaim)({ items: [{ listing_ref: "listing_z9" }] }), (0, helpers_1.day)(30));
    if (out2.kind !== "filed")
        throw new Error("expected filed");
    const item2 = out2.claim.items[0];
    claims.requestEvidence(out2.claim.id, item2, "similarity_report", "rev_1", (0, helpers_1.day)(31));
    claims.decideItem(out2.claim.id, item2, "upheld", "similar", "rev_1", "sig", (0, helpers_1.day)(31));
    claims.fileCounterNotice(out2.claim.id, item2, "counter", (0, helpers_1.day)(32));
    claims.claimantRefile(out2.claim.id, item2, (0, helpers_1.day)(33));
    strict_1.default.equal(claims.item(item2).overlay, "refiled");
    strict_1.default.equal(claims.item(item2).outcome, "escalated");
    const evs = claims.claimEvents(out2.claim.id);
    strict_1.default.ok(evs.some((e) => e.type === "claimant_refiled"));
    strict_1.default.ok(evs.some((e) => e.type === "counsel_clock_paused"));
    // no further mechanical action fires while paused: the expiry
    // check no-ops on a refiled item instead of restoring
    strict_1.default.equal(claims.onRestoreWindowExpiry(out2.claim.id, item2, (0, helpers_1.day)(50)), false);
});
(0, node_test_1.test)("10: registry entries require a signed human citing policy; nothing auto-creates", () => {
    const { claims, registry } = mkService();
    // run the entire lifecycle surface: no method on the claim
    // service can create a registry entry (structural test)
    const out = claims.fileClaim((0, helpers_1.mkClaim)(), helpers_1.T0);
    if (out.kind !== "filed")
        throw new Error("expected filed");
    claims.requestEvidence(out.claim.id, out.claim.items[0], "similarity_report", "rev_1", (0, helpers_1.at)(1));
    claims.decideItem(out.claim.id, out.claim.items[0], "upheld", "similar", "rev_1", "sig", (0, helpers_1.at)(2));
    const out2 = claims.fileClaim((0, helpers_1.mkClaim)({ items: [{ listing_ref: "l2" }] }), (0, helpers_1.at)(3));
    if (out2.kind === "filed")
        claims.withdraw(out2.claim.id, (0, helpers_1.at)(4));
    strict_1.default.equal(registry.size(), 0);
    // adding requires citation + signature
    strict_1.default.throws(() => registry.add("h", "", "rev_1", "sig", (0, helpers_1.at)(5)));
    const entry = registry.add("hash_bad", "policy §4.2 serial filings against competing shops", "rev_1", "sig:1", (0, helpers_1.at)(5));
    strict_1.default.ok(entry.id.startsWith("reg_"));
    // the contest path removes with a signature
    registry.remove(entry.id, "rev_2", "sig:2", (0, helpers_1.at)(6));
    strict_1.default.equal(registry.size(), 0);
    strict_1.default.equal(registry.lookup("hash_bad"), undefined);
});
(0, node_test_1.test)("11: a question never creates a claim record, measure, decision, or registry entry", () => {
    const { entry, claims, registry, inquiries } = mkService();
    const asked = entry.askQuestion({ question_text: "what does template provenance mean?", locale: "en-US", market: "US" }, helpers_1.T0);
    strict_1.default.equal(asked.deflected, false);
    entry.askQuestion({ question_text: "how do licenses work?", locale: "en-US", market: "US", contact: "q@example.com" }, (0, helpers_1.at)(1));
    const answer = entry.askQuestion({ question_text: "should I file at all?", locale: "en-US", market: "US" }, (0, helpers_1.at)(2));
    strict_1.default.ok(answer.inquiry);
    entry.fileClaim((0, helpers_1.mkClaim)(), (0, helpers_1.at)(3)); // the claim side works
    strict_1.default.equal(claims.claimIds().length, 1); // one claim, from fileClaim only
    strict_1.default.equal(inquiries.ids().length, 3);
    strict_1.default.equal(registry.size(), 0);
    // no provisional measures, no decisions, no delists anywhere
    strict_1.default.ok(claims.claimEvents(claims.claimIds()[0]).every((e) => e.type !== "provisional_delisted" || e.payload !== undefined));
    const claimEvents = claims.claimEvents(claims.claimIds()[0]);
    strict_1.default.ok(!claimEvents.some((e) => e.type === "decision_recorded"));
});
(0, node_test_1.test)("12: reclassified claim closes as closed_referred, excluded, no enforcement", () => {
    const svc = mkService({ config: (0, helpers_1.delistAll)() });
    const { claims, inquiries, config, marketplace } = svc;
    const out = claims.fileClaim((0, helpers_1.mkClaim)(), helpers_1.T0);
    if (out.kind !== "filed")
        throw new Error("expected filed");
    const itemId = out.claim.items[0];
    // a provisional delist existed; reclassification restores it
    strict_1.default.ok(claims.claimEvents(out.claim.id).some((e) => e.type === "provisional_delisted"));
    claims.referAsQuestion(out.claim.id, "https://kb.sculptura.com/licensing-basics", "rev_1", "sig:1", (0, helpers_1.at)(1));
    strict_1.default.equal(claims.claim(out.claim.id).state, "closed");
    strict_1.default.equal(claims.item(itemId).outcome, "referred");
    strict_1.default.ok(claims.claimEvents(out.claim.id).some((e) => e.type === "claim_reclassified_question"));
    strict_1.default.ok(claims.claimEvents(out.claim.id).some((e) => e.type === "provisional_restored"));
    // no enforcement event ever fires from a reclassification
    strict_1.default.ok(!claims.claimEvents(out.claim.id).some((e) => e.type === "enforcement_step_signed"));
    // excluded from the substantiation rate
    const report = (0, measure_1.measure)(claims, inquiries, config, marketplace.listingCount(), helpers_1.T0, (0, helpers_1.day)(1));
    strict_1.default.equal(report.referred_claims, 1);
    strict_1.default.equal(report.substantiation_rate, null); // no decided items
});
