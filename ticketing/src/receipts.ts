import type { ContactInput } from "./support";
import type {
  BugReportSubmission,
  ContactKind,
  ContactReceipt,
  DisclosureSubmission,
  EngineeringTrackerPort,
  FeatureRequestSubmission,
  ProductBacklogPort,
  SecurityResponsePort,
} from "./types";
import { EventLog, deepFreeze } from "./events";

// the receipt book for non-ticket kinds (owner ruling 2026-10-16):
// bug reports, vulnerability disclosures, and feature requests are
// not support demand. they get receipt records with a small
// lifecycle (new -> acknowledged -> routed -> closed), routing
// signals to their owning systems, and a status view. the core
// never claims a fix, a timeline, or a roadmap promise: it routes
// the record and logs the routing ref. no receipt ever produces a
// case, a ticket, a queue input, or a priority effect.

export type ReceiptEventType =
  | "receipt_created"
  | "receipt_acknowledged"
  | "receipt_routed"
  | "duplicate_merged"
  | "demand_incremented"
  | "receipt_closed";

export interface ReceiptEvent {
  receipt_ref: string;
  seq: number;
  type: ReceiptEventType;
  payload: unknown;
  created_at: string;
}

export class ReceiptError extends Error {}

const RECEIPT_KINDS: ReadonlySet<ContactKind> = new Set([
  "bug_report",
  "vulnerability_disclosure",
  "feature_request",
]);

export class ReceiptBook {
  private counter = 0;
  private readonly receipts = new Map<string, ContactReceipt>();
  private readonly log = new EventLog<ReceiptEvent>();
  private readonly mergeWindowMs: number;

  constructor(
    ports: {
      engineering: EngineeringTrackerPort;
      security: SecurityResponsePort;
      product: ProductBacklogPort;
    },
    mergeWindowHours = 48,
  ) {
    this.engineering = ports.engineering;
    this.security = ports.security;
    this.product = ports.product;
    this.mergeWindowMs = mergeWindowHours * 3_600_000;
  }
  private readonly engineering: EngineeringTrackerPort;
  private readonly security: SecurityResponsePort;
  private readonly product: ProductBacklogPort;

  public file(input: ContactInput, now: string): ContactReceipt {
    const kind = input.kind;
    if (!kind || !RECEIPT_KINDS.has(kind)) {
      throw new ReceiptError("receipt kinds are bug_report, vulnerability_disclosure, feature_request");
    }
    if (!input.account_ref) throw new ReceiptError("receipt needs an account ref");
    if (!input.subject && !input.body) throw new ReceiptError("receipt needs a subject or a body");

    // disclosures never merge and carry no account cross-link:
    // each is handled independently, and the record never joins to
    // the reporter's other records.
    if (kind === "vulnerability_disclosure") {
      return this.create(input, now);
    }

    const open = this.findOpenDuplicate(kind, input, now);
    if (open) {
      this.log.append(open.id, (seq) => ({
        receipt_ref: open.id,
        seq,
        type: "duplicate_merged",
        payload: {
          subject: input.subject,
          duplicate_of: open.id,
          demand: kind === "feature_request",
        },
        created_at: now,
      }));
      const updated = deepFreeze(structuredClone({
        ...open,
        demand_count: kind === "feature_request" ? open.demand_count + 1 : open.demand_count,
        duplicate_count: open.duplicate_count + 1,
      }));
      this.receipts.set(open.id, updated);
      if (kind === "feature_request") {
        this.log.append(open.id, (seq) => ({
          receipt_ref: open.id,
          seq,
          type: "demand_incremented",
          payload: { demand_count: updated.demand_count },
          created_at: now,
        }));
      }
      return updated;
    }
    return this.create(input, now);
  }

  // the owning system closes its receipts; the closure is an event
  // like everything else.
  public close(id: string, by: string, now: string): ContactReceipt {
    const r = this.mustReceipt(id);
    if (r.status === "closed") throw new ReceiptError(`receipt ${id} already closed`);
    this.log.append(id, (seq) => ({
      receipt_ref: id,
      seq,
      type: "receipt_closed",
      payload: { by },
      created_at: now,
    }));
    const closed = deepFreeze(structuredClone({ ...r, status: "closed" as const }));
    this.receipts.set(id, closed);
    return closed;
  }

  public receipt(id: string): ContactReceipt | undefined {
    return this.receipts.get(id);
  }

  public eventsOf(id: string): readonly ReceiptEvent[] {
    return this.log.list(id);
  }

  // status view material for the reporter: receipt + event trail.
  // disclosures are fetchable by id (security response needs them)
  // but never listed by account.
  public byAccount(accountRef: string): readonly ContactReceipt[] {
    return Object.freeze(
      [...this.receipts.values()].filter(
        (r) => r.account_ref === accountRef && r.kind !== "vulnerability_disclosure",
      ),
    );
  }

  public count(): number {
    return this.receipts.size;
  }

  private create(input: ContactInput, now: string): ContactReceipt {
    const kind = input.kind as NonNullable<ContactInput["kind"]>;
    this.counter += 1;
    const id = `receipt_${this.counter}`;
    const disclosure = kind === "vulnerability_disclosure";
    const base: ContactReceipt = deepFreeze({
      id,
      kind: kind as ContactReceipt["kind"],
      account_ref: disclosure ? null : input.account_ref,
      market: input.market,
      language: input.language,
      source_channel: input.source_channel,
      subject: input.subject,
      body: input.body,
      status: "new",
      routing_ref: null,
      demand_count: 1,
      duplicate_count: 0,
      created_at: now,
    });
    this.receipts.set(id, base);
    this.log.append(id, (seq) => ({
      receipt_ref: id,
      seq,
      type: "receipt_created",
      payload: { kind, market: input.market, language: input.language },
      created_at: now,
    }));
    this.log.append(id, (seq) => ({
      receipt_ref: id,
      seq,
      type: "receipt_acknowledged",
      // templated ack: never a fix, a timeline, or a roadmap promise
      payload: { template: `${kind}_ack` },
      created_at: now,
    }));
    const routingRef = this.route(kind, base);
    this.log.append(id, (seq) => ({
      receipt_ref: id,
      seq,
      type: "receipt_routed",
      payload: { routing_ref: routingRef },
      created_at: now,
    }));
    const routed = deepFreeze(structuredClone({ ...base, status: "routed" as const, routing_ref: routingRef }));
    this.receipts.set(id, routed);
    return routed;
  }

  private route(kind: string, r: ContactReceipt): string {
    if (kind === "bug_report") {
      const submission: BugReportSubmission = {
        receipt_id: r.id,
        account_ref: r.account_ref ?? "",
        market: r.market,
        language: r.language,
        source_channel: r.source_channel,
        subject: r.subject,
        body: r.body,
      };
      return this.engineering.fileBugReport(submission);
    }
    if (kind === "vulnerability_disclosure") {
      const submission: DisclosureSubmission = {
        receipt_id: r.id,
        market: r.market,
        language: r.language,
        source_channel: r.source_channel,
        subject: r.subject,
        body: r.body,
      };
      return this.security.fileDisclosure(submission);
    }
    const submission: FeatureRequestSubmission = {
      receipt_id: r.id,
      account_ref: r.account_ref ?? "",
      market: r.market,
      language: r.language,
      source_channel: r.source_channel,
      subject: r.subject,
      body: r.body,
    };
    return this.product.fileFeatureRequest(submission);
  }

  private findOpenDuplicate(
    kind: string,
    input: ContactInput,
    now: string,
  ): ContactReceipt | undefined {
    const horizon = Date.parse(now) - this.mergeWindowMs;
    const candidates = [...this.receipts.values()].filter(
      (r) =>
        r.kind === kind &&
        r.kind !== "vulnerability_disclosure" &&
        r.account_ref === input.account_ref &&
        r.status !== "closed" &&
        r.subject === input.subject &&
        Date.parse(r.created_at) >= horizon,
    );
    return candidates[0];
  }

  private mustReceipt(id: string): ContactReceipt {
    const r = this.receipts.get(id);
    if (!r) throw new ReceiptError(`unknown receipt: ${id}`);
    return r;
  }
}
