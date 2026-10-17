import type {
  ChainOfTitlePort,
  ClaimInput,
  ContactGatePort,
  MarketplacePort,
  ProvenancePort,
  PublicContentPort,
  ReleaseHistoryPort,
  SimilarityReportPort,
  WatermarkPort,
} from "../src/types";
import type { DisputeConfig } from "../src/config";
import { DEFAULT_CONFIG } from "../src/config";
import type { EvidencePorts } from "../src/evidence";

export const T0 = "2026-10-16T00:00:00.000Z";
export const at = (minutes: number) =>
  new Date(Date.parse(T0) + minutes * 60_000).toISOString();
export const day = (n: number) =>
  new Date(Date.parse(T0) + n * 86_400_000).toISOString();

export const configWith = (over: Partial<DisputeConfig>): DisputeConfig => ({
  ...DEFAULT_CONFIG,
  ...over,
});

export const fullAttestation = {
  perjury_acknowledged: true,
  authorized_to_act: true,
  good_faith_belief: true,
  retention_consent: true,
};

export const mkClaim = (over: Partial<ClaimInput> = {}): ClaimInput => ({
  claim_type: "ip_infringement",
  claimant_class: "individual_artist",
  locale: "en-US",
  market: "US",
  claimant: {
    name: "Nadia Voss",
    contact_channel: "email",
    contact_value: "nadia@example.com",
    statement_of_rights: "I am the author of the claimed original",
    attestation: fullAttestation,
  },
  claimed_originals: { urls: ["https://nadia.example.com/work"] },
  items: [{ listing_ref: "listing_a1" }],
  ...over,
});

export class FakeMarketplace implements MarketplacePort {
  public delisted = new Set<string>();
  public delistCalls: string[] = [];
  public restoreCalls: string[] = [];
  public count = 1000;
  public isDelisted(listingRef: string): boolean {
    return this.delisted.has(listingRef);
  }
  public delist(listingRef: string, itemRef: string): string {
    this.delistCalls.push(`${itemRef}:${listingRef}`);
    this.delisted.add(listingRef);
    return `mp_delist_${this.delistCalls.length}`;
  }
  public restore(listingRef: string, itemRef: string): string {
    this.restoreCalls.push(`${itemRef}:${listingRef}`);
    this.delisted.delete(listingRef);
    return `mp_restore_${this.restoreCalls.length}`;
  }
  public listingCount(): number {
    return this.count;
  }
}

export class FakeContactGate implements ContactGatePort {
  public constructor(public reachable = true) {}
  public validate(channel: string, value: string) {
    void channel; void value;
    return { reachable: this.reachable, verdict_chip: this.reachable ? "verified" : "unreachable" };
  }
}

export const mkEvidencePorts = (opts: { houseTemplate?: boolean } = {}): EvidencePorts => {
  const similarity: SimilarityReportPort = {
    run: (original, listing) => ({
      payload_ref: `sim://${original}/${listing}`,
      produced_by: "paracraft.similarity@1.4",
      score: 0.87,
      band: "high",
    }),
  };
  const releaseHistory: ReleaseHistoryPort = {
    timeline: (listing, originals) => ({
      payload_ref: `rel://${listing}?${originals.length}`,
      produced_by: "paracraft.releases@2.0",
    }),
  };
  const provenance: ProvenancePort = {
    lookup: (listing) => ({
      payload_ref: `prov://${listing}`,
      produced_by: "paracraft.provenance@1.0",
      house_template: Boolean(opts.houseTemplate),
      template_ref: opts.houseTemplate ? "tpl_house_003" : null,
    }),
  };
  const chainOfTitle: ChainOfTitlePort = {
    lookup: (listing, claimant) => ({
      payload_ref: `cot://${listing}/${claimant}`,
      produced_by: "licensing.chain@1.2",
    }),
  };
  const watermark: WatermarkPort = {
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

export const mkContent = (
  answers: { doc_id: string; url: string; title?: string }[] = [],
  match?: (query: string) => boolean,
): PublicContentPort => ({
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
