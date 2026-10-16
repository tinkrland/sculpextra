import { test } from "node:test";
import assert from "node:assert/strict";
import { SupportService, ContactInput, DEFAULT_CONFIG, AssignmentError, MarketError, IllegalTransitionError } from "../src/support";
import type { CoreConfig } from "../src/config";
import type { Ticket } from "../src/types";

const T0 = "2026-10-16T00:00:00.000Z";
const at = (hoursFromT0: number) =>
  new Date(Date.parse(T0) + hoursFromT0 * 3_600_000).toISOString();

function mkContact(over: Partial<ContactInput> = {}): ContactInput {
  return {
    account_family: "buyer",
    account_ref: "bin_1",
    market: "US",
    language: "en-US",
    source_channel: "web_form",
    subject: "help",
    body: "i need help",
    intent_tag: "where_is_it",
    order_attached: true,
    ...over,
  };
}

const configWith = (over: Partial<CoreConfig>): CoreConfig => ({
  ...DEFAULT_CONFIG,
  rate_limits: { ...DEFAULT_CONFIG.rate_limits },
  first_response_minutes: { ...DEFAULT_CONFIG.first_response_minutes },
  ...over,
});

test("email intake failing the eligibility gate is rejected before any case exists", () => {
  const svc = new SupportService();
  const out = svc.receiveContact(mkContact({ source_channel: "email", email_gate: "fail" }), T0);
  assert.equal(out.kind, "rejected");
  if (out.kind === "rejected") assert.match(out.reason, /themailtell/);
  assert.equal(svc.caseCount(), 0);
  assert.equal(svc.ticketCount(), 0);
});

test("email intake with an unchecked gate is also rejected", () => {
  const svc = new SupportService();
  const out = svc.receiveContact(mkContact({ source_channel: "email", email_gate: null }), T0);
  assert.equal(out.kind, "rejected");
  assert.equal(svc.caseCount(), 0);
});

test("email intake passing the gate creates a case and ticket", () => {
  const svc = new SupportService();
  const out = svc.receiveContact(mkContact({ source_channel: "email", email_gate: "pass" }), T0);
  assert.equal(out.kind, "ticketed");
  assert.equal(svc.caseCount(), 1);
});

test("web form intake skips the email gate", () => {
  const svc = new SupportService();
  const out = svc.receiveContact(mkContact(), T0);
  assert.equal(out.kind, "ticketed");
});

test("invalid markets are rejected", () => {
  const svc = new SupportService();
  assert.throws(() => svc.receiveContact(mkContact({ market: "usa" }), T0), MarketError);
  assert.throws(() => svc.receiveContact(mkContact({ market: "us" }), T0), MarketError);
  assert.equal(svc.caseCount(), 0);
});

test("invalid intent tags fail intake rather than misroute", () => {
  const svc = new SupportService();
  assert.throws(() => svc.receiveContact(mkContact({ intent_tag: "payout_issue" }), T0), AssignmentError);
  assert.equal(svc.caseCount(), 0);
});

test("a buyer order-attached contact lands in the buyer queue as a new ticket", () => {
  const svc = new SupportService();
  const out = svc.receiveContact(mkContact(), T0);
  if (out.kind !== "ticketed") throw new Error("expected ticketed");
  const { case: c, ticket, rate_limited_chip } = out;
  assert.equal(ticket.queue, "buyer");
  assert.equal(ticket.state, "new");
  assert.equal(ticket.rate_limited_chip, false);
  assert.equal(c.state, "ticketed");
  assert.equal(svc.caseEvents(c.id).length, 3); // created, tagged, ticketed
});

test("the assignment inputs are logged on the ticket's first event", () => {
  const svc = new SupportService();
  const out = svc.receiveContact(mkContact(), T0);
  if (out.kind !== "ticketed") throw new Error("expected ticketed");
  const first = svc.ticketEvents(out.ticket.id)[0];
  assert.equal(first.type, "ticket_created");
  const payload = first.payload as { queue: string; assignment_inputs: object; rule: string };
  assert.equal(payload.queue, "buyer");
  assert.deepEqual(payload.assignment_inputs, {
    account_family: "buyer",
    order_attached: true,
    payout_context_present: false,
    intent_tag: "where_is_it",
  });
  assert.ok(payload.rule.length > 0);
});

test("gate verdicts attach as case context events", () => {
  const svc = new SupportService();
  const out = svc.receiveContact(
    mkContact({
      intent_tag: "address_rejected",
      order_attached: false,
      gate_verdicts: [
        { gate: "thelocaletell", verdict: "fail", detail: "po-box ban" },
        { gate: "thephonetell", verdict: "info", detail: "voip line" },
      ],
    }),
    T0,
  );
  if (out.kind !== "ticketed") throw new Error("expected ticketed");
  const gateEvents = svc.caseEvents(out.case.id).filter((e) => e.type === "gate_verdict");
  assert.equal(gateEvents.length, 2);
  assert.equal(out.ticket.queue, "buyer_to_be");
});

test("creator payout issues route to creator_support", () => {
  const svc = new SupportService();
  const out = svc.receiveContact(
    mkContact({ account_family: "creator", account_ref: "cin_1", intent_tag: "payout_issue", order_attached: false }),
    T0,
  );
  if (out.kind !== "ticketed") throw new Error("expected ticketed");
  assert.equal(out.ticket.queue, "creator_support");
});

test("creator how-to routes to creator_question", () => {
  const svc = new SupportService();
  const out = svc.receiveContact(
    mkContact({ account_family: "creator", account_ref: "cin_1", intent_tag: "how_to", order_attached: false }),
    T0,
  );
  if (out.kind !== "ticketed") throw new Error("expected ticketed");
  assert.equal(out.ticket.queue, "creator_question");
});

test("payout snapshots are creator_support only", () => {
  const svc = new SupportService();
  const payout = { next_payout_date: "2026-11-15", pending_amount: 100 };
  assert.throws(
    () =>
      svc.receiveContact(
        mkContact({ account_family: "creator", account_ref: "cin_1", intent_tag: "how_to", order_attached: false, payout_snapshot: payout }),
        T0,
      ),
    /creator_support only/,
  );
  const ok = svc.receiveContact(
    mkContact({ account_family: "creator", account_ref: "cin_1", intent_tag: "payout_issue", order_attached: false, payout_snapshot: payout }),
    T0,
  );
  if (ok.kind !== "ticketed") throw new Error("expected ticketed");
  assert.equal(ok.ticket.payout_snapshot?.next_payout_date, "2026-11-15");
});

test("multi-store order segments are snapshotted frozen at creation", () => {
  const svc = new SupportService();
  const segments = [
    { segment_id: "seg_1", shop_sin: "sin_a", item_count: 2, value: 250, escrow_state: "held" },
    { segment_id: "seg_2", shop_sin: "sin_b", item_count: 1, value: 90, escrow_state: "held" },
  ];
  const out = svc.receiveContact(
    mkContact({ order_refs: ["ord_1", "ord_2"], order_segments: segments }),
    T0,
  );
  if (out.kind !== "ticketed") throw new Error("expected ticketed");
  assert.equal(out.ticket.order_refs.length, 2);
  assert.equal(out.ticket.order_segments.length, 2);
  assert.equal(out.ticket.order_segments[1].escrow_state, "held");
  // mutating the caller's input afterwards cannot rewrite the snapshot
  segments[0].escrow_state = "released";
  assert.equal(svc.getTicket(out.ticket.id)!.order_segments[0].escrow_state, "held");
  // and the returned ticket is frozen
  assert.throws(() => {
    (out.ticket as unknown as { queue: string }).queue = "buyer_to_be";
  });
});

test("duplicate merge: same account + same tag within 48h merges into the open ticket", () => {
  const svc = new SupportService();
  const first = svc.receiveContact(mkContact(), T0);
  const second = svc.receiveContact(mkContact({ subject: "still waiting" }), at(24));
  if (first.kind !== "ticketed" || second.kind !== "merged") {
    throw new Error(`expected ticketed then merged, got ${first.kind}/${second.kind}`);
  }
  assert.equal(second.ticket.id, first.ticket.id);
  assert.equal(second.case.state, "merged");
  assert.equal(second.case.merged_into_ticket, first.ticket.id);
  const mergedEvents = svc.ticketEvents(first.ticket.id).filter((e) => e.type === "merged_contact");
  assert.equal(mergedEvents.length, 1);
  assert.equal(svc.ticketCount(), 1);
  assert.equal(svc.caseCount(), 2);
});

test("a different intent tag does not merge", () => {
  const svc = new SupportService();
  svc.receiveContact(mkContact({ intent_tag: "where_is_it" }), T0);
  const second = svc.receiveContact(mkContact({ intent_tag: "refund_request" }), at(1));
  assert.equal(second.kind, "ticketed");
  assert.equal(svc.ticketCount(), 2);
});

test("merge only targets open tickets: a resolved ticket does not absorb", () => {
  const svc = new SupportService();
  const out = svc.receiveContact(mkContact(), T0);
  if (out.kind !== "ticketed") throw new Error("expected ticketed");
  const id = out.ticket.id;
  svc.triage(id, "agent_1", at(1));
  svc.start(id, "agent_1", at(2));
  svc.respond(id, "agent_1", "it shipped", at(3));
  svc.resolve(id, "agent_1", at(4));
  const second = svc.receiveContact(mkContact({ subject: "again" }), at(6));
  assert.equal(second.kind, "ticketed"); // resolved is neither open nor closed
  assert.equal(svc.ticketCount(), 2);
});

test("reopen within 14 days links a new ticket to the ancestor chain", () => {
  const svc = new SupportService();
  const out = svc.receiveContact(mkContact(), T0);
  if (out.kind !== "ticketed") throw new Error("expected ticketed");
  const id = out.ticket.id;
  svc.triage(id, "agent_1", at(1));
  svc.start(id, "agent_1", at(2));
  svc.respond(id, "agent_1", "here is the answer", at(3));
  svc.resolve(id, "agent_1", at(4));
  svc.close(id, "agent_1", at(5));

  const again = svc.receiveContact(mkContact({ subject: "it happened again" }), at(13 * 24));
  if (again.kind !== "reopened") throw new Error(`expected reopened, got ${again.kind}`);
  assert.equal(again.ticket.reopened_from, id);
  assert.deepEqual(svc.chainOf(again.ticket.id), [id, again.ticket.id]);
  // event history is inherited by reference: the chain carries the
  // ancestor's events plus the new ticket's own
  const chainEvents = svc.eventsOfChain(again.ticket.id);
  const ids = new Set(chainEvents.map((e) => e.ticket_ref));
  assert.deepEqual([...ids].sort(), [id, again.ticket.id].sort());
  assert.ok(chainEvents.some((e) => e.type === "response_sent")); // from the ancestor
  assert.ok(svc.ticketEvents(again.ticket.id).some((e) => e.type === "reopened"));
  assert.equal(again.case.state, "ticketed");
});

test("a matching contact after 14 days is a fresh ticket", () => {
  const svc = new SupportService();
  const out = svc.receiveContact(mkContact(), T0);
  if (out.kind !== "ticketed") throw new Error("expected ticketed");
  const id = out.ticket.id;
  svc.triage(id, "agent_1", at(1));
  svc.start(id, "agent_1", at(2));
  svc.respond(id, "agent_1", "answer", at(3));
  svc.resolve(id, "agent_1", at(4));
  svc.close(id, "agent_1", at(5));
  const late = svc.receiveContact(mkContact({ subject: "a month later" }), at(15 * 24));
  assert.equal(late.kind, "ticketed");
  if (late.kind === "ticketed") assert.equal(late.ticket.reopened_from, null);
  assert.equal(svc.ticketCount(), 2);
  assert.deepEqual(svc.chainOf(late.kind === "ticketed" ? late.ticket.id : ""), [late.kind === "ticketed" ? late.ticket.id : ""]);
});

test("rate limits trip per account per queue per day and flag a chip", () => {
  const svc = new SupportService(
    configWith({ rate_limits: { buyer: 2, buyer_to_be: 2, creator_support: 2, creator_question: 2 } }),
  );
  const tags = ["where_is_it", "refund_request", "quality_issue"];
  const results = tags.map((tag, i) =>
    svc.receiveContact(mkContact({ intent_tag: tag, order_attached: true }), at(i)),
  );
  assert.equal(results[0].kind, "ticketed");
  assert.equal(results[1].kind, "ticketed");
  const third = results[2];
  if (third.kind !== "ticketed") throw new Error("third contact should still create a ticket");
  assert.equal(third.rate_limited_chip, true); // context chip for triage, never priority
  assert.equal(third.ticket.state, "new");
  const rateEvents = svc.caseEvents(third.case.id).filter((e) => e.type === "rate_limited");
  assert.equal(rateEvents.length, 1);
  if (results[0].kind === "ticketed") assert.equal(results[0].rate_limited_chip, false);
});

test("a rate-limited contact still merges into an open ticket so nothing is lost", () => {
  const svc = new SupportService(
    configWith({ rate_limits: { buyer: 1, buyer_to_be: 1, creator_support: 1, creator_question: 1 } }),
  );
  svc.receiveContact(mkContact({ intent_tag: "where_is_it" }), T0);
  const second = svc.receiveContact(mkContact({ intent_tag: "refund_request" }), at(1));
  assert.equal(second.kind, "ticketed"); // different tag: new ticket, chip set
  const third = svc.receiveContact(mkContact({ intent_tag: "where_is_it" }), at(2));
  assert.equal(third.kind, "merged"); // same tag as the open ticket: merge, not lose
  assert.equal(svc.ticketCount(), 2);
});

test("a rate limit resets on a new day", () => {
  const svc = new SupportService(
    configWith({ rate_limits: { buyer: 1, buyer_to_be: 1, creator_support: 1, creator_question: 1 } }),
  );
  svc.receiveContact(mkContact({ intent_tag: "where_is_it" }), T0);
  const nextDay = svc.receiveContact(mkContact({ intent_tag: "quality_issue" }), at(25));
  if (nextDay.kind !== "ticketed") throw new Error("expected ticketed");
  assert.equal(nextDay.rate_limited_chip, false);
});

test("the lifecycle enforces the state machine end to end", () => {
  const svc = new SupportService();
  const out = svc.receiveContact(mkContact(), T0);
  if (out.kind !== "ticketed") throw new Error("expected ticketed");
  const id = out.ticket.id;
  assert.throws(() => svc.start(id, "agent_1", at(1)), IllegalTransitionError); // new -> in_progress is illegal
  svc.triage(id, "agent_1", at(1));
  svc.start(id, "agent_1", at(2));
  assert.throws(() => svc.resolve(id, "agent_1", at(3)), IllegalTransitionError); // in_progress -> resolved is illegal
  const afterRespond = svc.respond(id, "agent_1", "answer here", at(3));
  assert.equal(afterRespond.state, "waiting_on_user");
  assert.ok(svc.ticketEvents(id).some((e) => e.type === "response_sent"));
  svc.start(id, "agent_1", at(4)); // user replied
  svc.respond(id, "agent_1", "second answer", at(5));
  const resolved = svc.resolve(id, "agent_1", at(6));
  assert.equal(resolved.state, "resolved");
  assert.throws(() => svc.triage(id, "agent_1", at(7)), IllegalTransitionError);
  const closed = svc.close(id, "agent_1", at(8));
  assert.equal(closed.state, "closed");
  assert.equal(closed.closed_at, at(8));
  assert.ok(svc.ticketEvents(id).some((e) => e.type === "closed"));
  const states = svc.ticketEvents(id).filter((e) => e.type === "state_changed").map((e) => (e.payload as { to: string }).to);
  assert.deepEqual(states, ["triaged", "in_progress", "waiting_on_user", "in_progress", "waiting_on_user", "resolved", "closed"]);
});

test("escalation moves queue on the same chain and keeps state", () => {
  const svc = new SupportService();
  const out = svc.receiveContact(
    mkContact({ account_family: "creator", account_ref: "cin_1", intent_tag: "payout_issue", order_attached: false }),
    T0,
  );
  if (out.kind !== "ticketed") throw new Error("expected ticketed");
  svc.triage(out.ticket.id, "agent_1", at(1));
  const escalated = svc.escalate(out.ticket.id, "agent_1", "creator_question", at(2));
  assert.equal(escalated.queue, "creator_question");
  assert.equal(escalated.state, "triaged"); // unchanged
  const ev = svc.ticketEvents(out.ticket.id).find((e) => e.type === "escalated");
  assert.deepEqual((ev?.payload as { from: string; to: string }), { from: "creator_support", to: "creator_question" });
  assert.throws(() => svc.escalate(out.ticket.id, "agent_1", "creator_question", at(3)));
});

test("requeue records a correction with a reason", () => {
  const svc = new SupportService();
  const out = svc.receiveContact(mkContact(), T0);
  if (out.kind !== "ticketed") throw new Error("expected ticketed");
  const corrected = svc.requeue(out.ticket.id, "agent_1", "buyer_to_be", "no order attached, order refs were past orders", at(1));
  assert.equal(corrected.queue, "buyer_to_be");
  const ev = svc.ticketEvents(out.ticket.id).filter((e) => e.type === "queue_assigned").pop();
  assert.equal((ev?.payload as { correction: boolean }).correction, true);
  assert.throws(() => svc.requeue(out.ticket.id, "agent_1", "buyer", "", at(2)));
});

test("agent assignment and notes are events", () => {
  const svc = new SupportService();
  const out = svc.receiveContact(mkContact(), T0);
  if (out.kind !== "ticketed") throw new Error("expected ticketed");
  const t = svc.assignAgent(out.ticket.id, "agent_7", at(1));
  assert.equal(t.assigned_agent, "agent_7");
  svc.addNote(out.ticket.id, "agent_7", "checked escrow", at(2));
  const types = svc.ticketEvents(out.ticket.id).map((e) => e.type);
  assert.deepEqual(types, ["ticket_created", "queue_assigned", "agent_assigned", "note_added"]);
  assert.equal(svc.priorityOf(out.ticket.id, at(1)), 60); // age in minutes
});

test("ticketsForAccount lists newest first", () => {
  const svc = new SupportService();
  const a = svc.receiveContact(mkContact({ intent_tag: "where_is_it" }), T0);
  const b = svc.receiveContact(mkContact({ intent_tag: "refund_request" }), at(1));
  const ids = svc.ticketsForAccount("bin_1").map((t: Ticket) => t.id);
  assert.equal(ids.length, 2);
  if (a.kind === "ticketed" && b.kind === "ticketed") {
    assert.equal(ids[0], b.ticket.id);
    assert.equal(ids[1], a.ticket.id);
  }
});

test("case events are ordered and complete", () => {
  const svc = new SupportService();
  const out = svc.receiveContact(mkContact(), T0);
  if (out.kind !== "ticketed") throw new Error("expected ticketed");
  const events = svc.caseEvents(out.case.id);
  const seqs = events.map((e) => e.seq);
  assert.deepEqual(seqs, [...seqs].sort((x, y) => x - y));
  assert.deepEqual(events.map((e) => e.type), ["case_created", "intent_tagged", "ticketed"]);
});
