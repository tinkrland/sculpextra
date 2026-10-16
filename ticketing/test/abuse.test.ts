import { test } from "node:test";
import assert from "node:assert/strict";
import { AbuseReporter, AbuseReportError } from "../src/signals";
import { buildTicketView } from "../src/workspace";
import { SupportService, ContactInput } from "../src/support";
import type { AbuseSignal, ModerationPort } from "../src/types";

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
    body: "suspicious chargeback pattern",
    intent_tag: "where_is_it",
    order_attached: true,
    ...over,
  };
}

class FakeModeration implements ModerationPort {
  public readonly signals: AbuseSignal[] = [];
  public fileSignal(signal: AbuseSignal): string {
    this.signals.push(signal);
    return `mod_${this.signals.length}`;
  }
}

test("an abuse report files a signal, links the moderation ref, and enforces nothing", () => {
  const svc = new SupportService();
  const moderation = new FakeModeration();
  const reporter = new AbuseReporter(svc, moderation);
  const out = svc.receiveContact(mkContact(), T0);
  if (out.kind !== "ticketed") throw new Error("expected ticketed");
  const t = out.ticket;
  svc.triage(t.id, "agent_1", at(1));

  const filed = reporter.file(t.id, "agent_1", {
    category: "chargeback_abuse",
    evidence_refs: [`${t.id}:1`, `${t.id}:3`],
  }, at(2));

  // the signal reached moderation, never a verdict
  assert.equal(moderation.signals.length, 1);
  assert.equal(moderation.signals[0].category, "chargeback_abuse");
  assert.equal(moderation.signals[0].account_ref, "bin_1");
  assert.equal(filed.moderation_ref, "mod_1");

  // the event links the moderation ref for later joining
  const event = svc.ticketEvents(t.id).find((e) => e.type === "abuse_report_filed");
  const payload = event?.payload as { moderation_ref: string; signal_only: boolean };
  assert.equal(payload.moderation_ref, "mod_1");
  assert.equal(payload.signal_only, true);

  // support never enforces: state, queue, priority are untouched
  const after = svc.getTicket(t.id);
  assert.equal(after?.state, "triaged");
  assert.equal(after?.queue, "buyer");
  assert.equal(svc.priorityOf(t.id, at(2)), svc.priorityOf(t.id, at(2)));
});

test("the workspace shows filed reports read-only", () => {
  const svc = new SupportService();
  const reporter = new AbuseReporter(svc, new FakeModeration());
  const out = svc.receiveContact(mkContact(), T0);
  if (out.kind !== "ticketed") throw new Error("expected ticketed");
  reporter.file(out.ticket.id, "agent_1", { category: "fraud_signal", evidence_refs: ["e1"] }, at(1));

  const view = buildTicketView(svc, out.ticket.id, at(2));
  assert.equal(view.abuse_reports.length, 1);
  assert.equal(view.abuse_reports[0].moderation_ref, "mod_1");
});

test("reports without evidence or category are refused", () => {
  const svc = new SupportService();
  const reporter = new AbuseReporter(svc, new FakeModeration());
  const out = svc.receiveContact(mkContact(), T0);
  if (out.kind !== "ticketed") throw new Error("expected ticketed");

  assert.throws(() =>
    reporter.file(out.ticket.id, "agent_1", { category: "", evidence_refs: ["e1"] }, at(1)),
    AbuseReportError,
  );
  assert.throws(() =>
    reporter.file(out.ticket.id, "agent_1", { category: "fraud", evidence_refs: [] }, at(1)),
    AbuseReportError,
  );
  assert.throws(() =>
    reporter.file("ticket_nope", "agent_1", { category: "fraud", evidence_refs: ["e1"] }, at(1)),
    AbuseReportError,
  );
  assert.ok(!svc.ticketEvents(out.ticket.id).some((e) => e.type === "abuse_report_filed"));
});
