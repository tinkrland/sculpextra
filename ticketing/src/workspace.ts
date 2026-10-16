import type {
  ContextChip,
  DeflectionHistoryItem,
  IdentityPanel,
  SuggestedAnswer,
  Ticket,
  TicketView,
} from "./types";
import type { PriorityCurveSegment } from "./priority";
import { priorityScore } from "./priority";
import { DEFAULT_CONFIG } from "./config";
import type { CoreConfig } from "./config";
import type { SupportService } from "./support";
import { deepFreeze } from "./events";

// the agent workspace ticket view: read-and-propose panels, zero
// money-moving controls (spec: workspace). every panel derives
// from the ticket, its case, and their events - nothing is stored
// here, so the view can never drift from the record. retelldb
// suggestions render as drafts only: the agent owns what gets sent.

export class WorkspaceError extends Error {}

export function buildTicketView(
  support: SupportService,
  ticketId: string,
  now: string,
  config: CoreConfig = DEFAULT_CONFIG,
): TicketView {
  const t = mustTicket(support, ticketId);
  const c = support.getCase(t.case_ref);
  if (!c) throw new WorkspaceError(`case ${t.case_ref} missing for ticket ${t.id}`);

  const caseEvents = support.caseEvents(c.id);
  const identity: IdentityPanel = {
    account_family: c.account_family,
    account_ref: c.account_ref,
    market: c.market,
    language: c.language,
    source_channel: c.source_channel,
    intent_tag: c.intent_tag,
    chips: identityChips(t, caseEvents),
  };

  const history: DeflectionHistoryItem[] = [];
  for (const e of caseEvents) {
    if (e.type === "lookup_result") {
      const p = e.payload as { answers?: readonly SuggestedAnswer[]; error?: string };
      history.push({
        what: "lookup",
        at: e.created_at,
        detail: p.error
          ? `lookup failed (${p.error})`
          : `${(p.answers ?? []).length} suggested answers`,
      });
    } else if (e.type === "deflection_offered") {
      const p = e.payload as { offered?: readonly string[] };
      history.push({
        what: "offered",
        at: e.created_at,
        detail: `offered ${(p.offered ?? []).join(", ")}`,
      });
    } else if (e.type === "deflection_accepted") {
      history.push({ what: "accepted", at: e.created_at, detail: "user marked it resolved" });
    } else if (e.type === "human_requested") {
      history.push({
        what: "human_requested",
        at: e.created_at,
        detail: "user clicked still need a human",
      });
    }
  }

  // drafts: the last lookup's answers, in offer order. drafts only.
  const drafts = lastDrafts(caseEvents);

  return deepFreeze(
    structuredClone({
      ticket: t,
      identity,
      order_refs: t.order_refs,
      order_segments: t.order_segments,
      payout: t.payout_snapshot,
      deflection_history: history,
      drafts,
      priority: {
        score: priorityScore(t.created_at, now, config.priority_curve as readonly PriorityCurveSegment[]),
        age_minutes: Math.max(0, (Date.parse(now) - Date.parse(t.created_at)) / 60_000),
      },
      chain: support.chainOf(t.id),
    }),
  );
}

function identityChips(t: Ticket, caseEvents: readonly { type: string; payload: unknown }[]): ContextChip[] {
  const chips: ContextChip[] = [];
  if (t.rate_limited_chip) {
    chips.push({ label: "rate_limited", detail: "account hit the per-day ticket limit" });
  }
  // gate verdicts (thephonetell line-type, thelocaletell address
  // shape) render as context chips, never ranking inputs
  for (const e of caseEvents) {
    if (e.type !== "gate_verdict") continue;
    const p = e.payload as { gate?: string; verdict?: string; detail?: string };
    if (p.verdict === "fail") continue; // fails never reach an open case
    chips.push({ label: p.gate ?? "gate", detail: p.detail ?? p.verdict });
  }
  // deflection context for triage, only when deflection actually
  // ran (a straight-to-ticket intake shows nothing misleading)
  const deflected = caseEvents.some(
    (e) => e.type === "lookup_result" || e.type === "deflection_offered",
  );
  if (deflected && t.deflection_summary) {
    chips.push({ label: "deflected_once", detail: t.deflection_summary });
  }
  return chips;
}

function lastDrafts(caseEvents: readonly { type: string; payload: unknown }[]): SuggestedAnswer[] {
  for (let i = caseEvents.length - 1; i >= 0; i--) {
    const e = caseEvents[i];
    if (e.type !== "lookup_result") continue;
    const p = e.payload as { answers?: readonly SuggestedAnswer[] };
    return [...(p.answers ?? [])];
  }
  return [];
}

function mustTicket(support: SupportService, ticketId: string): Ticket {
  const t = support.getTicket(ticketId);
  if (!t) throw new WorkspaceError(`unknown ticket: ${ticketId}`);
  return t;
}
