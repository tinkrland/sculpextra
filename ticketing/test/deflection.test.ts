import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DeflectingSupportService,
  DeflectionOutcome,
} from "../src/deflection";
import { SupportService, ContactInput } from "../src/support";
import { DEFAULT_CONFIG } from "../src/config";
import type { CoreConfig } from "../src/config";
import type { CaseEvent } from "../src/events";
import type {
  DeflectionScreen,
  LookupRequest,
  RetellDbPort,
  RetellLookup,
  SuggestedAnswer,
  Ticket,
} from "../src/types";

const T0 = "2026-10-16T00:00:00.000Z";
const at = (minutesFromT0: number) =>
  new Date(Date.parse(T0) + minutesFromT0 * 60_000).toISOString();

function mkContact(over: Partial<ContactInput> = {}): ContactInput {
  return {
    account_family: "buyer",
    account_ref: "bin_1",
    market: "US",
    language: "en-US",
    source_channel: "web_form",
    subject: "where is my order",
    body: "i ordered three days ago and it has not shipped",
    intent_tag: "where_is_it",
    order_attached: true,
    ...over,
  };
}

const mkAnswer = (i: number): SuggestedAnswer => ({
  doc_id: `doc_${i}`,
  title: `Answer ${i}`,
  snippet: `snippet ${i}`,
  url: `https://help.example.com/doc-${i}`,
});

class FakeRetell implements RetellDbPort {
  public lastRequest: LookupRequest | null = null;
  public failWith: Error | null = null;
  constructor(private readonly answers: readonly SuggestedAnswer[]) {}

  public lookup(request: LookupRequest): RetellLookup {
    this.lastRequest = request;
    if (this.failWith) throw this.failWith;
    return {
      answers: this.answers,
      engine_path: "tag_traversal",
      latency_ms: 4,
    };
  }
}

const configWith = (over: Partial<CoreConfig["deflection"]>): CoreConfig => ({
  ...DEFAULT_CONFIG,
  rate_limits: { ...DEFAULT_CONFIG.rate_limits },
  first_response_minutes: { ...DEFAULT_CONFIG.first_response_minutes },
  deflection: { ...DEFAULT_CONFIG.deflection, ...over },
});

const deflected = (
  port: RetellDbPort | null,
  config: CoreConfig = DEFAULT_CONFIG,
): DeflectingSupportService => new DeflectingSupportService(undefined, port, config);

const caseEvents = (svc: DeflectingSupportService, caseId: string): readonly CaseEvent[] =>
  svc.inner.caseEvents(caseId);

test("a lookup with answers offers a deflection screen before any ticket exists", () => {
  const port = new FakeRetell([mkAnswer(1), mkAnswer(2)]);
  const svc = deflected(port);
  const out = svc.receiveContact(mkContact(), T0);

  assert.equal(out.kind, "deflection");
  if (out.kind !== "deflection") return;
  assert.equal(out.case.state, "open");
  assert.equal(svc.inner.ticketCount(), 0);

  // event order: created, tagged, lookup, offered
  const types = caseEvents(svc, out.case.id).map((e) => e.type);
  assert.deepEqual(types, [
    "case_created",
    "intent_tagged",
    "lookup_result",
    "deflection_offered",
  ]);

  // the screen carries the answers in lookup order, frozen
  const screen: DeflectionScreen = out.screen;
  assert.deepEqual(screen.answers.map((a) => a.doc_id), ["doc_1", "doc_2"]);
  assert.throws(() => {
    (screen.answers as SuggestedAnswer[]).push(mkAnswer(3));
  });
  assert.equal(screen.engine_path, "tag_traversal");

  // the lookup received the case text, market, language, audience, top_k
  assert.equal(port.lastRequest?.text, "where is my order\n\ni ordered three days ago and it has not shipped");
  assert.equal(port.lastRequest?.market, "US");
  assert.equal(port.lastRequest?.language, "en-US");
  assert.equal(port.lastRequest?.audience_hint, "buyer");
  assert.equal(port.lastRequest?.top_k, 5);
});

test("marking the answers resolved deflects the case; no ticket is ever created", () => {
  const svc = deflected(new FakeRetell([mkAnswer(1)]));
  const out = svc.receiveContact(mkContact(), T0);
  assert.equal(out.kind, "deflection");
  if (out.kind !== "deflection") return;

  const c = svc.markResolved(out.case.id, at(2));
  assert.equal(c.state, "deflected");
  assert.equal(svc.inner.ticketCount(), 0);
  const types = caseEvents(svc, c.id).map((e) => e.type);
  assert.deepEqual(types.slice(-1), ["deflection_accepted"]);

  // a deflected case can never request a human afterwards
  assert.throws(() => svc.stillNeedHuman(c.id, at(3)));
});

test("the single human click creates the ticket with the deflection history summarized", () => {
  const svc = deflected(new FakeRetell([mkAnswer(1), mkAnswer(2)]));
  const out = svc.receiveContact(mkContact(), T0);
  assert.equal(out.kind, "deflection");
  if (out.kind !== "deflection") return;

  const human = svc.stillNeedHuman(out.case.id, at(1));
  assert.equal(human.kind, "ticketed");
  const t: Ticket = human.ticket;
  assert.equal(t.queue, "buyer"); // order attached
  assert.equal(t.deflection_summary, "lookup 2 answers (tag_traversal); offered; human requested");

  // human_requested precedes ticketed on the case
  const types = caseEvents(svc, out.case.id).map((e) => e.type);
  assert.deepEqual(types, [
    "case_created",
    "intent_tagged",
    "lookup_result",
    "deflection_offered",
    "human_requested",
    "ticketed",
  ]);
  assert.equal(svc.inner.getCase(t.case_ref)?.state, "ticketed");

  // exactly one click: a second request on the same case fails loudly
  assert.throws(() => svc.stillNeedHuman(out.case.id, at(2)));
});

test("an empty lookup goes straight to a ticket: no empty screen, no extra click", () => {
  const svc = deflected(new FakeRetell([]));
  const out = svc.receiveContact(mkContact(), T0);
  assert.equal(out.kind, "ticketed");
  if (out.kind !== "ticketed") return;
  assert.equal(out.ticket.deflection_summary, "lookup returned no answers; straight to ticket");

  const types = caseEvents(svc, out.case.id).map((e) => e.type);
  assert.ok(!types.includes("deflection_offered"), "nothing was offered");
  assert.ok(types.includes("lookup_result"));
});

test("a failing lookup never blocks a human: straight to ticket, failure logged", () => {
  const port = new FakeRetell([mkAnswer(1)]);
  port.failWith = new Error("retelldb unreachable");
  const svc = deflected(port);
  const out = svc.receiveContact(mkContact(), T0);
  assert.equal(out.kind, "ticketed");
  if (out.kind !== "ticketed") return;
  assert.match(out.ticket.deflection_summary ?? "", /lookup failed \(retelldb unreachable\); straight to ticket/);

  const lookup = caseEvents(svc, out.case.id).find((e) => e.type === "lookup_result");
  assert.equal((lookup?.payload as { error?: string }).error, "retelldb unreachable");
});

test("no port is straight-to-ticket mode until deflection content exists", () => {
  const svc = deflected(null);
  const out = svc.receiveContact(mkContact(), T0);
  assert.equal(out.kind, "ticketed");
  if (out.kind !== "ticketed") return;
  assert.equal(out.ticket.deflection_summary, "no deflection attempted");
  assert.equal(out.ticket.queue, "buyer");
});

test("deflection disabled in config is straight-to-ticket even with a port", () => {
  const svc = deflected(new FakeRetell([mkAnswer(1)]), configWith({ enabled: false }));
  const out = svc.receiveContact(mkContact(), T0);
  assert.equal(out.kind, "ticketed");
  if (out.kind !== "ticketed") return;
  assert.equal(out.ticket.deflection_summary, "no deflection attempted");
});

test("contacts merging into an open ticket skip the deflection screen entirely", () => {
  const svc = deflected(new FakeRetell([mkAnswer(1)]));
  const first = svc.receiveContact(mkContact(), T0);
  assert.equal(first.kind, "deflection");
  if (first.kind !== "deflection") return;
  const t = svc.stillNeedHuman(first.case.id, at(1)).ticket;

  // same account + same tag while the ticket is open: merge, no screen
  const second = svc.receiveContact(mkContact({ subject: "still waiting" }), at(5));
  assert.equal(second.kind, "merged");
  if (second.kind !== "merged") return;
  assert.equal(second.ticket.id, t.id);
  assert.equal(second.case.state, "merged");
});

test("merge targets are re-evaluated at human-click time", () => {
  const svc = deflected(new FakeRetell([mkAnswer(1)]));
  // two open cases for the same account + tag, neither ticketed yet
  const a = svc.receiveContact(mkContact(), T0);
  const b = svc.receiveContact(mkContact({ subject: "again" }), at(1));
  assert.equal(a.kind, "deflection");
  assert.equal(b.kind, "deflection");
  if (a.kind !== "deflection" || b.kind !== "deflection") return;

  const first = svc.stillNeedHuman(a.case.id, at(2));
  assert.equal(first.kind, "ticketed");

  // by the time b's user clicks, a's open ticket is a merge target
  const second = svc.stillNeedHuman(b.case.id, at(3));
  assert.equal(second.kind, "merged");
  if (second.kind !== "merged") return;
  assert.equal(second.ticket.id, first.ticket.id);
  assert.equal(second.case.state, "merged");
});

test("rate-limited accounts still get the chip through the deflection flow", () => {
  // buyer limit 1: the first ticket trips the limit; the second
  // contact (different tag, same account, order attached -> buyer
  // queue) opens a case that is already chipped at intake.
  const cfg = {
    ...DEFAULT_CONFIG,
    rate_limits: { buyer: 1, buyer_to_be: 1, creator_support: 1, creator_question: 1 },
    first_response_minutes: { ...DEFAULT_CONFIG.first_response_minutes },
    deflection: { ...DEFAULT_CONFIG.deflection },
  };
  const svc = new DeflectingSupportService(undefined, new FakeRetell([mkAnswer(1)]), cfg);

  const first = svc.receiveContact(mkContact(), T0);
  assert.equal(first.kind, "deflection");
  if (first.kind !== "deflection") return;
  assert.equal(first.rate_limited_chip, false);
  const firstTicket = svc.stillNeedHuman(first.case.id, at(1));
  assert.equal(firstTicket.rate_limited_chip, false);

  const second = svc.receiveContact(
    mkContact({ intent_tag: "refund_request", subject: "i want a refund" }),
    at(2),
  );
  assert.equal(second.kind, "deflection");
  if (second.kind !== "deflection") return;
  assert.equal(second.rate_limited_chip, true);

  const human = svc.stillNeedHuman(second.case.id, at(3));
  assert.equal(human.kind, "ticketed");
  if (human.kind !== "ticketed") return;
  assert.equal(human.ticket.rate_limited_chip, true);
  const types = caseEvents(svc, second.case.id).map((e) => e.type);
  assert.ok(types.includes("rate_limited"));
});

test("a reopened contact through the deflection flow links the chain", () => {
  const svc = deflected(new FakeRetell([mkAnswer(1)]));
  const first = svc.receiveContact(mkContact(), T0);
  if (first.kind !== "deflection") return;
  const t1 = svc.stillNeedHuman(first.case.id, at(1)).ticket;
  // answer, resolve, close within the reopen window
  const agent = "agent_1";
  svc.inner.triage(t1.id, agent, at(2));
  svc.inner.start(t1.id, agent, at(3));
  svc.inner.respond(t1.id, agent, "it shipped yesterday", at(4));
  svc.inner.resolve(t1.id, agent, at(5));
  svc.inner.close(t1.id, agent, at(6));

  const again = svc.receiveContact(mkContact({ subject: "it happened again" }), at(600));
  if (again.kind !== "deflection") return;
  const human = svc.stillNeedHuman(again.case.id, at(601));
  assert.equal(human.kind, "reopened");
  if (human.kind !== "reopened") return;
  assert.equal(human.ticket.reopened_from, t1.id);
});

test("deflection intake enforces the same email eligibility gate", () => {
  const svc = deflected(new FakeRetell([mkAnswer(1)]));
  const out = svc.receiveContact(
    mkContact({ source_channel: "email", email_gate: "fail" }),
    T0,
  );
  assert.equal(out.kind, "rejected");
  if (out.kind === "rejected") assert.match(out.reason, /themailtell/);
  assert.equal(svc.inner.caseCount(), 0);
});

test("creator contacts route by the same assignment rules after the human click", () => {
  const svc = deflected(new FakeRetell([mkAnswer(1)]));
  const out = svc.receiveContact(
    mkContact({
      account_family: "creator",
      account_ref: "cin_1",
      intent_tag: "how_to",
      order_attached: false,
    }),
    T0,
  );
  if (out.kind !== "deflection") return;
  const human = svc.stillNeedHuman(out.case.id, at(1));
  assert.equal(human.kind, "ticketed");
  if (human.kind !== "ticketed") return;
  assert.equal(human.ticket.queue, "creator_question"); // nothing money-adjacent
});

test("offering deflection on a case that is not an open intake fails loudly", () => {
  const support = new SupportService();
  const svc = deflected(new FakeRetell([mkAnswer(1)]));
  const ticketed = support.receiveContact(mkContact(), T0);
  assert.equal(ticketed.kind, "ticketed");
  // phase 1 tickets have no deflection session
  const out = svc.receiveContact(mkContact({ subject: "next" }), at(1));
  if (out.kind !== "deflection") return;
  svc.markResolved(out.case.id, at(2));
  assert.throws(() => support.offerDeflection(out.case.id, at(3)));
});
