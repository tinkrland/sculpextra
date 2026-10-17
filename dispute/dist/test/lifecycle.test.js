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
const review_1 = require("../src/review");
const evidence_1 = require("../src/evidence");
const measure_1 = require("../src/measure");
const helpers_1 = require("./helpers");
const mkAll = (opts = {}) => {
    const config = opts.config ?? (0, helpers_1.configWith)({});
    const marketplace = new helpers_1.FakeMarketplace();
    const gate = new helpers_1.FakeContactGate();
    const registry = new registry_1.BadFaithRegistry();
    const evidence = new evidence_1.EvidenceAdapter((0, helpers_1.mkEvidencePorts)({ houseTemplate: opts.houseTemplate }));
    const claims = new claims_1.DisputeService(config, marketplace, gate, evidence, (h) => registry.lookup(h));
    const inquiries = new inquiry_1.InquiryService(config, (0, helpers_1.mkContent)(opts.contentAnswers ?? [], opts.contentMatch));
    const review = new review_1.ReviewQueue(config, (id) => claims.claim(id), (cid, rid, now) => {
        claims.claimEvents(cid); // no-op read; assignment logged below
        const log = claims.log;
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
(0, node_test_1.test)("the contact gate bounces unreachable claimants without judging merits", () => {
    const svc = mkAll();
    svc.gate.reachable = false;
    const out = svc.claims.fileClaim((0, helpers_1.mkClaim)(), helpers_1.T0);
    strict_1.default.equal(out.kind, "bounced");
    if (out.kind === "bounced") {
        strict_1.default.ok(out.missing.some((m) => m.includes("unreachable")));
        strict_1.default.equal(out.claim.state, "bounced");
    }
    // the verdict is a chip in the log, never a routing input
    const events = svc.claims.claimEvents(out.claim.id);
    const verdict = events.find((e) => e.type === "contact_gate_verdict");
    const p = verdict?.payload;
    strict_1.default.equal(p.verdict_chip, "unreachable");
});
(0, node_test_1.test)("rate limits trip and stay visible; registry tightens, never blocks", () => {
    const svc = mkAll({ config: (0, helpers_1.configWith)({ rate_limit_per_claimant_day: 2, registry_rate_limit_per_day: 1 }) });
    const c1 = svc.claims.fileClaim((0, helpers_1.mkClaim)({ items: [{ listing_ref: "l1" }] }), helpers_1.T0);
    const c2 = svc.claims.fileClaim((0, helpers_1.mkClaim)({ items: [{ listing_ref: "l2" }] }), (0, helpers_1.at)(1));
    const c3 = svc.claims.fileClaim((0, helpers_1.mkClaim)({ items: [{ listing_ref: "l3" }] }), (0, helpers_1.at)(2));
    strict_1.default.equal(c1.rate_limited_chip, false);
    strict_1.default.equal(c2.rate_limited_chip, false);
    strict_1.default.equal(c3.rate_limited_chip, true); // third same-day filing trips
    const chipClaim = c3.claim.id;
    strict_1.default.ok(svc.claims.claimEvents(chipClaim).some((e) => e.type === "rate_limited"));
    // the filing STILL went through: never block filing outright
    strict_1.default.equal(svc.claims.claim(chipClaim).state, "under_review");
    // a registry entry tightens the limit to 1/day but never blocks
    const hash = svc.claims.contactHashOf(svc.claims.claim(chipClaim));
    svc.registry.add(hash, "policy §4.2", "rev_1", "sig", (0, helpers_1.at)(3));
    const c4 = svc.claims.fileClaim((0, helpers_1.mkClaim)({ items: [{ listing_ref: "l4" }] }), (0, helpers_1.at)(4));
    strict_1.default.equal(c4.rate_limited_chip, true);
    strict_1.default.equal(c4.registry_chip, true);
    strict_1.default.equal(svc.claims.claim(c4.claim.id).state, "under_review");
});
(0, node_test_1.test)("multi-listing claim: per-item measures, mixed outcomes, closes on last decision", () => {
    const svc = mkAll({ config: (0, helpers_1.delistAll)() });
    const out = svc.claims.fileClaim((0, helpers_1.mkClaim)({ items: [{ listing_ref: "m1" }, { listing_ref: "m2" }, { listing_ref: "m3" }] }), helpers_1.T0);
    if (out.kind !== "filed")
        throw new Error("expected filed");
    const [i1, i2, i3] = out.claim.items;
    strict_1.default.equal(svc.marketplace.delisted.size, 3); // per-item provisional delists
    svc.claims.requestEvidence(out.claim.id, i1, "similarity_report", "rev_1", (0, helpers_1.at)(1));
    svc.claims.requestEvidence(out.claim.id, i2, "provenance_lookup", "rev_1", (0, helpers_1.at)(1));
    svc.claims.decideItem(out.claim.id, i1, "rejected", "not similar", "rev_1", "s1", (0, helpers_1.at)(2));
    strict_1.default.equal(svc.claims.claim(out.claim.id).state, "decided"); // first decision
    strict_1.default.equal(svc.claims.claim(out.claim.id).state !== "closed", true);
    svc.claims.decideItem(out.claim.id, i2, "rejected", "house template base", "rev_1", "s2", (0, helpers_1.at)(3), { provenance_shortcut: true });
    strict_1.default.ok(!svc.marketplace.delisted.has("m1"));
    strict_1.default.ok(!svc.marketplace.delisted.has("m2"));
    strict_1.default.ok(svc.marketplace.delisted.has("m3")); // m3 still delisted, claim open
    svc.claims.requestEvidence(out.claim.id, i3, "similarity_report", "rev_1", (0, helpers_1.at)(4));
    svc.claims.decideItem(out.claim.id, i3, "upheld", "substantially similar", "rev_1", "s3", (0, helpers_1.at)(5));
    // mixed outcome closes as upheld_delisted (an upheld item dominates)
    const claim = svc.claims.claim(out.claim.id);
    strict_1.default.equal(claim.state, "closed");
    const closed = svc.claims.claimEvents(out.claim.id).find((e) => e.type === "claim_closed");
    strict_1.default.equal((closed?.payload).outcome, "upheld_delisted");
    strict_1.default.ok(svc.marketplace.delisted.has("m3"));
    void i2;
});
(0, node_test_1.test)("a claim against an already-delisted listing needs no provisional measure", () => {
    const svc = mkAll({ config: (0, helpers_1.delistAll)() });
    svc.marketplace.delisted.add("already_gone");
    const out = svc.claims.fileClaim((0, helpers_1.mkClaim)({ items: [{ listing_ref: "already_gone" }] }), helpers_1.T0);
    if (out.kind !== "filed")
        throw new Error("expected filed");
    const events = svc.claims.claimEvents(out.claim.id);
    const delist = events.filter((e) => e.type === "provisional_delisted");
    strict_1.default.equal(delist.length, 0); // no second delist
    const notify = events.find((e) => e.type === "provisional_notify_only");
    strict_1.default.equal((notify?.payload).reason, "listing already delisted");
});
(0, node_test_1.test)("escalation pauses the clock; counsel return resumes and the claim can close", () => {
    const svc = mkAll();
    const out = svc.claims.fileClaim((0, helpers_1.mkClaim)(), helpers_1.T0);
    if (out.kind !== "filed")
        throw new Error("expected filed");
    const item = out.claim.items[0];
    svc.claims.requestEvidence(out.claim.id, item, "chain_of_title", "rev_1", (0, helpers_1.at)(1));
    svc.claims.decideItem(out.claim.id, item, "escalated", "contested-territory ip, substantiated", "rev_1", "s1", (0, helpers_1.at)(2));
    strict_1.default.equal(svc.claims.claim(out.claim.id).state, "escalated_counsel");
    strict_1.default.ok(svc.claims.claimEvents(out.claim.id).some((e) => e.type === "counsel_clock_paused"));
    // counsel owns posture; nothing mechanical fires while paused
    svc.claims.counselReturn(out.claim.id, "counsel_1", (0, helpers_1.at)(600));
    strict_1.default.ok(svc.claims.claimEvents(out.claim.id).some((e) => e.type === "counsel_clock_resumed"));
    // the reviewer re-decides after counsel: the item is escalated, a
    // new claim decision path would be reopen; here the claim closes
    // escalated once every item is terminal
    strict_1.default.equal(svc.claims.claim(out.claim.id).state, "closed");
    const closed = svc.claims.claimEvents(out.claim.id).find((e) => e.type === "claim_closed");
    strict_1.default.equal((closed?.payload).outcome, "escalated_counsel");
});
(0, node_test_1.test)("time-to-decision subtracts the counsel pause exactly", () => {
    const svc = mkAll();
    // two items: one escalates (pausing the clock at 10min), counsel
    // returns at 610min, the second item decides at 700min. wall time
    // to decision is 700min; the pause interval (600min) subtracts
    // exactly, so time-to-decision measures 100min.
    const out = svc.claims.fileClaim((0, helpers_1.mkClaim)({ items: [{ listing_ref: "p1" }, { listing_ref: "p2" }] }), helpers_1.T0);
    if (out.kind !== "filed")
        throw new Error("expected filed");
    const [i1, i2] = out.claim.items;
    svc.claims.requestEvidence(out.claim.id, i1, "chain_of_title", "rev_1", (0, helpers_1.at)(1));
    svc.claims.decideItem(out.claim.id, i1, "escalated", "counsel first", "rev_1", "s1", (0, helpers_1.at)(10));
    strict_1.default.ok(svc.claims.claimEvents(out.claim.id).some((e) => e.type === "counsel_clock_paused"));
    svc.claims.counselReturn(out.claim.id, "counsel_1", (0, helpers_1.at)(610));
    strict_1.default.ok(svc.claims.claimEvents(out.claim.id).some((e) => e.type === "counsel_clock_resumed"));
    svc.claims.requestEvidence(out.claim.id, i2, "similarity_report", "rev_1", (0, helpers_1.at)(611));
    svc.claims.decideItem(out.claim.id, i2, "rejected", "not similar", "rev_1", "s2", (0, helpers_1.at)(700));
    strict_1.default.equal(svc.claims.claim(out.claim.id).state, "closed");
    const report = (0, measure_1.measure)(svc.claims, svc.inquiries, svc.config, svc.marketplace.listingCount(), helpers_1.T0, (0, helpers_1.day)(2));
    strict_1.default.equal(report.median_minutes_to_decision_counsel_paused, 100);
    strict_1.default.equal(report.escalated_items, 1);
    strict_1.default.equal(report.substantiation_rate, 0); // one merits decision, zero upheld
});
(0, node_test_1.test)("reopen links within 30 days, and throws past the window", () => {
    const svc = mkAll();
    const out = svc.claims.fileClaim((0, helpers_1.mkClaim)(), helpers_1.T0);
    if (out.kind !== "filed")
        throw new Error("expected filed");
    const item = out.claim.items[0];
    svc.claims.requestEvidence(out.claim.id, item, "similarity_report", "rev_1", (0, helpers_1.at)(1));
    svc.claims.decideItem(out.claim.id, item, "rejected", "not similar", "rev_1", "s1", (0, helpers_1.at)(2));
    strict_1.default.equal(svc.claims.claim(out.claim.id).state, "closed");
    const reopened = svc.claims.reopenClaim(out.claim.id, (0, helpers_1.day)(29));
    strict_1.default.equal(reopened.reopened_from, out.claim.id);
    strict_1.default.equal(reopened.state, "under_review");
    strict_1.default.equal(svc.claims.claimEvents(reopened.id).some((e) => e.type === "claim_reopened"), true);
    strict_1.default.throws(() => svc.claims.reopenClaim(out.claim.id, (0, helpers_1.day)(31)));
});
(0, node_test_1.test)("the inquiry fork deflects, queues, and hands off without ever filing", () => {
    const svc = mkAll({
        contentAnswers: [{ doc_id: "prov_1", url: "https://docs.sculptura.com/provenance" }],
        contentMatch: (q) => q.includes("provenance"),
    });
    const d1 = svc.inquiries.askQuestion({ question_text: "what is provenance?", locale: "en-US", market: "US" }, helpers_1.T0);
    strict_1.default.equal(d1.deflected, true); // answered by public content
    const d2 = svc.inquiries.askQuestion({ question_text: "my unique weird situation?", locale: "en-US", market: "US", contact: "x@example.com" }, (0, helpers_1.at)(1));
    strict_1.default.equal(d2.deflected, false);
    strict_1.default.equal(svc.inquiries.openQuestions().length, 1);
    // a question that is really a claim gets the form link, nothing auto-files
    svc.inquiries.answerQuestion(d2.inquiry.id, "this sounds like a claim; the form is here", "rev_1", (0, helpers_1.at)(2), { claim_form: true });
    const ans = svc.inquiries.eventsOf(d2.inquiry.id).find((e) => e.type === "question_answered");
    strict_1.default.equal((ans?.payload).referred_to_claim_form, true);
    strict_1.default.equal(svc.claims.claimIds().length, 0); // still zero claims
    const report = (0, measure_1.measure)(svc.claims, svc.inquiries, svc.config, svc.marketplace.listingCount(), helpers_1.T0, (0, helpers_1.day)(1));
    strict_1.default.equal(report.fork.questions_asked, 2);
    strict_1.default.equal(report.fork.deflection_rate, 0.5);
    strict_1.default.equal(report.fork.referral_to_claim_rate, 1);
    strict_1.default.equal(report.claim_volume, 0);
});
(0, node_test_1.test)("counsel-triage types route to the counsel-facing reviewer set", () => {
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
    const ip = svc.claims.fileClaim((0, helpers_1.mkClaim)({ items: [{ listing_ref: "r1" }] }), helpers_1.T0);
    if (ip.kind !== "filed")
        throw new Error("expected filed");
    strict_1.default.equal(svc.review.assignClaim(ip.claim.id, (0, helpers_1.at)(1)), "rev_std");
    const tm = svc.claims.fileClaim((0, helpers_1.mkClaim)({
        claim_type: "trademark_or_publicity",
        claimant: { ...(0, helpers_1.mkClaim)().claimant, contact_value: "tm@example.com" },
        items: [{ listing_ref: "r2" }],
    }), (0, helpers_1.at)(2));
    if (tm.kind !== "filed")
        throw new Error("expected filed");
    strict_1.default.equal(svc.review.assignClaim(tm.claim.id, (0, helpers_1.at)(3)), "counsel_triage");
    // wrong market: nobody matches, the claim stays queued
    const de = svc.claims.fileClaim((0, helpers_1.mkClaim)({
        market: "DE",
        claimant: { ...(0, helpers_1.mkClaim)().claimant, contact_value: "de@example.com" },
        items: [{ listing_ref: "r3" }],
    }), (0, helpers_1.at)(4));
    if (de.kind !== "filed")
        throw new Error("expected filed");
    strict_1.default.equal(svc.review.assignClaim(de.claim.id, (0, helpers_1.at)(5)), null);
});
(0, node_test_1.test)("a studio cease-and-desist is a legal_notice claim: takedown on intake (ruled), counsel review, separate measurement", () => {
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
    const studio = svc.claims.fileClaim((0, helpers_1.mkClaim)({
        claimant_class: "legal_notice",
        claimant: {
            name: "Meridian Studio",
            contact_channel: "email",
            contact_value: "counsel@meridian.example",
            statement_of_rights: "Meridian holds the copyright in the referenced work",
            attestation: helpers_1.fullAttestation, // ignored for legal notices
        },
        legal_notice: {
            notice_ref: "C&D-2026-114",
            representation: "Feld & Associates",
            response_deadline: (0, helpers_1.day)(10),
        },
        items: [{ listing_ref: "studio_case" }],
    }), helpers_1.T0);
    if (studio.kind !== "filed")
        throw new Error("expected filed");
    const claim = studio.claim;
    strict_1.default.equal(claim.claimant_class, "legal_notice");
    strict_1.default.equal(claim.legal_notice?.notice_ref, "C&D-2026-114");
    // the ruling (14.1): a facially complete notice naming a
    // listing takes it down on intake, redbubble-style - reversible,
    // logged, creator notified
    strict_1.default.equal(svc.marketplace.delisted.has("studio_case"), true);
    const delistEv = svc.claims.claimEvents(claim.id).find((e) => e.type === "provisional_delisted");
    const dp = delistEv?.payload;
    strict_1.default.ok(dp.port_ref.startsWith("mp_delist_"));
    strict_1.default.ok(svc.claims.claimEvents(claim.id).some((e) => e.type === "creator_notified"));
    // an individual artist in the same window stays up: review posture
    const solo = svc.claims.fileClaim((0, helpers_1.mkClaim)({ items: [{ listing_ref: "solo_stays_up" }] }), (0, helpers_1.at)(1));
    if (solo.kind !== "filed")
        throw new Error("expected filed");
    strict_1.default.equal(svc.marketplace.delisted.has("solo_stays_up"), false);
    strict_1.default.ok(svc.claims.claimEvents(solo.claim.id).some((e) => e.type === "provisional_notify_only"));
    // and the standard reviewer set is skipped for the notice: counsel from intake
    strict_1.default.equal(svc.review.assignClaim(claim.id, (0, helpers_1.at)(1)), "counsel_triage");
    // the response deadline is a chip in the reviewer view, never a trigger
    const view = svc.claims.reviewerView(claim.id);
    strict_1.default.equal(view.counsel_triage, true);
    strict_1.default.equal(view.legal_notice.response_deadline, (0, helpers_1.day)(10));
    // counsel upholds: the delist stands, the counter-notice window
    // is exposed, and the ladder is fed exactly like an individual
    // claim's - same signed record, same enforcement event
    const itemId = claim.items[0];
    svc.claims.requestEvidence(claim.id, itemId, "similarity_report", "counsel_triage", (0, helpers_1.at)(3));
    const decision = svc.claims.decideItem(claim.id, itemId, "upheld", "the listing reproduces the noticed work", "counsel_triage", "sig:counsel:upheld", (0, helpers_1.at)(4));
    strict_1.default.ok(svc.claims.claimEvents(claim.id).some((e) => e.type === "enforcement_step_signed"));
    strict_1.default.ok(decision.signature.includes("counsel"));
    strict_1.default.equal(svc.claims.item(itemId).overlay, "upheld_pending_counter");
    // a rejected notice restores as loudly as it delisted
    const notice2 = svc.claims.fileClaim((0, helpers_1.mkClaim)({
        claimant_class: "legal_notice",
        claimant: { ...(0, helpers_1.mkClaim)().claimant, contact_value: "counsel2@meridian.example", name: "Meridian Studio 2" },
        legal_notice: { notice_ref: "C&D-2026-115", representation: "Feld & Associates" },
        items: [{ listing_ref: "studio_case_2" }],
    }), (0, helpers_1.at)(5));
    if (notice2.kind !== "filed")
        throw new Error("expected filed");
    const item2 = notice2.claim.items[0];
    strict_1.default.ok(svc.marketplace.delisted.has("studio_case_2")); // ruled takedown
    svc.claims.requestEvidence(notice2.claim.id, item2, "similarity_report", "counsel_triage", (0, helpers_1.at)(6));
    svc.claims.decideItem(notice2.claim.id, item2, "rejected", "the claim names the wrong design", "counsel_triage", "sig:counsel:rej", (0, helpers_1.at)(7));
    strict_1.default.equal(svc.marketplace.delisted.has("studio_case_2"), false);
    strict_1.default.ok(svc.claims.claimEvents(notice2.claim.id).some((e) => e.type === "provisional_restored"));
    // measurement splits by class: studio notices and artist claims
    // never muddy each other's numbers
    const individual = svc.claims.fileClaim((0, helpers_1.mkClaim)({ items: [{ listing_ref: "solo_case" }] }), (0, helpers_1.at)(8));
    if (individual.kind !== "filed")
        throw new Error("expected filed");
    svc.claims.requestEvidence(individual.claim.id, individual.claim.items[0], "provenance_lookup", "rev_1", (0, helpers_1.at)(9));
    svc.claims.decideItem(individual.claim.id, individual.claim.items[0], "rejected", "house template", "rev_1", "sig:1", (0, helpers_1.at)(10), { provenance_shortcut: true });
    const report = (0, measure_1.measure)(svc.claims, svc.inquiries, svc.config, svc.marketplace.listingCount(), helpers_1.T0, (0, helpers_1.day)(2));
    strict_1.default.equal(report.by_class.legal_notice.claim_volume, 2);
    strict_1.default.equal(report.by_class.legal_notice.substantiation_rate, 0.5); // one upheld, one rejected
    strict_1.default.equal(report.by_class.individual_artist.claim_volume, 2); // solo_stays_up + solo_case
    strict_1.default.equal(report.claim_volume, 4); // blended stays available
});
(0, node_test_1.test)("a legal notice without its required elements bounces with the notice-specific list", () => {
    const svc = mkAll();
    const out = svc.claims.fileClaim((0, helpers_1.mkClaim)({ claimant_class: "legal_notice", legal_notice: { notice_ref: "", representation: "" } }), helpers_1.T0);
    strict_1.default.equal(out.kind, "bounced");
    if (out.kind === "bounced") {
        strict_1.default.ok(out.missing.some((m) => m.includes("legal notice reference")));
        strict_1.default.ok(out.missing.some((m) => m.includes("representation")));
        // the attestation elements are NOT demanded of a legal notice
        strict_1.default.ok(!out.missing.some((m) => m.includes("perjury")));
        strict_1.default.ok(!out.missing.some((m) => m.includes("retained in-platform")));
    }
});
