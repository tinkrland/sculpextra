import { test } from "node:test";
import assert from "node:assert/strict";
import { RoutingService, RoutingError } from "../src/routing";
import { SupportService, ContactInput } from "../src/support";
import { DEFAULT_CONFIG } from "../src/config";
import type { CoreConfig } from "../src/config";
import type { AgentProfile } from "../src/types";

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
    subject: "help",
    body: "i need help",
    intent_tag: "where_is_it",
    order_attached: true,
    ...over,
  };
}

const mkTicket = (svc: SupportService, over: Partial<ContactInput> = {}) => {
  const out = svc.receiveContact(mkContact(over), T0);
  if (out.kind !== "ticketed") throw new Error("expected ticketed");
  return out.ticket;
};

const agent = (id: string, handles: AgentProfile["handles"], over: Partial<AgentProfile> = {}): AgentProfile => ({
  id,
  handles,
  ...over,
});

const key = { queue: "buyer" as const, market: "US", language: "en-US" };

test("routes to the agent matching the exact (queue, market, language) set", () => {
  const svc = new SupportService();
  const router = new RoutingService(svc);
  router.addAgent(agent("a_us", [key]));
  router.addAgent(agent("a_de", [{ queue: "buyer", market: "DE", language: "de-DE" }]));
  const t = mkTicket(svc);

  const routed = router.assignTicket(t.id, at(1));
  assert.equal(routed?.assigned_agent, "a_us");

  // the assignment is an event, and misroutes stay auditable
  const events = svc.ticketEvents(t.id);
  assert.ok(events.some((e) => e.type === "agent_assigned"));
});

test("an agent with a superset of handles still matches only exact keys", () => {
  const svc = new SupportService();
  const router = new RoutingService(svc);
  router.addAgent(agent("a_multi", [key, { queue: "buyer", market: "GB", language: "en-GB" }]));
  const t = mkTicket(svc);
  assert.equal(router.assignTicket(t.id, at(1))?.assigned_agent, "a_multi");

  // nobody handles fr-FR buyers: the ticket stays queued
  const fr = mkTicket(svc, { market: "FR", language: "fr-FR", account_ref: "bin_2" });
  assert.equal(router.assignTicket(fr.id, at(2)), null);
  assert.equal(svc.getTicket(fr.id)?.assigned_agent, null);
});

test("round-robin alternates between eligible agents", () => {
  const svc = new SupportService();
  const router = new RoutingService(svc);
  router.addAgent(agent("a1", [key]));
  router.addAgent(agent("a2", [key]));

  const ids = [0, 1, 2, 3].map((i) => mkTicket(svc, { account_ref: `bin_${i}`, subject: `t${i}` }).id);
  const got = ids.map((id, i) => router.assignTicket(id, at(i + 1))?.assigned_agent);
  assert.deepEqual(got, ["a1", "a2", "a1", "a2"]);
});

test("agents at their concurrency cap are skipped, not chosen", () => {
  const svc = new SupportService();
  const router = new RoutingService(svc);
  // a1 capped at its own 1, a2 under the config default (3)
  router.addAgent(agent("a1", [key], { concurrency_cap: 1 }));
  router.addAgent(agent("a2", [key]));

  const first = router.assignTicket(mkTicket(svc).id, at(1));
  assert.equal(first?.assigned_agent, "a1"); // rotation still starts fair
  const second = router.assignTicket(mkTicket(svc, { account_ref: "bin_2" }).id, at(2));
  assert.equal(second?.assigned_agent, "a2"); // a1 at cap: skipped
  const third = router.assignTicket(mkTicket(svc, { account_ref: "bin_3" }).id, at(3));
  assert.equal(third?.assigned_agent, "a2");
});

test("when everyone is at cap the ticket stays queued, never lost", () => {
  const config: CoreConfig = {
    ...DEFAULT_CONFIG,
    rate_limits: { ...DEFAULT_CONFIG.rate_limits },
    first_response_minutes: { ...DEFAULT_CONFIG.first_response_minutes },
    agent_concurrency: { buyer: 1, buyer_to_be: 1, creator_support: 1, creator_question: 1 },
    priority_curve: [...DEFAULT_CONFIG.priority_curve],
    content_link_hosts: [...DEFAULT_CONFIG.content_link_hosts],
    deflection: { ...DEFAULT_CONFIG.deflection },
  };
  const svc = new SupportService(config);
  const router = new RoutingService(svc, config);
  router.addAgent(agent("only", [key]));

  const t1 = mkTicket(svc);
  assert.equal(router.assignTicket(t1.id, at(1))?.assigned_agent, "only");
  const t2 = mkTicket(svc, { account_ref: "bin_2" });
  assert.equal(router.assignTicket(t2.id, at(2)), null);
  assert.equal(svc.getTicket(t2.id)?.state, "new"); // queued, untouched

  // capacity frees on resolve: t2 routes now
  svc.triage(t1.id, "only", at(3));
  svc.start(t1.id, "only", at(4));
  svc.respond(t1.id, "only", "here is the answer", at(5));
  svc.resolve(t1.id, "only", at(6));
  assert.equal(router.assignTicket(t2.id, at(7))?.id, t2.id);
});

test("waiting_on_user tickets still count against the cap", () => {
  const svc = new SupportService();
  const router = new RoutingService(svc);
  router.addAgent(agent("a1", [key], { concurrency_cap: 1 }));

  const t1 = mkTicket(svc);
  router.assignTicket(t1.id, at(1));
  svc.triage(t1.id, "a1", at(2));
  svc.start(t1.id, "a1", at(3));
  svc.respond(t1.id, "a1", "waiting for your reply", at(4));

  // the agent still owns the waiting ticket: no second assignment
  const t2 = mkTicket(svc, { account_ref: "bin_2" });
  assert.equal(router.assignTicket(t2.id, at(5)), null);
});

test("routing a closed or assigned ticket fails loudly", () => {
  const svc = new SupportService();
  const router = new RoutingService(svc);
  router.addAgent(agent("a1", [key]));

  const t = mkTicket(svc);
  router.assignTicket(t.id, at(1));
  assert.throws(() => router.assignTicket(t.id, at(2)), RoutingError); // already assigned

  const closed = mkTicket(svc, { account_ref: "bin_2" });
  svc.triage(closed.id, "a1", at(3));
  svc.start(closed.id, "a1", at(4));
  svc.respond(closed.id, "a1", "done", at(5));
  svc.resolve(closed.id, "a1", at(6));
  svc.close(closed.id, "a1", at(7));
  assert.throws(() => router.assignTicket(closed.id, at(8)), RoutingError);

  assert.throws(() => router.assignTicket("ticket_nope", at(9)), RoutingError);
  assert.throws(() => router.addAgent(agent("a1", [key])), RoutingError); // duplicate id
  assert.throws(() => router.addAgent(agent("empty", [])), RoutingError); // no handles
});

test("assignAll drains open unassigned tickets and skips the rest", () => {
  const svc = new SupportService();
  const router = new RoutingService(svc);
  router.addAgent(agent("a1", [key]));
  router.addAgent(agent("a2", [key]));

  const ids = [0, 1, 2].map((i) => mkTicket(svc, { account_ref: `bin_${i}`, subject: `t${i}` }).id);
  const assigned = router.assignAll(ids, at(1));
  assert.deepEqual(assigned.map((t) => t.assigned_agent), ["a1", "a2", "a1"]);

  // second pass: nothing left to assign
  assert.equal(router.assignAll(ids, at(2)).length, 0);
});
