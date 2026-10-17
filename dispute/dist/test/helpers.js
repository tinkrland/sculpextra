"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.mkContent = exports.mkEvidencePorts = exports.FakeContactGate = exports.FakeMarketplace = exports.mkClaim = exports.fullAttestation = exports.configWith = exports.day = exports.at = exports.T0 = void 0;
const config_1 = require("../src/config");
exports.T0 = "2026-10-16T00:00:00.000Z";
const at = (minutes) => new Date(Date.parse(exports.T0) + minutes * 60_000).toISOString();
exports.at = at;
const day = (n) => new Date(Date.parse(exports.T0) + n * 86_400_000).toISOString();
exports.day = day;
const configWith = (over) => ({
    ...config_1.DEFAULT_CONFIG,
    ...over,
});
exports.configWith = configWith;
exports.fullAttestation = {
    perjury_acknowledged: true,
    authorized_to_act: true,
    good_faith_belief: true,
    retention_consent: true,
};
const mkClaim = (over = {}) => ({
    claim_type: "ip_infringement",
    locale: "en-US",
    market: "US",
    claimant: {
        name: "Nadia Voss",
        contact_channel: "email",
        contact_value: "nadia@example.com",
        statement_of_rights: "I am the author of the claimed original",
        attestation: exports.fullAttestation,
    },
    claimed_originals: { urls: ["https://nadia.example.com/work"] },
    items: [{ listing_ref: "listing_a1" }],
    ...over,
});
exports.mkClaim = mkClaim;
class FakeMarketplace {
    delisted = new Set();
    delistCalls = [];
    restoreCalls = [];
    count = 1000;
    isDelisted(listingRef) {
        return this.delisted.has(listingRef);
    }
    delist(listingRef, itemRef) {
        this.delistCalls.push(`${itemRef}:${listingRef}`);
        this.delisted.add(listingRef);
        return `mp_delist_${this.delistCalls.length}`;
    }
    restore(listingRef, itemRef) {
        this.restoreCalls.push(`${itemRef}:${listingRef}`);
        this.delisted.delete(listingRef);
        return `mp_restore_${this.restoreCalls.length}`;
    }
    listingCount() {
        return this.count;
    }
}
exports.FakeMarketplace = FakeMarketplace;
class FakeContactGate {
    reachable;
    constructor(reachable = true) {
        this.reachable = reachable;
    }
    validate(channel, value) {
        void channel;
        void value;
        return { reachable: this.reachable, verdict_chip: this.reachable ? "verified" : "unreachable" };
    }
}
exports.FakeContactGate = FakeContactGate;
const mkEvidencePorts = (opts = {}) => {
    const similarity = {
        run: (original, listing) => ({
            payload_ref: `sim://${original}/${listing}`,
            produced_by: "paracraft.similarity@1.4",
            score: 0.87,
            band: "high",
        }),
    };
    const releaseHistory = {
        timeline: (listing, originals) => ({
            payload_ref: `rel://${listing}?${originals.length}`,
            produced_by: "paracraft.releases@2.0",
        }),
    };
    const provenance = {
        lookup: (listing) => ({
            payload_ref: `prov://${listing}`,
            produced_by: "paracraft.provenance@1.0",
            house_template: Boolean(opts.houseTemplate),
            template_ref: opts.houseTemplate ? "tpl_house_003" : null,
        }),
    };
    const chainOfTitle = {
        lookup: (listing, claimant) => ({
            payload_ref: `cot://${listing}/${claimant}`,
            produced_by: "licensing.chain@1.2",
        }),
    };
    const watermark = {
        trace: (fileRef) => ({
            payload_ref: `wm://${fileRef}`,
            produced_by: "paracraft.watermark@1.0",
            source_order_ref: "ord_77",
        }),
    };
    return {
        similarity,
        releaseHistory,
        provenance,
        chainOfTitle,
        watermark,
        originalRefOf: (claim) => claim.claimed_originals.urls?.[0] ?? "original://0",
    };
};
exports.mkEvidencePorts = mkEvidencePorts;
const mkContent = (answers = [], match) => ({
    lookup: (query) => {
        if (match && !match(query)) {
            return { answers: [], engine_path: "tag_traversal", latency_ms: 1 };
        }
        return {
            answers: answers.map((a) => ({
                doc_id: a.doc_id,
                title: a.title ?? "Answer",
                snippet: "snippet",
                url: a.url,
            })),
            engine_path: "tag_traversal",
            latency_ms: 3,
        };
    },
});
exports.mkContent = mkContent;
