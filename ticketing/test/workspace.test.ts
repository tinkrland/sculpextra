import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTicketView, WorkspaceError } from "../src/workspace";
import { DeflectingSupportService } from "../src/deflection";
import { SupportService, ContactInput } from "../src/support";
import type { RetellDbPort, RetellLookup, SuggestedAnswer, Ticket } from "../src/types";

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
    subject: "where is my order",
    body: "it has not shipped",
    intent_tag: "where_is_it",
    order_attached: true,
    order_refs: ["ord_1", "ord_2"],
    order_segments: [
      { segment_id: "seg_1", shop_sin: "sin_a", item_count: 2, value: 4100, escrow_state: "held" },
      { segment_id: "seg_2", shop_sin: "sin_b", item_count: 1, value: 2500, escrow_state: "released" },
    ],
    gate_verdicts: [
      { gate: "thephonetell", verdict: "info", detail: "line type: mobile" },
    ],
    ...over,
  };
}

const mkAnswer = (i: number): SuggestedAnswer => ({
  doc_id: `doc_${i}`,
  title: `Answer ${i}`,
  snippet: `snippet ${i}`,
  url: `https://kb.sculptura.com/doc-${i}`,
});

class FakeRetell implements RetellDbPort {
  public lookup(): RetellLookup {
    return { answers: [mkAnswer(1), mkAnswer(2)], engine_path: "tag_traversal", latency_ms: 3 };
  }
}

const ticketThroughDeflection = (svc: DeflectingSupportService, over: Partial<ContactInput> = {}): Ticket => {
  const out = svc.receiveContact(mkContact(over), T0);
  if (out.kind === "deflection") {
    const human = svc.stillNeedHuman(out.case.id, at(1));
    if (human.kind !== "ticketed") throw new Error("expected ticketed");
    return human.ticket;
  }
  if (out.kind === "ticketed") return out.ticket;
  throw new Error("expected a deflection or ticketed outcome");
};

test("the workspace view shows every panel from the record, frozen", () => {
  const svc = new DeflectingSupportService(undefined, new FakeRetell());
  const t = ticketThroughDeflection(svc);
  const view = buildTicketView(svc.inner, t.id, at(30));

  assert.equal(view.ticket.id, t.id);
  assert.equal(view.identity.account_ref, "bin_1");
  assert.equal(view.identity.market, "US");
  assert.equal(view.identity.language, "en-US");
  assert.equal(view.identity.intent_tag, "where_is_it");
  assert.deepEqual(view.order_refs, ["ord_1", "ord_2"]);
  assert.equal(view.order_segments.length, 2);
  assert.equal(view.order_segments[0].escrow_state, "held");
  assert.equal(view.payout, null); // buyer queue: no payout panel
  assert.equal(view.chain.length, 1);

  // priority is age-only: the ticket opened at the human click
  // (at(1)), so at(30) it is 29 minutes old
  assert.equal(view.priority.age_minutes, 29);
  assert.equal(view.priority.score, 29);

  // phone context renders as a chip, never a ranking input
  const chip = view.identity.chips.find((c) => c.label === "thephonetell");
  assert.ok(chip, "gate verdict should be a chip");
  assert.equal(chip.detail, "line type: mobile");
  assert.ok(view.identity.chips.some((c) => c.label === "deflected_once"));

  // deflection history is event-sourced and complete
  assert.deepEqual(view.deflection_history.map((h) => h.what), [
    "lookup",
    "offered",
    "human_requested",
  ]);

  // retelldb suggestions are drafts, in offer order
  assert.deepEqual(view.drafts.map((d) => d.doc_id), ["doc_1", "doc_2"]);

  // the view is frozen: the workspace cannot rewrite the record
  assert.throws(() => {
    (view as unknown as { drafts: SuggestedAnswer[] }).drafts.push(mkAnswer(9));
  });
  assert.throws(() => buildTicketView(svc.inner, "ticket_nope", at(30)), WorkspaceError);
});

test("creator_support tickets show the payout schedule panel", () => {
  const svc = new DeflectingSupportService(undefined, new FakeRetell());
  const t = ticketThroughDeflection(svc, {
    account_family: "creator",
    account_ref: "cin_1",
    intent_tag: "payout_issue",
    order_attached: false,
    payout_context_present: true,
    payout_snapshot: { next_payout_date: "2026-11-15", pending_amount: 12500 },
    order_refs: [],
    order_segments: [],
  });
  const view = buildTicketView(svc.inner, t.id, at(5));
  assert.equal(t.queue, "creator_support");
  assert.equal(view.payout?.next_payout_date, "2026-11-15");
  assert.equal(view.payout?.pending_amount, 12500);
  assert.equal(view.order_segments.length, 0);
});

test("the priority curve stays a function of age alone", () => {
  const svc = new SupportService();
  const out = svc.receiveContact(mkContact(), T0);
  if (out.kind !== "ticketed") throw new Error("expected ticketed");
  const view = buildTicketView(svc, out.ticket.id, at(120));
  assert.equal(view.priority.score, 120); // default curve: identity
});

test("straight-to-ticket contacts carry no drafts and a bare history", () => {
  const svc = new DeflectingSupportService(undefined, null); // no port
  const t = ticketThroughDeflection(svc);
  const view = buildTicketView(svc.inner, t.id, at(2));
  assert.equal(view.drafts.length, 0);
  // no lookup, no offer - but the synthesized human request is part
  // of the honest event-sourced history
  assert.deepEqual(view.deflection_history.map((h) => h.what), ["human_requested"]);
  assert.ok(!view.identity.chips.some((c) => c.label === "deflected_once"));
});
