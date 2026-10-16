import type { QueueId } from "./types";
import type { CoreConfig } from "./config";
import type { SupportService } from "./support";
import type { CaseEvent, TicketEvent } from "./events";
import { burstActive } from "./burst";
import { deepFreeze } from "./events";

// phase 5: the measurement job. aggregates from events only: every
// number in the report is derived from the append-only logs, never
// from mutable state, so the report is auditable against the same
// events (spec: measurement).

export interface FirstResponseStat {
  responses: number;
  within_target: number;
  median_minutes: number | null;
}

export interface QueueReport {
  tickets_created: number;
  first_response: FirstResponseStat;
  // burst-window latency vs normal: first responses bucketed by
  // whether the response landed inside a live spike window
  burst: { in_window: FirstResponseStat; out_window: FirstResponseStat };
  resolved: number;
  reopened: number;
  merged_contacts: number;
  misroutes: number;
  misroute_rate: number | null; // corrections / tickets created
  kind_share: { question: number; issue: number };
  subjects: Record<string, number>; // issue tickets by subject (frozen on return)
}

export interface TagIntake {
  lookups: number;
  offered: number;
  deflected: number;
}

export interface IntakeReport {
  contacts: number;
  lookups: number;
  offered: number;
  deflected: number;
  deflection_rate: number | null; // accepted / offered
  human_requested: number;
  merged: number;
  rate_limit_trips: number;
  // abuse signal to moderation if patterned (spec: measurement)
  rate_limit_by_account: Record<string, number>;
  by_intent_tag: Readonly<Record<string, TagIntake>>;
  by_market: Readonly<Record<string, TagIntake>>;
}

export interface MeasurementReport {
  from: string;
  to: string;
  queues: Readonly<Record<QueueId, QueueReport>>;
  intake: IntakeReport;
  // the kind fork's legibility: corrections per window
  kind_corrections: number;
  retags: number;
  // payout-subject tickets re-tagged to idv and back
  payout_idv_confound: number;
}

const QUEUES: readonly QueueId[] = ["buyer", "buyer_to_be", "creator_support", "creator_question"];

const PAYOUT_TAGS = new Set(["payout_issue"]);
const IDV_TAGS = new Set(["idv_pending", "idv_rejected"]);

interface Payload {
  [k: string]: unknown;
}
const asPayload = (p: unknown): Payload => (p ?? {}) as Payload;

function medianMinutes(minutes: readonly number[]): number | null {
  if (minutes.length === 0) return null;
  const sorted = [...minutes].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

function bumpRecord(
  into: Record<string, TagIntake>,
  key: string,
  what: "lookups" | "offered" | "deflected",
): void {
  const row = into[key] ?? { lookups: 0, offered: 0, deflected: 0 };
  row[what] += 1;
  into[key] = row;
}

export function measure(
  support: SupportService,
  config: CoreConfig,
  from: string,
  to: string,
): MeasurementReport {
  if (Date.parse(from) >= Date.parse(to)) {
    throw new Error("measurement window is empty: from must precede to");
  }
  const inWindow = (ts: string) => ts >= from && ts < to;

  const emptyStat = (): FirstResponseStat => ({ responses: 0, within_target: 0, median_minutes: null });
  const queues = {} as Record<QueueId, QueueReport>;
  for (const q of QUEUES) {
    queues[q] = {
      tickets_created: 0,
      first_response: emptyStat(),
      burst: { in_window: emptyStat(), out_window: emptyStat() },
      resolved: 0,
      reopened: 0,
      merged_contacts: 0,
      misroutes: 0,
      misroute_rate: null,
      kind_share: { question: 0, issue: 0 },
      subjects: {},
    };
  }

  // ---- tickets: queue-level aggregates from ticket events ----
  let kindCorrections = 0;
  for (const id of support.ticketIds()) {
    const events = support.ticketEvents(id);
    const created = events.find((e) => e.type === "ticket_created");
    if (!created) continue;
    const createdPayload = asPayload(created.payload);
    const queue = createdPayload.queue as QueueId;
    const report = queues[queue] ?? queues.buyer;

    if (inWindow(created.created_at)) {
      report.tickets_created += 1;
      const kind = createdPayload.kind === "question" ? "question" : "issue";
      report.kind_share[kind] += 1;
      if (kind === "issue") {
        const subject = typeof createdPayload.subject === "string" ? createdPayload.subject : "other";
        report.subjects[subject] = (report.subjects[subject] ?? 0) + 1;
      }
    }

    // first human response: the first response_sent on this ticket
    const firstResponse = events.find((e) => e.type === "response_sent");
    if (firstResponse) {
      const minutes = (Date.parse(firstResponse.created_at) - Date.parse(created.created_at)) / 60_000;
      const target = config.first_response_minutes[queue];
      const within = minutes <= target;
      const stat = report.first_response;
      stat.responses += 1;
      if (within) stat.within_target += 1;
      const bucket = burstActive(config, queue, firstResponse.created_at)
        ? report.burst.in_window
        : report.burst.out_window;
      bucket.responses += 1;
      if (within) bucket.within_target += 1;
    }

    for (const e of events) {
      if (!inWindow(e.created_at)) continue;
      const p = asPayload(e.payload);
      if (e.type === "state_changed" && p.to === "resolved") report.resolved += 1;
      if (e.type === "reopened") report.reopened += 1;
      if (e.type === "merged_contact") report.merged_contacts += 1;
      // a correction event is attributed to the queue the ticket was
      // created in: the misroute rate then reads as "how often this
      // queue's assignment was wrong" (spec: queue re-assignment
      // events / total tickets)
      if (e.type === "queue_assigned" && p.correction === true) report.misroutes += 1;
      if (e.type === "kind_corrected") kindCorrections += 1;
    }
  }
  for (const q of QUEUES) {
    const r = queues[q];
    if (r.tickets_created > 0) r.misroute_rate = r.misroutes / r.tickets_created;
    r.first_response.median_minutes = medianMinutes(firstResponseMinutesOf(support, q, from, to));
    r.burst.in_window.median_minutes = medianMinutes(burstMinutes(support, config, q, from, to, true));
    r.burst.out_window.median_minutes = medianMinutes(burstMinutes(support, config, q, from, to, false));
  }

  // ---- intake: case-level aggregates from case events ----
  const intake: IntakeReport = {
    contacts: 0,
    lookups: 0,
    offered: 0,
    deflected: 0,
    deflection_rate: null,
    human_requested: 0,
    merged: 0,
    rate_limit_trips: 0,
    rate_limit_by_account: {},
    by_intent_tag: {},
    by_market: {},
  };
  let retags = 0;
  let confound = 0;

  for (const id of support.caseIds()) {
    const c = support.getCase(id);
    if (!c) continue;
    const events = support.caseEvents(id);
    for (const e of events) {
      if (!inWindow(e.created_at)) continue;
      const p = asPayload(e.payload);
      switch (e.type) {
        case "case_created":
          intake.contacts += 1;
          break;
        case "lookup_result":
          intake.lookups += 1;
          bumpRecord(intake.by_intent_tag, c.intent_tag, "lookups");
          bumpRecord(intake.by_market, c.market, "lookups");
          break;
        case "deflection_offered":
          intake.offered += 1;
          bumpRecord(intake.by_intent_tag, c.intent_tag, "offered");
          bumpRecord(intake.by_market, c.market, "offered");
          break;
        case "deflection_accepted":
          intake.deflected += 1;
          bumpRecord(intake.by_intent_tag, c.intent_tag, "deflected");
          bumpRecord(intake.by_market, c.market, "deflected");
          break;
        case "human_requested":
          intake.human_requested += 1;
          break;
        case "merged":
          intake.merged += 1;
          break;
        case "rate_limited":
          intake.rate_limit_trips += 1;
          if (typeof p.account_ref === "string") {
            const acc = intake.rate_limit_by_account as Record<string, number>;
            acc[p.account_ref] = (acc[p.account_ref] ?? 0) + 1;
          }
          break;
        case "intent_retagged": {
          retags += 1;
          const fromTag = typeof p.from === "string" ? p.from : "";
          const toTag = typeof p.to === "string" ? p.to : "";
          const crosses =
            (PAYOUT_TAGS.has(fromTag) && IDV_TAGS.has(toTag)) ||
            (IDV_TAGS.has(fromTag) && PAYOUT_TAGS.has(toTag));
          if (crosses) confound += 1;
          break;
        }
        default:
          break;
      }
    }
  }
  if (intake.offered > 0) {
    intake.deflection_rate = intake.deflected / intake.offered;
  }

  return deepFreeze(structuredClone({
    from,
    to,
    queues,
    intake,
    kind_corrections: kindCorrections,
    retags,
    payout_idv_confound: confound,
  }));
}

// first-response latencies per queue, events only
function firstResponseMinutesOf(
  support: SupportService,
  queue: QueueId,
  from: string,
  to: string,
): number[] {
  const out: number[] = [];
  for (const id of support.ticketIds()) {
    const pair = responsePair(support, id);
    if (!pair || pair.queue !== queue) continue;
    if (!(pair.created >= from && pair.created < to)) continue;
    out.push(pair.minutes);
  }
  return out;
}

function burstMinutes(
  support: SupportService,
  config: CoreConfig,
  queue: QueueId,
  from: string,
  to: string,
  inWindowBucket: boolean,
): number[] {
  const out: number[] = [];
  for (const id of support.ticketIds()) {
    const pair = responsePair(support, id);
    if (!pair || pair.queue !== queue) continue;
    if (!(pair.created >= from && pair.created < to)) continue;
    if (burstActive(config, queue, pair.respondedAt) === inWindowBucket) {
      out.push(pair.minutes);
    }
  }
  return out;
}

function responsePair(
  support: SupportService,
  ticketId: string,
): { queue: QueueId; created: string; respondedAt: string; minutes: number } | null {
  const events: readonly TicketEvent[] = support.ticketEvents(ticketId);
  const created = events.find((e) => e.type === "ticket_created");
  const response = events.find((e) => e.type === "response_sent");
  if (!created || !response) return null;
  const queue = asPayload(created.payload).queue as QueueId;
  return {
    queue,
    created: created.created_at,
    respondedAt: response.created_at,
    minutes: (Date.parse(response.created_at) - Date.parse(created.created_at)) / 60_000,
  };
}
