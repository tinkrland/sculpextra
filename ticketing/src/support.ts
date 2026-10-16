import type {
  AccountFamily,
  AssignmentDecision,
  AssignmentInputs,
  Case,
  GateVerdict,
  OrderSegmentSnapshot,
  PayoutSnapshot,
  QueueId,
  SourceChannel,
  Ticket,
  TicketState,
} from "./types";
import { assertLanguage, assertMarket } from "./iso3166";
import { isIntentTagForFamily } from "./taxonomy";
import {
  Actor,
  CaseEvent,
  EventLog,
  TicketEvent,
  deepFreeze,
} from "./events";
import { assertTransition, canReopen, daysBetween } from "./state";
import { assignQueue, AssignmentError } from "./assign";
import { priorityScore } from "./priority";
import { CoreConfig, DEFAULT_CONFIG } from "./config";

export { DEFAULT_CONFIG } from "./config";
export { AssignmentError } from "./assign";
export { MarketError, LanguageError } from "./iso3166";
export { IllegalTransitionError } from "./state";

const system = (): Actor => ({ kind: "system" });
const accountActor = (ref: string): Actor => ({ kind: "account", ref });
const agentActor = (id: string): Actor => ({ kind: "agent", id });

export interface ContactInput {
  account_family: AccountFamily;
  account_ref: string; // bin or cin
  market: string; // iso 3166-1 alpha-2
  language: string; // bcp-47
  source_channel: SourceChannel;
  subject: string;
  body: string;
  intent_tag: string; // fixed taxonomy; free text goes in intent_tag_raw
  intent_tag_raw?: string;
  order_attached: boolean; // property of the contact, not the account
  payout_context_present?: boolean; // captured at intake, an input to assign
  order_refs?: string[];
  order_segments?: OrderSegmentSnapshot[];
  payout_snapshot?: PayoutSnapshot | null; // creator_support only
  // themailtell eligibility verdict for email intake, set by the
  // email channel adapter. "fail" blocks intake before a case exists.
  email_gate?: "pass" | "fail" | null;
  // thephonetell / thelocaletell context, attached and logged, never
  // blocking here
  gate_verdicts?: GateVerdict[];
}

export type ContactOutcome =
  | { kind: "rejected"; reason: string }
  | { kind: "merged"; case: Case; ticket: Ticket }
  | { kind: "reopened"; case: Case; ticket: Ticket }
  | { kind: "ticketed"; case: Case; ticket: Ticket; rate_limited_chip: boolean };

const OPEN_STATES: ReadonlySet<TicketState> = new Set([
  "new",
  "triaged",
  "in_progress",
  "waiting_on_user",
]);

// phase 1 service: straight-to-ticket mode. the deflection pipeline
// (retelldb lookup, deflection screen, the one "still need a human"
// click) plugs in at createDeflectingService in phase 2; intake then
// only creates a ticket on human_requested instead of always.
export class SupportService {
  private readonly cases = new Map<string, Case>();
  private readonly tickets = new Map<string, Ticket>();
  private readonly caseLog = new EventLog<CaseEvent>();
  private readonly ticketLog = new EventLog<TicketEvent>();
  private readonly accountTickets = new Map<string, string[]>();
  private readonly rateCounts = new Map<string, number>();
  private caseSeq = 0;
  private ticketSeq = 0;

  constructor(private readonly config: CoreConfig = DEFAULT_CONFIG) {}

  // ---- intake ----

  public receiveContact(input: ContactInput, now: string): ContactOutcome {
    // email eligibility gate runs before a case exists: a failed gate
    // is an intake rejection, no case is created (spec: intake).
    if (input.source_channel === "email" && input.email_gate !== "pass") {
      return {
        kind: "rejected",
        reason:
          input.email_gate === "fail"
            ? "email eligibility gate failed (themailtell)"
            : "email eligibility gate not checked",
      };
    }
    assertMarket(input.market);
    assertLanguage(input.language);
    if (!input.account_ref) {
      throw new Error("account ref (bin or cin) required");
    }
    if (!input.subject && !input.body) {
      throw new Error("contact needs a subject or a body");
    }
    // fail before a case exists rather than creating an untaggable one
    if (!isIntentTagForFamily(input.account_family, input.intent_tag)) {
      throw new AssignmentError(
        `intent tag "${input.intent_tag}" is not valid for family "${input.account_family}"`,
      );
    }

    const c = this.createCase(input, now);

    const decision = assignQueue({
      account_family: input.account_family,
      order_attached: input.order_attached,
      payout_context_present: input.payout_context_present ?? false,
      intent_tag: input.intent_tag,
    });

    const tripped = this.rateTripped(input.account_ref, decision.queue, now);
    if (tripped) {
      this.caseLog.append(c.id, (seq) => ({
        case_ref: c.id,
        seq,
        type: "rate_limited",
        actor: system(),
        payload: {
          queue: decision.queue,
          limit: this.config.rate_limits[decision.queue],
        },
        created_at: now,
      }));
    }

    // duplicate merge: same account + same intent tag within the
    // window merges into the open ticket. nothing is deleted; the
    // case stays queryable and the contact appends to the ticket.
    const open = this.findMergeTarget(input.account_ref, input.intent_tag, now);
    if (open) {
      this.ticketLog.append(open.id, (seq) => ({
        ticket_ref: open.id,
        seq,
        type: "merged_contact",
        actor: accountActor(input.account_ref),
        payload: { case_ref: c.id, subject: input.subject },
        created_at: now,
      }));
      const merged = deepFreeze({ ...c, state: "merged" as const, merged_into_ticket: open.id });
      this.cases.set(merged.id, merged);
      this.caseLog.append(c.id, (seq) => ({
        case_ref: c.id,
        seq,
        type: "merged",
        actor: system(),
        payload: { ticket_ref: open.id },
        created_at: now,
      }));
      return { kind: "merged", case: merged, ticket: open };
    }

    // reopen: a matching ticket closed within the reopen window
    // produces a linked new ticket inheriting the event history by
    // reference (workspace renders the chain read-only).
    const closed = this.findReopenTarget(input.account_ref, input.intent_tag, now);
    const ticket = this.createTicket(
      c,
      decision,
      input,
      now,
      closed?.id ?? null,
      tripped,
    );
    const stored = this.cases.get(c.id)!;
    return closed
      ? { kind: "reopened", case: stored, ticket }
      : { kind: "ticketed", case: stored, ticket, rate_limited_chip: tripped };
  }

  // ---- ticket lifecycle ----

  public transition(ticketId: string, to: TicketState, actorId: string | null, now: string): Ticket {
    const t = this.mustTicket(ticketId);
    assertTransition(t.state, to);
    this.ticketLog.append(t.id, (seq) => ({
      ticket_ref: t.id,
      seq,
      type: "state_changed",
      actor: actorId ? agentActor(actorId) : system(),
      payload: { from: t.state, to },
      created_at: now,
    }));
    if (to === "closed") {
      this.ticketLog.append(t.id, (seq) => ({
        ticket_ref: t.id,
        seq,
        type: "closed",
        actor: agentActor(agentId(t, actorId)),
        payload: {},
        created_at: now,
      }));
    }
    const updated = deepFreeze({ ...t, state: to, closed_at: to === "closed" ? now : t.closed_at });
    this.tickets.set(t.id, updated);
    return updated;
  }

  // triage: new -> triaged. also the place a triage re-tag or re-queue
  // happens, each as its own event (see requeue).
  public triage(ticketId: string, actorId: string, now: string): Ticket {
    return this.transition(ticketId, "triaged", actorId, now);
  }

  public start(ticketId: string, actorId: string, now: string): Ticket {
    return this.transition(ticketId, "in_progress", actorId, now);
  }

  // response_sent always moves to waiting_on_user (spec flow: the
  // agent answers, then the ticket waits).
  public respond(ticketId: string, actorId: string, body: string, now: string): Ticket {
    const t = this.mustTicket(ticketId);
    if (!body.trim()) throw new Error("response body required");
    assertTransition(t.state, "waiting_on_user");
    this.ticketLog.append(t.id, (seq) => ({
      ticket_ref: t.id,
      seq,
      type: "response_sent",
      actor: agentActor(actorId),
      payload: { body },
      created_at: now,
    }));
    return this.transition(ticketId, "waiting_on_user", actorId, now);
  }

  public resolve(ticketId: string, actorId: string, now: string): Ticket {
    return this.transition(ticketId, "resolved", actorId, now);
  }

  public close(ticketId: string, actorId: string, now: string): Ticket {
    return this.transition(ticketId, "closed", actorId, now);
  }

  public addNote(ticketId: string, actorId: string, note: string, now: string): void {
    const t = this.mustTicket(ticketId);
    this.ticketLog.append(t.id, (seq) => ({
      ticket_ref: t.id,
      seq,
      type: "note_added",
      actor: agentActor(actorId),
      payload: { note },
      created_at: now,
    }));
  }

  // assignment primitive; round-robin routing over agent pools is
  // phase 3 and calls this.
  public assignAgent(ticketId: string, agentId: string, now: string): Ticket {
    const t = this.mustTicket(ticketId);
    this.ticketLog.append(t.id, (seq) => ({
      ticket_ref: t.id,
      seq,
      type: "agent_assigned",
      actor: system(),
      payload: { agent: agentId },
      created_at: now,
    }));
    const updated = deepFreeze({ ...t, assigned_agent: agentId });
    this.tickets.set(t.id, updated);
    return updated;
  }

  // escalate to a senior queue on the same event chain: one event,
  // queue changes, state unchanged.
  public escalate(ticketId: string, actorId: string, targetQueue: QueueId, now: string): Ticket {
    const t = this.mustTicket(ticketId);
    if (t.queue === targetQueue) {
      throw new Error("escalation target equals current queue");
    }
    this.ticketLog.append(t.id, (seq) => ({
      ticket_ref: t.id,
      seq,
      type: "escalated",
      actor: agentActor(actorId),
      payload: { from: t.queue, to: targetQueue },
      created_at: now,
    }));
    const updated = deepFreeze({ ...t, queue: targetQueue });
    this.tickets.set(t.id, updated);
    return updated;
  }

  // triage correction: the queue change that makes misroute rate
  // measurable per intent tag. reason is mandatory.
  public requeue(ticketId: string, actorId: string, queue: QueueId, reason: string, now: string): Ticket {
    const t = this.mustTicket(ticketId);
    if (!reason.trim()) throw new Error("requeue needs a reason");
    this.ticketLog.append(t.id, (seq) => ({
      ticket_ref: t.id,
      seq,
      type: "queue_assigned",
      actor: agentActor(actorId),
      payload: { queue, reason, correction: true },
      created_at: now,
    }));
    const updated = deepFreeze({ ...t, queue });
    this.tickets.set(t.id, updated);
    return updated;
  }

  // ---- reads ----

  public getCase(id: string): Case | undefined {
    return this.cases.get(id);
  }

  public getTicket(id: string): Ticket | undefined {
    return this.tickets.get(id);
  }

  public caseEvents(caseRef: string): readonly CaseEvent[] {
    return this.caseLog.list(caseRef);
  }

  public ticketEvents(ticketRef: string): readonly TicketEvent[] {
    return this.ticketLog.list(ticketRef);
  }

  // ancestor chain, oldest first, ending at this ticket. events are
  // inherited by reference: the chain is walked, never copied.
  public chainOf(ticketId: string): readonly string[] {
    const chain: string[] = [];
    const seen = new Set<string>();
    let cursor: string | null = ticketId;
    while (cursor !== null) {
      if (seen.has(cursor)) throw new Error("reopen chain cycle detected");
      seen.add(cursor);
      chain.unshift(cursor);
      const t = this.tickets.get(cursor);
      if (!t) throw new Error(`unknown ticket in chain: ${cursor}`);
      cursor = t.reopened_from;
    }
    return Object.freeze(chain);
  }

  public eventsOfChain(ticketId: string): readonly TicketEvent[] {
    const out: TicketEvent[] = [];
    for (const id of this.chainOf(ticketId)) {
      out.push(...this.ticketLog.list(id));
    }
    return Object.freeze(out);
  }

  public ticketsForAccount(accountRef: string): readonly Ticket[] {
    const ids = this.accountTickets.get(accountRef) ?? [];
    return Object.freeze(ids.map((id) => this.tickets.get(id)!).filter(Boolean));
  }

  // age-based only; order value and flags are context, never inputs
  public priorityOf(ticketId: string, now: string): number {
    const t = this.mustTicket(ticketId);
    return priorityScore(t.created_at, now);
  }

  public caseCount(): number {
    return this.cases.size;
  }

  public ticketCount(): number {
    return this.tickets.size;
  }

  // ---- internals ----

  private createCase(input: ContactInput, now: string): Case {
    const id = `case_${++this.caseSeq}`;
    const c: Case = deepFreeze({
      id,
      account_family: input.account_family,
      account_ref: input.account_ref,
      market: input.market,
      language: input.language,
      source_channel: input.source_channel,
      subject: input.subject,
      body: input.body,
      intent_tag_raw: input.intent_tag_raw ?? input.intent_tag,
      intent_tag: input.intent_tag,
      state: "open",
      merged_into_ticket: null,
      created_at: now,
    });
    this.cases.set(id, c);
    this.caseLog.append(id, (seq) => ({
      case_ref: id,
      seq,
      type: "case_created",
      actor: system(),
      payload: { source_channel: c.source_channel, market: c.market, language: c.language },
      created_at: now,
    }));
    for (const verdict of input.gate_verdicts ?? []) {
      this.caseLog.append(id, (seq) => ({
        case_ref: id,
        seq,
        type: "gate_verdict",
        actor: system(),
        payload: { ...verdict },
        created_at: now,
      }));
    }
    this.caseLog.append(id, (seq) => ({
      case_ref: id,
      seq,
      type: "intent_tagged",
      actor: system(),
      payload: { raw: c.intent_tag_raw, tag: c.intent_tag },
      created_at: now,
    }));
    return c;
  }

  private createTicket(
    c: Case,
    decision: AssignmentDecision,
    input: ContactInput,
    now: string,
    reopenedFrom: string | null,
    tripped: boolean,
  ): Ticket {
    if (input.payout_snapshot && decision.queue !== "creator_support") {
      throw new Error("payout snapshot is creator_support only");
    }
    const id = `ticket_${++this.ticketSeq}`;
    const t: Ticket = deepFreeze({
      id,
      case_ref: c.id,
      queue: decision.queue,
      state: "new",
      order_refs: Object.freeze([...(input.order_refs ?? [])]),
      order_segments: Object.freeze(
        (input.order_segments ?? []).map((s) => deepFreeze({ ...s })),
      ),
      payout_snapshot: input.payout_snapshot
        ? deepFreeze({ ...input.payout_snapshot })
        : null,
      deflection_summary: null, // phase 2
      assigned_agent: null,
      rate_limited_chip: tripped,
      reopened_from: reopenedFrom,
      created_at: now,
      closed_at: null,
    });
    this.tickets.set(id, t);
    const index = this.accountTickets.get(c.account_ref) ?? [];
    index.unshift(id); // newest first
    this.accountTickets.set(c.account_ref, index);
    this.bumpRate(c.account_ref, decision.queue, now);

    // the assignment is logged with its inputs as the ticket's first
    // event, so misroutes are auditable.
    this.ticketLog.append(id, (seq) => ({
      ticket_ref: id,
      seq,
      type: "ticket_created",
      actor: system(),
      payload: {
        case_ref: c.id,
        queue: decision.queue,
        rule: decision.rule,
        assignment_inputs: decision.inputs,
        reopened_from: reopenedFrom,
      },
      created_at: now,
    }));
    this.ticketLog.append(id, (seq) => ({
      ticket_ref: id,
      seq,
      type: "queue_assigned",
      actor: system(),
      payload: { queue: decision.queue },
      created_at: now,
    }));
    if (reopenedFrom) {
      this.ticketLog.append(id, (seq) => ({
        ticket_ref: id,
        seq,
        type: "reopened",
        actor: system(),
        payload: { ancestor: reopenedFrom },
        created_at: now,
      }));
    }

    const ticketedCase = deepFreeze({ ...c, state: "ticketed" as const });
    this.cases.set(c.id, ticketedCase);
    this.caseLog.append(c.id, (seq) => ({
      case_ref: c.id,
      seq,
      type: "ticketed",
      actor: system(),
      payload: { ticket_ref: id },
      created_at: now,
    }));
    return t;
  }

  // per-account per-queue per-utc-day counts of tickets created
  private rateKey(accountRef: string, queue: QueueId, now: string): string {
    return `${accountRef}|${queue}|${now.slice(0, 10)}`;
  }

  private rateTripped(accountRef: string, queue: QueueId, now: string): boolean {
    const count = this.rateCounts.get(this.rateKey(accountRef, queue, now)) ?? 0;
    return count >= this.config.rate_limits[queue];
  }

  private bumpRate(accountRef: string, queue: QueueId, now: string): void {
    const key = this.rateKey(accountRef, queue, now);
    this.rateCounts.set(key, (this.rateCounts.get(key) ?? 0) + 1);
  }

  private ticketCase(ticketId: string): Case {
    const t = this.mustTicket(ticketId);
    const c = this.cases.get(t.case_ref);
    if (!c) throw new Error(`case ${t.case_ref} missing for ticket ${t.id}`);
    return c;
  }

  private findMergeTarget(accountRef: string, intentTag: string, now: string): Ticket | undefined {
    for (const id of this.accountTickets.get(accountRef) ?? []) {
      const t = this.tickets.get(id)!;
      if (!OPEN_STATES.has(t.state)) continue;
      const age = daysBetween(t.created_at, now);
      if (age > this.config.merge_window_hours / 24) continue;
      if (this.ticketCase(t.id).intent_tag === intentTag) return t;
    }
    return undefined;
  }

  private findReopenTarget(accountRef: string, intentTag: string, now: string): Ticket | undefined {
    for (const id of this.accountTickets.get(accountRef) ?? []) {
      const t = this.tickets.get(id)!;
      if (t.state !== "closed" || t.closed_at === null) continue;
      if (!canReopen(t.closed_at, now)) continue;
      if (this.ticketCase(t.id).intent_tag === intentTag) return t;
    }
    return undefined;
  }

  private mustTicket(id: string): Ticket {
    const t = this.tickets.get(id);
    if (!t) throw new Error(`unknown ticket: ${id}`);
    return t;
  }
}

function agentId(t: Ticket, actorId: string | null): string {
  return actorId ?? t.assigned_agent ?? "system";
}
