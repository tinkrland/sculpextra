import { test } from "node:test";
import assert from "node:assert/strict";
import { SupportService, ContactInput } from "../src/support";
import { measure } from "../src/measurement";
import { DEFAULT_CONFIG } from "../src/config";
import type { RetellLookup, Ticket } from "../src/types";

const T0 = "2026-10-10T00:00:00.000Z";
const at = (minutes: number) =>
  new Date(Date.parse(T0) + minutes * 60_000).toISOString();
const FROM = T0;
const TO = at(2000);

const contact = (over: Partial<ContactInput> = {}): ContactInput => ({
  account_family: "buyer",
  account_ref: "bin_x",
  market: "US",
  language: "en-US",
  source_channel: "web_form",
  subject: "s",
  body: "b",
  intent_tag: "where_is_it",
  order_attached: true,
  ...over,
});

const lookup: RetellLookup = {
  answers: [{ doc_id: "d1", title: "t", snippet: "s", url: "https://help.example.com/d1" }],
  engine_path: "tag_traversal",
  latency_ms: 4,
};

const ticketed = (svc: SupportService, input: ContactInput, now: string): Ticket => {
  const out = svc.receiveContact(input, now);
  if (out.kind !== "ticketed") throw new Error(`expected ticketed, got ${out.kind}`);
  return out.ticket;
};

test("the measurement job aggregates from events only", () => {
  const svc = new SupportService(DEFAULT_CONFIG);

  // buyer A: created, triaged, responded within target, resolved, closed
  const a = ticketed(svc, contact({ account_ref: "bin_a" }), at(0));
  svc.triage(a.id, "ag1", at(1));
  svc.start(a.id, "ag1", at(2));
  svc.respond(a.id, "ag1", "on its way", at(180)); // within 240
  svc.resolve(a.id, "ag1", at(200));
  svc.close(a.id, "ag1", at(300));

  // rate-limit account: 5 distinct buyer tags, then a 6th that trips and merges
  const rlTags = ["where_is_it", "refund_request", "quality_issue", "manufacturer_delay", "account_access"];
  rlTags.forEach((tag, i) => {
    ticketed(svc, contact({ account_ref: "bin_rl", intent_tag: tag }), at(10 + i));
  });
  // the 6th same-day contact trips the rate limit and still merges,
  // so nothing is lost; the trip is logged on the case (no chip field
  // exists on the merged outcome - the report carries the signal)
  const tripped = svc.receiveContact(contact({ account_ref: "bin_rl" }), at(15));
  assert.equal(tripped.kind, "merged");

  // buyer D: a question (listing_question), corrected to an issue later
  const d = ticketed(svc, contact({ account_ref: "bin_d", intent_tag: "listing_question" }), at(30));
  svc.triage(d.id, "ag1", at(31));
  svc.start(d.id, "ag1", at(32));
  svc.respond(d.id, "ag1", "care guide link", at(100)); // within 240
  const dCorrected = svc.correctKind(d.id, "ag1", "support_issue", at(110));
  assert.equal(dCorrected.subject, "checkout"); // listing tag maps to checkout; retag would move it

  // reopen A via a fresh contact (closed within 14 days), then requeue it
  const reopened = svc.receiveContact(contact({ account_ref: "bin_a" }), at(1000));
  assert.equal(reopened.kind, "reopened");
  if (reopened.kind === "reopened") {
    svc.requeue(reopened.ticket.id, "ag1", "buyer_to_be", "miscategorized at intake", at(1010));
  }

  // buyer_to_be B: responded outside target, then corrected queue
  const b = ticketed(
    svc,
    contact({ account_ref: "bin_b", intent_tag: "checkout_failure", order_attached: false }),
    at(40),
  );
  svc.triage(b.id, "ag1", at(41));
  svc.start(b.id, "ag1", at(42));
  svc.respond(b.id, "ag1", "retry checkout", at(170)); // created at(40): 130 min, target 120: outside

  // creator C: idv issue, slow response outside target
  const c = ticketed(
    svc,
    contact({
      account_family: "creator",
      account_ref: "cin_c",
      intent_tag: "idv_rejected",
      order_attached: false,
    }),
    at(50),
  );
  svc.triage(c.id, "ag2", at(51));
  svc.start(c.id, "ag2", at(52));
  svc.respond(c.id, "ag2", "reupload id", at(600)); // created at(50): 550 min, target 480: outside

  // creator E: payout issue retagged to idv and back (the confound)
  const e = ticketed(
    svc,
    contact({
      account_family: "creator",
      account_ref: "cin_e",
      intent_tag: "payout_issue",
      order_attached: false,
    }),
    at(60),
  );
  const eIdv = svc.retag(e.id, "ag2", "idv_rejected", "payout blocked on idv hold", at(70));
  assert.equal(eIdv.subject, "idv");
  const eBack = svc.retag(eIdv.id, "ag2", "payout_issue", "idv cleared", at(80));
  assert.equal(eBack.subject, "payout");

  // deflection: one deflected, one human
  const f = svc.openCase(contact({ account_ref: "bin_f" }), at(200));
  if (f.kind !== "opened") throw new Error("expected opened");
  svc.logLookup(f.case.id, lookup, at(201));
  svc.offerDeflection(f.case.id, at(202));
  svc.acceptDeflection(f.case.id, at(203));

  const g = svc.openCase(
    contact({ account_ref: "bin_g", intent_tag: "checkout_failure", order_attached: false }),
    at(201),
  );
  if (g.kind !== "opened") throw new Error("expected opened");
  svc.logLookup(g.case.id, lookup, at(202));
  svc.offerDeflection(g.case.id, at(203));
  svc.requestHuman(g.case.id, at(204));

  const report = measure(svc, DEFAULT_CONFIG, FROM, TO);

  // frozen report
  assert.ok(Object.isFrozen(report));
  assert.ok(Object.isFrozen(report.queues.buyer));
  assert.ok(Object.isFrozen(report.intake));

  // buyer queue: A + D + 5 rate-limit tickets + 1 reopen = 8
  const buyer = report.queues.buyer;
  assert.equal(buyer.tickets_created, 8);
  assert.equal(buyer.first_response.responses, 2);
  assert.equal(buyer.first_response.within_target, 2);
  assert.equal(buyer.first_response.median_minutes, 125); // median of 180 (A) and 70 (D)
  assert.equal(buyer.resolved, 1);
  assert.equal(buyer.reopened, 1);
  assert.equal(buyer.merged_contacts, 1);
  // the reopen's requeue to buyer_to_be is attributed to buyer: its
  // assignment was wrong, so buyer's misroute rate is 1/8
  assert.equal(buyer.misroutes, 1);
  assert.equal(buyer.misroute_rate, 0.125);
  assert.equal(buyer.kind_share.question, 1);
  assert.equal(buyer.kind_share.issue, 7);
  // issues created in buyer: A + reopen (order), 4 rate-limit tickets
  // (order), and the account_access ticket (account)
  assert.deepEqual(buyer.subjects, { order: 6, account: 1 });
  // burst off: everything lands outside the (empty) windows
  assert.equal(buyer.burst.in_window.responses, 0);
  assert.equal(buyer.burst.out_window.responses, 2);

  // buyer_to_be: B + G's human ticket = 2 created; 1 misroute (the requeue)
  const btb = report.queues.buyer_to_be;
  assert.equal(btb.tickets_created, 2);
  assert.equal(btb.first_response.responses, 1);
  assert.equal(btb.first_response.within_target, 0);
  assert.equal(btb.first_response.median_minutes, 130);
  assert.equal(btb.misroutes, 0);
  assert.equal(btb.misroute_rate, 0);

  // creator_support: C + E, one slow response, idv + payout subjects
  const cs = report.queues.creator_support;
  assert.equal(cs.tickets_created, 2);
  assert.equal(cs.first_response.responses, 1);
  assert.equal(cs.first_response.within_target, 0);
  assert.equal(cs.first_response.median_minutes, 550);
  assert.deepEqual(cs.subjects, { idv: 1, payout: 1 });
  assert.equal(cs.kind_share.issue, 2);

  // creator_question: untouched this window
  assert.equal(report.queues.creator_question.tickets_created, 0);

  // intake
  const intake = report.intake;
  assert.equal(intake.contacts, 14); // 11 straight tickets/merges + reopen + 2 deflection cases
  assert.equal(intake.lookups, 2);
  assert.equal(intake.offered, 2);
  assert.equal(intake.deflected, 1);
  assert.equal(intake.deflection_rate, 0.5);
  assert.equal(intake.human_requested, 1);
  assert.equal(intake.merged, 1);
  assert.equal(intake.rate_limit_trips, 1);
  assert.deepEqual(intake.rate_limit_by_account, { bin_rl: 1 });
  assert.deepEqual(intake.by_intent_tag.where_is_it, { lookups: 1, offered: 1, deflected: 1 });
  assert.deepEqual(intake.by_intent_tag.checkout_failure, { lookups: 1, offered: 1, deflected: 0 });
  assert.deepEqual(intake.by_market.US, { lookups: 2, offered: 2, deflected: 1 });

  // kind axis + confound
  assert.equal(report.kind_corrections, 1); // D's correction; the retags kept kind=issue
  assert.equal(report.retags, 2);
  assert.equal(report.payout_idv_confound, 2); // to idv and back
});

test("the measurement window is honored and empty windows fail loudly", () => {
  const svc = new SupportService(DEFAULT_CONFIG);
  ticketed(svc, contact({ account_ref: "bin_1" }), T0);
  // window that ends before the ticket: nothing created inside it
  const early = measure(svc, DEFAULT_CONFIG, "2026-10-01T00:00:00Z", "2026-10-02T00:00:00Z");
  assert.equal(early.queues.buyer.tickets_created, 0);
  assert.equal(early.intake.contacts, 0);
  // a window that includes it
  const wide = measure(svc, DEFAULT_CONFIG, "2026-10-09T00:00:00Z", "2026-10-11T00:00:00Z");
  assert.equal(wide.queues.buyer.tickets_created, 1);
  // nonsense window
  assert.throws(() => measure(svc, DEFAULT_CONFIG, T0, T0));
});
