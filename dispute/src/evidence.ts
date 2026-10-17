import type {
  ChainOfTitlePort,
  Claim,
  ClaimItem,
  ProvenancePort,
  ReleaseHistoryPort,
  SimilarityReportPort,
  WatermarkPort,
} from "./types";
import type { EvidenceKindRequest } from "./config";

// evidence assembly (§6): produced on demand, attached as
// immutable artifacts, always labeled signal-not-verdict. the
// similarity report and release history state in their own text
// what geometry comparison and timestamps can and cannot prove.

export interface EvidenceRunResult {
  payload_ref: string;
  produced_by: string;
}

export interface EvidencePorts {
  similarity: SimilarityReportPort;
  releaseHistory: ReleaseHistoryPort;
  provenance: ProvenancePort;
  chainOfTitle: ChainOfTitlePort;
  watermark: WatermarkPort;
  // a ref for the claimed original: intake stores refs; the
  // similarity run goes between it and the listed release
  originalRefOf(claim: Claim): string;
}

export class EvidenceError extends Error {}

// what the claim lifecycle consumes: one on-demand run per request
export interface EvidenceRunner {
  run(kind: EvidenceKindRequest, claim: Claim, item: ClaimItem): EvidenceRunResult;
}

// the adapter: one run per request, payload_ref content-addressed.
// the ports decide payloads; this module never interprets scores -
// bands are advisory signal data (spec: signals never verdicts).
export class EvidenceAdapter {
  public constructor(private readonly ports: EvidencePorts) {}

  public run(
    kind: EvidenceKindRequest,
    claim: Claim,
    item: ClaimItem,
  ): EvidenceRunResult {
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
        throw new EvidenceError(`unknown evidence kind: ${kind as string}`);
    }
  }

  // the template-provenance shortcut (§6): if the accused design
  // derives from a house template, neither party owns the base.
  // callers surface this so many claims resolve with an
  // explanation and no takedown.
  public provenanceCheck(item: ClaimItem): { house_template: boolean; template_ref: string | null } {
    const r = this.ports.provenance.lookup(item.listing_ref);
    return { house_template: r.house_template, template_ref: r.template_ref };
  }

  private originalRefs(claim: Claim): readonly string[] {
    const o = claim.claimed_originals;
    return [
      ...(o.urls ?? []),
      ...(o.image_refs ?? []),
      ...(o.registration_numbers ?? []),
    ];
  }
}
