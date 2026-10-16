import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assertTransition,
  canReopen,
  canTransition,
  daysBetween,
  IllegalTransitionError,
  REOPEN_WINDOW_DAYS,
} from "../src/state";

const T0 = "2026-10-16T00:00:00.000Z";

test("the full legal path walks the spec diagram", () => {
  assertTransition("new", "triaged");
  assertTransition("triaged", "in_progress");
  assertTransition("in_progress", "waiting_on_user");
  assertTransition("waiting_on_user", "in_progress"); // user replied
  assertTransition("in_progress", "waiting_on_user");
  assertTransition("waiting_on_user", "resolved");
  assertTransition("resolved", "closed");
});

test("resolved is only reachable from waiting_on_user", () => {
  assert.equal(canTransition("in_progress", "resolved"), false);
  assert.equal(canTransition("triaged", "resolved"), false);
  assert.equal(canTransition("new", "resolved"), false);
});

test("illegal transitions throw", () => {
  for (const [from, to] of [
    ["new", "in_progress"],
    ["new", "closed"],
    ["triaged", "resolved"],
    ["closed", "new"],
    ["closed", "in_progress"],
    ["resolved", "in_progress"],
  ] as const) {
    assert.throws(() => assertTransition(from, to), IllegalTransitionError, `${from} -> ${to}`);
  }
});

test("closed is a terminal state", () => {
  assert.equal(canTransition("closed", "closed"), false);
});

test("reopen window is 14 days, inclusive", () => {
  assert.equal(REOPEN_WINDOW_DAYS, 14);
  assert.equal(canReopen(T0, "2026-10-29T23:59:59.000Z"), true); // day 13
  assert.equal(canReopen(T0, "2026-10-30T00:00:00.000Z"), true); // exactly 14
  assert.equal(canReopen(T0, "2026-10-30T00:00:01.000Z"), false); // past 14
  assert.equal(canReopen(T0, T0), true);
});

test("daysBetween measures in days, utc", () => {
  assert.equal(daysBetween(T0, "2026-10-17T00:00:00.000Z"), 1);
  assert.equal(daysBetween(T0, "2026-10-16T12:00:00.000Z"), 0.5);
  assert.equal(daysBetween("2026-10-17T00:00:00.000Z", T0), -1);
  assert.throws(() => daysBetween("not a date", T0));
});
