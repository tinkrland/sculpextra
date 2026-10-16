import { test } from "node:test";
import assert from "node:assert/strict";
import { deepFreeze, EventLog, TicketEvent } from "../src/events";

const T0 = "2026-10-16T00:00:00.000Z";

const mk = (seq: number): TicketEvent => ({
  ticket_ref: "ticket_1",
  seq,
  type: "note_added",
  actor: { kind: "agent", id: "agent_1" },
  payload: { note: "n" },
  created_at: T0,
});

test("seq is assigned inside append, per ref, monotonic", () => {
  const log = new EventLog<TicketEvent>();
  assert.equal(log.append("a", mk).seq, 1);
  assert.equal(log.append("a", mk).seq, 2);
  assert.equal(log.append("a", mk).seq, 3);
  // independent per ref
  assert.equal(log.append("b", mk).seq, 1);
  assert.equal(log.list("a").map((e) => e.seq).join(","), "1,2,3");
});

test("events are deeply frozen; mutation attempts throw", () => {
  const log = new EventLog<TicketEvent>();
  const e = log.append("a", (seq) => ({
    ticket_ref: "a",
    seq,
    type: "note_added",
    actor: { kind: "agent", id: "agent_1" },
    payload: { note: "hello", nested: { deep: true } },
    created_at: T0,
  }));
  assert.throws(() => {
    (e as { type: string }).type = "closed";
  });
  assert.throws(() => {
    (e.payload as { nested: { deep: boolean } }).nested.deep = false;
  });
  const stored = log.list("a")[0];
  assert.equal((stored.payload as { nested: { deep: boolean } }).nested.deep, true);
});

test("list returns a frozen copy, not the internal array", () => {
  const log = new EventLog<TicketEvent>();
  log.append("a", mk);
  const first = log.list("a");
  assert.equal(first.length, 1);
  assert.throws(() => {
    (first as unknown as unknown[]).push(mk(99));
  });
  assert.equal(log.list("a").length, 1);
  assert.equal(log.count("a"), 1);
  assert.equal(log.count(), 1);
});

test("there is no update or delete path on the log", () => {
  const log = new EventLog<TicketEvent>();
  const anyLog = log as unknown as Record<string, unknown>;
  assert.equal(typeof anyLog.update, "undefined");
  assert.equal(typeof anyLog.delete, "undefined");
  assert.equal(typeof anyLog.remove, "undefined");
  assert.equal(typeof anyLog.edit, "undefined");
});

test("deepFreeze freezes nested payloads but passes primitives through", () => {
  const v = deepFreeze({ a: 1, b: { c: [1, 2] } });
  assert.throws(() => {
    (v.b as { c: number[] }).c.push(3);
  });
  assert.equal(deepFreeze(5), 5);
  assert.equal(deepFreeze(null), null);
});
