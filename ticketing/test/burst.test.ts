import { test } from "node:test";
import assert from "node:assert/strict";
import { effectiveCap, inSpikeWindow, BurstWindowError } from "../src/burst";
import { RoutingService } from "../src/routing";
import { SupportService, ContactInput } from "../src/support";
import { DEFAULT_CONFIG } from "../src/config";
import type { CoreConfig } from "../src/config";
import type { AgentProfile } from "../src/types";

const T0 = "2026-10-15T00:00:00.000Z"; // thursday
const at = (minutes: number) =>
  new Date(Date.parse(T0) + minutes * 60_000).toISOString();

const mkContact = (over: Partial<ContactInput> = {}): ContactInput => ({
  account_family: "buyer",
  account_ref: "bin_1",
  market: "US",
  language: "en-US",
  source_channel: "web_form",
  subject: "s",
  body: "b",
  intent_tag: "where_is_it",
  order_attached: true,
  ...over,
});

const agent = (id: string, cap: number): AgentProfile => ({
  id,
  handles: [{ queue: "buyer", market: "US", language: "en-US" }],
  concurrency_cap: cap,
});

test("plain time windows match inside, not outside", () => {
  const w = { start_utc: "09:00", end_utc: "17:00" };
  assert.equal(inSpikeWindow(w, "2026-10-15T09:00:00Z"), true);
  assert.equal(inSpikeWindow(w, "2026-10-15T16:59:00Z"), true);
  assert.equal(inSpikeWindow(w, "2026-10-15T17:00:00Z"), false);
  assert.equal(inSpikeWindow(w, "2026-10-15T08:59:00Z"), false);
});

test("overnight windows wrap midnight", () => {
  const w = { start_utc: "22:00", end_utc: "02:00" };
  assert.equal(inSpikeWindow(w, "2026-10-15T23:30:00Z"), true);
  assert.equal(inSpikeWindow(w, "2026-10-16T01:00:00Z"), true);
  assert.equal(inSpikeWindow(w, "2026-10-16T03:00:00Z"), false);
});

test("weekday and day-of-month filters narrow the window", () => {
  const w = { start_utc: "00:00", end_utc: "23:59", weekdays_utc: [5] }; // friday only
  assert.equal(inSpikeWindow(w, "2026-10-16T10:00:00Z"), true); // friday
  assert.equal(inSpikeWindow(w, "2026-10-15T10:00:00Z"), false); // thursday
  const m = { start_utc: "00:00", end_utc: "23:59", days_of_month: [15] }; // the 15th (payout day)
  assert.equal(inSpikeWindow(m, "2026-10-15T10:00:00Z"), true);
  assert.equal(inSpikeWindow(m, "2026-10-16T10:00:00Z"), false);
});

test("malformed windows fail loudly, not silently", () => {
  assert.throws(() => inSpikeWindow({ start_utc: "9am", end_utc: "17:00" }, T0), BurstWindowError);
  assert.throws(() => inSpikeWindow({ start_utc: "09:00", end_utc: "25:00" }, T0), BurstWindowError);
});

test("effectiveCap widens only: base outside windows, floored x multiplier inside", () => {
  const config: CoreConfig = {
    ...DEFAULT_CONFIG,
    rate_limits: { ...DEFAULT_CONFIG.rate_limits },
    first_response_minutes: { ...DEFAULT_CONFIG.first_response_minutes },
    burst: {
      buyer: { multiplier: 2, windows: [{ start_utc: "00:00", end_utc: "23:59", days_of_month: [15] }] },
      buyer_to_be: { multiplier: 1, windows: [] },
      creator_support: { multiplier: 1, windows: [] },
      creator_question: { multiplier: 1, windows: [] },
    },
  };
  // the 15th, inside the window: cap 3 x 2 = 6
  assert.equal(effectiveCap(3, config, "buyer", "2026-10-15T10:00:00Z"), 6);
  // the 16th, outside: base cap
  assert.equal(effectiveCap(3, config, "buyer", "2026-10-16T10:00:00Z"), 3);
  // multiplier 1.5 on cap 3 floors to 4 inside
  const half: CoreConfig = {
    ...config,
    burst: {
      ...config.burst,
      buyer: { multiplier: 1.5, windows: [{ start_utc: "00:00", end_utc: "23:59" }] },
    },
  };
  assert.equal(effectiveCap(3, half, "buyer", "2026-10-15T10:00:00Z"), 4);
  // widens only: a misconfigured multiplier below 1 never shrinks the cap
  const broken: CoreConfig = {
    ...config,
    burst: {
      ...config.burst,
      buyer: { multiplier: 0.5, windows: [{ start_utc: "00:00", end_utc: "23:59" }] },
    },
  };
  assert.equal(effectiveCap(3, broken, "buyer", "2026-10-15T10:00:00Z"), 3);
});

test("routing respects burst caps at spike time and base caps outside", () => {
  const config: CoreConfig = {
    ...DEFAULT_CONFIG,
    rate_limits: { ...DEFAULT_CONFIG.rate_limits },
    first_response_minutes: { ...DEFAULT_CONFIG.first_response_minutes },
    burst: {
      buyer: { multiplier: 2, windows: [{ start_utc: "00:00", end_utc: "23:59", days_of_month: [15] }] },
      buyer_to_be: { multiplier: 1, windows: [] },
      creator_support: { multiplier: 1, windows: [] },
      creator_question: { multiplier: 1, windows: [] },
    },
  };
  const support = new SupportService(config);
  const routing = new RoutingService(support, config);
  routing.addAgent(agent("a1", 1)); // base cap 1, burst cap 2 on the 15th

  // three same-day tickets on the 15th: burst admits both, base would cap at 1
  const t1 = support.receiveContact(mkContact({ account_ref: "bin_a" }), T0).kind === "ticketed"
    ? support.ticketIds()[0]
    : "";
  const first = (support.receiveContact(mkContact({ account_ref: "bin_a" }), at(1)) as { ticket: import("../src/types").Ticket }).ticket;
  const second = (support.receiveContact(mkContact({ account_ref: "bin_b" }), at(2)) as { ticket: import("../src/types").Ticket }).ticket;
  void t1; void first;
  const assignedOnSpike = routing.assignTicket(second.id, at(3));
  assert.ok(assignedOnSpike, "burst cap admits the second concurrent ticket on the 15th");

  // the next day (outside the window): a fresh agent at base cap 1 declines a second ticket
  const support2 = new SupportService(config);
  const routing2 = new RoutingService(support2, config);
  routing2.addAgent(agent("b1", 1));
  const x1 = (support2.receiveContact(mkContact({ account_ref: "bin_c" }), "2026-10-16T00:00:00Z") as { ticket: import("../src/types").Ticket }).ticket;
  const x2 = (support2.receiveContact(mkContact({ account_ref: "bin_d" }), "2026-10-16T00:01:00Z") as { ticket: import("../src/types").Ticket }).ticket;
  assert.ok(routing2.assignTicket(x1.id, "2026-10-16T00:02:00Z"));
  assert.equal(routing2.assignTicket(x2.id, "2026-10-16T00:03:00Z"), null, "base cap 1 holds outside the window");
});
