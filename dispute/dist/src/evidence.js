"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.EvidenceAdapter = exports.EvidenceError = void 0;
class EvidenceError extends Error {
}
exports.EvidenceError = EvidenceError;
// the adapter: one run per request, payload_ref content-addressed.
// the ports decide payloads; this module never interprets scores -
// bands are advisory signal data (spec: signals never verdicts).
class EvidenceAdapter {
    ports;
    constructor(ports) {
        this.ports = ports;
    }
    run(kind, claim, item) {
        switch (kind) {
            case "similarity_report": {
                const r = this.ports.similarity.run(this.ports.originalRefOf(claim), item.listing_ref);
                return { payload_ref: r.payload_ref, produced_by: r.produced_by };
            }
            case "release_history": {
                const r = this.ports.releaseHistory.timeline(item.listing_ref, this.originalRefs(claim));
                return { payload_ref: r.payload_ref, produced_by: r.produced_by };
            }
            case "provenance_lookup": {
                const r = this.ports.provenance.lookup(item.listing_ref);
                return { payload_ref: r.payload_ref, produced_by: r.produced_by };
            }
            case "chain_of_title": {
                const r = this.ports.chainOfTitle.lookup(item.listing_ref, claim.claimant.name);
                return { payload_ref: r.payload_ref, produced_by: r.produced_by };
            }
            case "watermark_trace": {
                const r = this.ports.watermark.trace(this.ports.originalRefOf(claim));
                return { payload_ref: r.payload_ref, produced_by: r.produced_by };
            }
            default:
                throw new EvidenceError(`unknown evidence kind: ${kind}`);
        }
    }
    // the template-provenance shortcut (§6): if the accused design
    // derives from a house template, neither party owns the base.
    // callers surface this so many claims resolve with an
    // explanation and no takedown.
    provenanceCheck(item) {
        const r = this.ports.provenance.lookup(item.listing_ref);
        return { house_template: r.house_template, template_ref: r.template_ref };
    }
    originalRefs(claim) {
        const o = claim.claimed_originals;
        return [
            ...(o.urls ?? []),
            ...(o.image_refs ?? []),
            ...(o.registration_numbers ?? []),
        ];
    }
}
exports.EvidenceAdapter = EvidenceAdapter;
