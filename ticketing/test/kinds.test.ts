import { test } from "node:test";
import assert from "node:assert/strict";
import { ContactIntake } from "../src/intake";
import { ReceiptBook, ReceiptError } from "../src/receipts";
import { SupportService, ContactInput } from "../src/support";
import { buildTicketView } from "../src/workspace";
import { kindOf, subjectOf } from "../src/taxonomy";
import type {
  BugReportSubmission,
  DisclosureSubmission,
  FeatureRequestSubmission,
} from "../src/types";

const T0 = "2026-10-16T00:00:00.000Z";
const at = (minutes: number) =>
  new Date(Date.parse(T0) + minutes * 60_000).toISOString();

function contact(over: Partial<ContactInput> = {}): ContactInput {
  return {
    account_family: "buyer",
    account_ref: "bin_1",
    market: "US",
    language: "en-US",
    source_channel: "web_form",
    subject: "help",
    body: "something",
    intent_tag: "where_is_it",
    order_attached: true,
    ...over,
  };
}

// recording ports: the owning systems are signals, never verdicts
class RecordingPorts {
  public bugs: BugReportSubmission[] = [];
  public disclosures: DisclosureSubmission[] = [];
  public features: FeatureRequestSubmission[] = [];
  public fileBugReport(r: BugReportSubmission): string {
    this.bugs.push(r);
    return `eng_${this.bugs.length}`;
  }
  public fileDisclosure(r: DisclosureSubmission): string {
    this.disclosures.push(r);
    return `sec_${this.disclosures.length}`;
  }
  public fileFeatureRequest(r: FeatureRequestSubmission): string {
    this.features.push(r);
    return `prod_${this.features.length}`;
  }
}

const mkIntake = () => {
  const support = new SupportService();
  const ports = new RecordingPorts();
  const receipts = new ReceiptBook({
    engineering: ports,
    security: ports,
    product: ports,
  });
  const intake = new ContactIntake(support, receipts);
  return { support, ports, receipts, intake };
};

test("kind is derived from the tag when not declared, explicit kind wins", () => {
  assert.equal(kindOf({ account_family: "creator", intent_tag: "how_to" }), "question");
  assert.equal(kindOf({ account_family: "buyer", intent_tag: "listing_question" }), "question");
  assert.equal(kindOf({ account_family: "buyer", intent_tag: "where_is_it" }), "support_issue");
  assert.equal(
    kindOf({ account_family: "creator", intent_tag: "payout_issue", kind: "question" }),
    "question",
  );
});

test("subject derives from the tag, never changes routing, questions carry none", () => {
  assert.equal(subjectOf("creator", "payout_issue"), "payout");
  assert.equal(subjectOf("creator", "idv_rejected"), "idv");
  assert.equal(subjectOf("creator", "account_access"), "account");
  assert.equal(subjectOf("buyer", "where_is_it"), "order");
  assert.equal(subjectOf("buyer", "checkout_failure"), "checkout");
  assert.equal(subjectOf("buyer", "account_access"), "account");
  assert.equal(subjectOf("creator", "how_to"), null);
});

test("tickets record kind + subject on the assignment event (both families)", () => {
  const { support } = mkIntake();
  const out = support.receiveContact(
    contact({ account_family: "creator", account_ref: "cin_1", intent_tag: "idv_rejected", order_attached: false }),
    T0,
  );
  if (out.kind !== "ticketed") throw new Error("expected ticketed");
  assert.equal(out.ticket.kind, "support_issue");
  assert.equal(out.ticket.subject, "idv");
  assert.equal(out.ticket.queue, "creator_support"); // idv sits beside payout issues
  const created = support.ticketEvents(out.ticket.id).find((e) => e.type === "ticket_created");
  const payload = created?.payload as { kind: string; subject: string };
  assert.equal(payload.kind, "support_issue");
  assert.equal(payload.subject, "idv");

  // buyer question with an order attached: kind logged, queue stays attachment-based
  const q = support.receiveContact(contact({ intent_tag: "listing_question" }), at(1));
  if (q.kind !== "ticketed") throw new Error("expected ticketed");
  assert.equal(q.ticket.kind, "question");
  assert.equal(q.ticket.subject, null);
  assert.equal(q.ticket.queue, "buyer"); // kind never changes buyer routing
});

test("kind correction is a logged event; same-kind correction throws", () => {
  const { support } = mkIntake();
  const out = support.receiveContact(contact({ intent_tag: "listing_question" }), T0);
  if (out.kind !== "ticketed") throw new Error("expected ticketed");
  const corrected = support.correctKind(out.ticket.id, "agent_1", "support_issue", at(1));
  assert.equal(corrected.kind, "support_issue");
  const event = support.ticketEvents(out.ticket.id).find((e) => e.type === "kind_corrected");
  const payload = event?.payload as { from: string; to: string };
  assert.equal(payload.from, "question");
  assert.equal(payload.to, "support_issue");
  assert.throws(() => support.correctKind(out.ticket.id, "agent_1", "support_issue", at(2)));
});

test("non-ticket kinds fork to the receipt book: no case, no ticket, no queue", () => {
  const { support, ports, receipts, intake } = mkIntake();
  const before = { cases: support.caseCount(), tickets: support.ticketCount() };

  const bug = intake.receiveContact(
    contact({ kind: "bug_report", intent_tag: "other", order_attached: false, subject: "checkout button 500s", body: "500 on /checkout" }),
    T0,
  );
  if (bug.kind !== "receipt") throw new Error("expected receipt");
  assert.equal(bug.receipt.kind, "bug_report");
  assert.equal(bug.receipt.status, "routed");
  assert.equal(bug.receipt.routing_ref, "eng_1");
  assert.equal(ports.bugs.length, 1);
  assert.equal(bug.receipt.subject, "checkout button 500s");
  // the receipt path leaves the case/ticket machinery untouched
  assert.equal(support.caseCount(), before.cases);
  assert.equal(support.ticketCount(), before.tickets);

  // support itself fails loudly if a receipt kind reaches it
  assert.throws(() =>
    support.receiveContact(
      contact({ kind: "bug_report", intent_tag: "other", order_attached: false }),
      T0,
    ),
  );

  // feature requests route to the backlog, duplicates count demand
  const f1 = intake.receiveContact(
    contact({ kind: "feature_request", account_ref: "bin_9", intent_tag: "other", order_attached: false, subject: "dark mode" }),
    T0,
  );
  const f2 = intake.receiveContact(
    contact({ kind: "feature_request", account_ref: "bin_9", intent_tag: "other", order_attached: false, subject: "dark mode" }),
    at(10),
  );
  if (f1.kind !== "receipt" || f2.kind !== "receipt") throw new Error("expected receipts");
  assert.equal(f2.receipt.id, f1.receipt.id); // merged into the open receipt
  assert.equal(f2.receipt.demand_count, 2);
  assert.equal(ports.features.length, 1); // one backlog signal, demand counted

  // bug report duplicates merge into the open report within the window
  const b2 = intake.receiveContact(
    contact({ kind: "bug_report", intent_tag: "other", order_attached: false, subject: "checkout button 500s", body: "still 500" }),
    at(20),
  );
  if (b2.kind !== "receipt") throw new Error("expected receipt");
  assert.equal(b2.receipt.id, bug.receipt.id);
  assert.equal(b2.receipt.duplicate_count, 1);
  assert.equal(ports.bugs.length, 1); // no double review

  // closed receipts are not merge targets
  receipts.close(bug.receipt.id, "engineering", at(30));
  const b3 = intake.receiveContact(
    contact({ kind: "bug_report", intent_tag: "other", order_attached: false, subject: "checkout button 500s", body: "again" }),
    at(40),
  );
  if (b3.kind !== "receipt") throw new Error("expected receipt");
  assert.notEqual(b3.receipt.id, bug.receipt.id);
  assert.equal(ports.bugs.length, 2);
});

test("vulnerability disclosures are restricted: no account cross-links, no merging", () => {
  const { ports, receipts, intake } = mkIntake();
  const d1 = intake.receiveContact(
    contact({ kind: "vulnerability_disclosure", account_ref: "bin_1", intent_tag: "other", order_attached: false, subject: "xss in listing description" }),
    T0,
  );
  const d2 = intake.receiveContact(
    contact({ kind: "vulnerability_disclosure", account_ref: "bin_1", intent_tag: "other", order_attached: false, subject: "xss in listing description" }),
    at(1),
  );
  if (d1.kind !== "receipt" || d2.kind !== "receipt") throw new Error("expected receipts");
  // each disclosure is handled independently: never merged
  assert.notEqual(d1.receipt.id, d2.receipt.id);
  assert.equal(ports.disclosures.length, 2);
  // the disclosure record carries no account cross-link
  assert.equal(d1.receipt.account_ref, null);
  assert.equal(ports.disclosures[0].receipt_id, d1.receipt.id);
  // account listings never surface disclosures
  assert.equal(receipts.byAccount("bin_1").length, 0);
  // but security response can fetch by id
  assert.equal(receipts.receipt(d1.receipt.id)?.kind, "vulnerability_disclosure");
  // and a plain bug report from the same account is listed
  const b = intake.receiveContact(
    contact({ kind: "bug_report", account_ref: "bin_1", intent_tag: "other", order_attached: false, subject: "typo on pricing page" }),
    at(2),
  );
  if (b.kind !== "receipt") throw new Error("expected receipt");
  const listed = receipts.byAccount("bin_1");
  assert.equal(listed.length, 1);
  assert.equal(listed[0].kind, "bug_report");
});

test("receipt book refuses wrong kinds and the intake facade keeps cases off the receipt path", () => {
  const { receipts, intake } = mkIntake();
  assert.throws(() => receipts.file(contact({ intent_tag: "where_is_it" }), T0), ReceiptError);
  assert.throws(() =>
    intake.openCase(contact({ kind: "bug_report", intent_tag: "other", order_attached: false }), T0),
  );
  // ticketable kinds still work through the facade
  const ok = intake.openCase(contact({}), T0);
  assert.equal(ok.kind, "opened");
});

test("questions get no order/escrow/payout panels in the workspace view", () => {
  const { support } = mkIntake();
  // a buyer question carrying an order ref: kind drives the panels
  const out = support.receiveContact(
    contact({ intent_tag: "listing_question", subject: "how do I care for this piece" }),
    T0,
  );
  if (out.kind !== "ticketed") throw new Error("expected ticketed");
  const view = buildTicketView(support, out.ticket.id, at(1));
  assert.equal(view.kind, "question");
  assert.equal(view.subject, null);
  assert.deepEqual(view.order_segments, []); // no escrow panels for questions
  assert.equal(view.payout, null);

  // an issue keeps the full panels
  const issue = support.receiveContact(
    contact({ account_ref: "bin_2", intent_tag: "where_is_it", subject: "where is my order" }),
    at(2),
  );
  if (issue.kind !== "ticketed") throw new Error("expected ticketed");
  const iview = buildTicketView(support, issue.ticket.id, at(3));
  assert.equal(iview.kind, "support_issue");
  assert.equal(iview.subject, "order");
  assert.equal(iview.order_segments.length, 0); // this contact had none
  // segments flow through for issues when present
  const seg = support.receiveContact(
    contact({
      account_ref: "bin_3",
      intent_tag: "refund_request",
      order_segments: [{ segment_id: "seg_1", shop_sin: "sin_a", item_count: 1, value: 4100, escrow_state: "held" }],
    }),
    at(4),
  );
  if (seg.kind !== "ticketed") throw new Error("expected ticketed");
  const sview = buildTicketView(support, seg.ticket.id, at(5));
  assert.equal(sview.order_segments.length, 1);
});
