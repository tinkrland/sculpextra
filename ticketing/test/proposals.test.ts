import { test } from "node:test";
import assert from "node:assert/strict";
import { ProposalBridge, ProposalError } from "../src/proposals";
import { buildTicketView } from "../src/workspace";
import { SupportService, ContactInput } from "../src/support";
import type { MoneyProposal, PaymentsPort, Ticket } from "../src/types";

const T0 = "2026-10-16T00:00:00.000Z";
const at = (minutes: number) =>
  new Date(Date.parse(T0) + minutes * 60_000).toISOString();

function mkContact(over: Partial<ContactInput> = {}): ContactInput {
  return {
    account_family: "buyer",
    account_ref: "bin_1",
    market: "US",
    language: "en-US",
    source_channel: "web_form",
    subject: "refund please",
    body: "the order arrived damaged",
    intent_tag: "refund_request",
    order_attached: true,
    order_refs: ["ord_1", "ord_2"],
    order_segments: [
      { segment_id: "seg_1", shop_sin: "sin_a", item_count: 2, value: 4100, escrow_state: "held" },
    ],
    ...over,
  };
}

const mkTicket = (svc: SupportService, over: Partial<ContactInput> = {}): Ticket => {
  const out = svc.receiveContact(mkContact(over), T0);
  if (out.kind !== "ticketed") throw new Error("expected ticketed");
  svc.triage(out.ticket.id, "agent_1", at(1));
  svc.start(out.ticket.id, "agent_1", at(2));
  return out.ticket;
};

class RecordingPayments implements PaymentsPort {
  public readonly submitted: MoneyProposal[] = [];
  public submitRefund(p: MoneyProposal): void { this.submitted.push(p); }
  public submitPayoutInvestigation(p: MoneyProposal): void { this.submitted.push(p); }
}

test("a refund proposal creates an event, submits to payments, moves no state", () => {
  const svc = new SupportService();
  const payments = new RecordingPayments();
  const bridge = new ProposalBridge(svc, payments);
  const t = mkTicket(svc);

  const proposal = bridge.proposeRefund(
    t.id, "agent_1",
    { order_refs: ["ord_1"], amount_cents: 4100, reason: "arrived damaged" },
    at(3),
  );
  assert.equal(proposal.status, "proposed");
  assert.equal(payments.submitted.length, 1);
  assert.equal(payments.submitted[0].kind, "refund");

  // audit: the event carries the whole proposal
  const event = svc.ticketEvents(t.id).find((e) => e.type === "proposal_created");
  const payload = event?.payload as { order_refs: string[]; amount_cents: number };
  assert.deepEqual(payload.order_refs, ["ord_1"]);
  assert.equal(payload.amount_cents, 4100);

  // the ticket itself is untouched: the workspace proposes, it never moves money
  assert.equal(svc.getTicket(t.id)?.state, "in_progress");
});

test("refunds stay per-order: refs must be a non-empty subset of the ticket's orders", () => {
  const svc = new SupportService();
  const bridge = new ProposalBridge(svc, new RecordingPayments());
  const t = mkTicket(svc);

  assert.throws(() =>
    bridge.proposeRefund(t.id, "agent_1", { order_refs: [], amount_cents: 100, reason: "r" }, at(3)),
    ProposalError,
  );
  assert.throws(() =>
    bridge.proposeRefund(t.id, "agent_1", { order_refs: ["ord_999"], amount_cents: 100, reason: "r" }, at(3)),
    ProposalError,
  );
  assert.throws(() =>
    bridge.proposeRefund(t.id, "agent_1", { order_refs: ["ord_1"], amount_cents: 0, reason: "r" }, at(3)),
    ProposalError,
  );
  assert.throws(() =>
    bridge.proposeRefund(t.id, "agent_1", { order_refs: ["ord_1"], amount_cents: 12.5, reason: "r" }, at(3)),
    ProposalError,
  );
  assert.throws(() =>
    bridge.proposeRefund(t.id, "agent_1", { order_refs: ["ord_1"], amount_cents: 100, reason: "  " }, at(3)),
    ProposalError,
  );
  // a clean two-order proposal passes
  const ok = bridge.proposeRefund(
    t.id, "agent_1", { order_refs: ["ord_1", "ord_2"], amount_cents: 500, reason: "damaged" }, at(4),
  );
  assert.deepEqual(ok.order_refs, ["ord_1", "ord_2"]);
});

test("payout investigations live in creator_support only", () => {
  const svc = new SupportService();
  const bridge = new ProposalBridge(svc, new RecordingPayments());

  const buyerTicket = mkTicket(svc);
  assert.throws(() =>
    bridge.proposePayoutInvestigation(buyerTicket.id, "agent_1", { reason: "why so slow" }, at(3)),
    ProposalError,
  );

  const creator = mkTicket(svc, {
    account_family: "creator",
    account_ref: "cin_1",
    intent_tag: "payout_issue",
    order_attached: false,
    payout_context_present: true,
    payout_snapshot: { next_payout_date: "2026-11-15", pending_amount: 12500 },
    order_refs: [],
    order_segments: [],
  });
  const proposal = bridge.proposePayoutInvestigation(creator.id, "agent_1", { reason: "payout missing" }, at(3));
  assert.equal(proposal.kind, "payout_investigation");
  assert.equal(proposal.amount_cents, 0); // investigations propose no amount
});

test("payments posts back: results land on the same chain, exactly once", () => {
  const svc = new SupportService();
  const bridge = new ProposalBridge(svc, new RecordingPayments());
  const t = mkTicket(svc);
  const proposal = bridge.proposeRefund(
    t.id, "agent_1", { order_refs: ["ord_2"], amount_cents: 2500, reason: "never shipped" }, at(3),
  );

  const settled = bridge.recordProposalResult(proposal.id, {
    status: "executed", by: "payments", payment_ref: "pay_77",
  }, at(5));
  assert.equal(settled.status, "executed");
  assert.equal(settled, bridge.proposal(proposal.id));

  const event = svc.ticketEvents(t.id).find((e) => e.type === "proposal_result");
  const payload = event?.payload as { proposal_id: string; payment_ref?: string };
  assert.equal(payload.proposal_id, proposal.id);
  assert.equal(payload.payment_ref, "pay_77");

  // executed refunds must carry a payment reference; settled proposals do not settle twice
  const second = mkTicket(svc, { account_ref: "bin_2", subject: "again" });
  const p2 = bridge.proposeRefund(second.id, "agent_1", { order_refs: ["ord_1"], amount_cents: 100, reason: "r" }, at(6));
  assert.throws(() =>
    bridge.recordProposalResult(p2.id, { status: "executed", by: "payments" }, at(7)),
    ProposalError,
  );
  assert.throws(() =>
    bridge.recordProposalResult(proposal.id, { status: "rejected", by: "payments" }, at(7)),
    ProposalError,
  );

  // a rejection is also a valid outcome, with its reason
  const p3 = bridge.proposeRefund(second.id, "agent_1", { order_refs: ["ord_2"], amount_cents: 100, reason: "r" }, at(8));
  const rejected = bridge.recordProposalResult(p3.id, {
    status: "rejected", by: "payments", detail: "outside the refund window",
  }, at(9));
  assert.equal(rejected.status, "rejected");
});

test("proposals need an open ticket", () => {
  const svc = new SupportService();
  const bridge = new ProposalBridge(svc, new RecordingPayments());
  const t = mkTicket(svc);
  svc.respond(t.id, "agent_1", "we will look into it", at(3));
  svc.resolve(t.id, "agent_1", at(4));
  assert.throws(() =>
    bridge.proposeRefund(t.id, "agent_1", { order_refs: ["ord_1"], amount_cents: 100, reason: "late" }, at(5)),
    ProposalError,
  );
  assert.throws(() => bridge.proposeRefund("ticket_nope", "agent_1", { order_refs: ["ord_1"], amount_cents: 1, reason: "r" }, at(5)), ProposalError);
});

test("the workspace renders proposals read-only, results joined", () => {
  const svc = new SupportService();
  const bridge = new ProposalBridge(svc, new RecordingPayments());
  const t = mkTicket(svc);
  const proposal = bridge.proposeRefund(
    t.id, "agent_1", { order_refs: ["ord_1"], amount_cents: 4100, reason: "damaged" }, at(3),
  );

  const before = buildTicketView(svc, t.id, at(4));
  assert.equal(before.proposals.length, 1);
  assert.equal(before.proposals[0].status, "proposed");
  assert.equal(before.proposals[0].result, undefined);

  bridge.recordProposalResult(proposal.id, {
    status: "executed", by: "payments", payment_ref: "pay_9",
  }, at(5));

  const after = buildTicketView(svc, t.id, at(6));
  assert.equal(after.proposals[0].status, "executed");
  assert.equal(after.proposals[0].result?.payment_ref, "pay_9");
  // the view is frozen: no money controls exist on it
  assert.throws(() => {
    (after.proposals as unknown as { status: string }[]).push({ status: "executed" });
  });
});
