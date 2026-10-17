"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.measure = measure;
const events_1 = require("./events");
function median(xs) {
    if (xs.length === 0)
        return null;
    const s = [...xs].sort((a, b) => a - b);
    const mid = Math.floor(s.length / 2);
    return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}
function measure(claims, inquiries, config, listingCount, from, to) {
    if (Date.parse(from) >= Date.parse(to))
        throw new Error("measurement window is empty");
    const inW = (ts) => ts >= from && ts < to;
    let filedSubmissions = 0;
    let reachedReview = 0;
    let bounced = 0;
    let merged = 0;
    let rateTrips = 0;
    let resubmitted = 0;
    let resubmittedFiled = 0;
    let decided = 0;
    let upheld = 0;
    let escalated = 0;
    let withdrawn = 0;
    let referred = 0;
    let falsePositiveDelists = 0;
    let shortcutDecisions = 0;
    let typeCorrections = 0;
    let hours = 0;
    const decisionLatencies = [];
    for (const id of claims.claimIds()) {
        const events = claims.claimEvents(id);
        const claim = claims.claim(id);
        if (!claim)
            continue;
        const submitted = events.find((e) => e.type === "claim_submitted");
        if (!submitted)
            continue;
        if (inW(submitted.created_at)) {
            filedSubmissions += 1;
            if (events.some((e) => e.type === "claim_bounced" && inW(e.created_at))) {
                bounced += 1;
            }
            if (claim.bounced_from) {
                resubmitted += 1;
                if (claim.state !== "bounced")
                    resubmittedFiled += 1;
            }
            if (claim.state !== "bounced")
                reachedReview += 1;
        }
        // per-item accounting from events
        const itemIds = claim.items;
        for (const itemId of itemIds) {
            const item = claims.item(itemId);
            if (!item)
                continue;
            const decidedEvent = [...events].reverse().find((e) => e.type === "decision_recorded" && e.payload.item_ref === itemId);
            if (item.outcome === "rejected" || item.outcome === "upheld")
                decided += 1;
            if (item.outcome === "upheld")
                upheld += 1;
            if (item.outcome === "escalated")
                escalated += 1;
            if (item.outcome === "withdrawn")
                withdrawn += 1;
            // false positive: provisionally delisted then rejected
            const wasDelisted = events.some((e) => e.type === "provisional_delisted" && e.payload.item_ref === itemId);
            if (wasDelisted && item.outcome === "rejected")
                falsePositiveDelists += 1;
            if (decidedEvent) {
                const p = decidedEvent.payload;
                if (p.provenance_shortcut)
                    shortcutDecisions += 1;
            }
        }
        // type corrections + claim-level accounting from events
        typeCorrections += events.filter((e) => e.type === "type_corrected" && inW(e.created_at)).length;
        merged += events.filter((e) => e.type === "merged_amendment" && inW(e.created_at)).length;
        rateTrips += events.filter((e) => e.type === "rate_limited" && inW(e.created_at)).length;
        hours += events
            .filter((e) => e.type === "hours_logged" && inW(e.created_at))
            .reduce((sum, e) => sum + (e.payload.hours ?? 0), 0);
        if (events.some((e) => e.type === "claim_reclassified_question"))
            referred += 1;
        // time to decision, counsel pauses subtracted exactly (pause
        // event pairs), for claims whose decisions completed in window
        const decisionEvents = events.filter((e) => e.type === "decision_recorded");
        const lastDecision = decisionEvents[decisionEvents.length - 1];
        const closedEvent = events.find((e) => e.type === "claim_closed");
        if (lastDecision && closedEvent && !events.some((e) => e.type === "claim_reopened")) {
            let pausedMs = 0;
            let pausedAt = null;
            for (const e of events) {
                if (e.type === "counsel_clock_paused")
                    pausedAt = Date.parse(e.created_at);
                if (e.type === "counsel_clock_resumed" && pausedAt !== null) {
                    pausedMs += Date.parse(e.created_at) - pausedAt;
                    pausedAt = null;
                }
            }
            const elapsed = Date.parse(lastDecision.created_at) - Date.parse(submitted.created_at) - pausedMs;
            if (elapsed >= 0)
                decisionLatencies.push(elapsed / 60_000);
        }
    }
    // the inquiry side of the fork
    let asked = 0;
    let deflected = 0;
    let answered = 0;
    let referrals = 0;
    for (const id of inquiries.ids()) {
        const events = inquiries.eventsOf(id);
        const first = events[0];
        if (!first || !inW(first.created_at))
            continue;
        asked += 1;
        if (events.some((e) => e.type === "question_deflected"))
            deflected += 1;
        const ans = events.find((e) => e.type === "question_answered");
        if (ans) {
            answered += 1;
            if (ans.payload.referred_to_claim_form)
                referrals += 1;
        }
    }
    const totalEntries = asked + reachedReview;
    const decisionsTotal = decided;
    return (0, events_1.deepFreeze)(structuredClone({
        from,
        to,
        claim_volume: reachedReview,
        filed_submissions: filedSubmissions,
        bounced,
        bounce_rate: filedSubmissions > 0 ? bounced / filedSubmissions : null,
        resubmission_completion_rate: resubmitted > 0 ? resubmittedFiled / resubmitted : null,
        merged_amendments: merged,
        rate_limit_trips: rateTrips,
        claims_per_1000_listings_monthly: listingCount > 0 ? (reachedReview / listingCount) * 1000 * (2_629_800_000 / (Date.parse(to) - Date.parse(from))) : null,
        decided_items: decided,
        upheld_items: upheld,
        escalated_items: escalated,
        withdrawn_items: withdrawn,
        referred_claims: referred,
        substantiation_rate: decisionsTotal > 0 ? upheld / decisionsTotal : null,
        false_positive_delists_restored: falsePositiveDelists,
        provenance_shortcut_share: decisionsTotal > 0 ? shortcutDecisions / decisionsTotal : null,
        type_correction_rate: reachedReview > 0 ? typeCorrections / reachedReview : null,
        median_minutes_to_decision_counsel_paused: median(decisionLatencies),
        reviewer_hours: hours,
        fork: {
            questions_asked: asked,
            question_share: totalEntries > 0 ? asked / totalEntries : null,
            deflection_rate: asked > 0 ? deflected / asked : null,
            reclassified_claim_to_question_rate: reachedReview > 0 ? referred / reachedReview : null,
            referral_to_claim_rate: answered > 0 ? referrals / answered : null,
        },
    }));
}
