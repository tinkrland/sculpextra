import type { AgentProfile, QueueId, RoutingKey, Ticket } from "./types";
import type { CoreConfig } from "./config";
import { DEFAULT_CONFIG } from "./config";
import type { SupportService } from "./support";
import { deepFreeze } from "./events";

// the phase 3 routing service. routing keys are (queue, market,
// language); tickets route to agents assigned to that exact set,
// round-robin within the eligible set under per-agent concurrency
// caps (spec: routing). priority never influences assignment: an
// older ticket simply reaches the router first. caps count every
// open ticket the agent owns (new..waiting_on_user) - resolved and
// closed free the slot, since the agent is done with them.
// timers are caller-owned: the caller invokes assignTicket when a
// ticket appears or an agent frees capacity.

export class RoutingError extends Error {}

const OPEN_TICKET_STATES: ReadonlySet<Ticket["state"]> = new Set([
  "new",
  "triaged",
  "in_progress",
  "waiting_on_user",
]);

export class RoutingService {
  private readonly agents = new Map<string, AgentProfile>();
  // per-routing-key round-robin cursor, so rotation is fair and
  // deterministic across calls
  private readonly cursors = new Map<string, number>();

  constructor(
    private readonly support: SupportService,
    private readonly config: CoreConfig = DEFAULT_CONFIG,
  ) {}

  // register an agent profile. handles are frozen at registration.
  public addAgent(profile: AgentProfile): void {
    if (!profile.id) throw new RoutingError("agent id required");
    if (profile.handles.length === 0) {
      throw new RoutingError(`agent ${profile.id} needs at least one routing set`);
    }
    if (this.agents.has(profile.id)) {
      throw new RoutingError(`agent ${profile.id} already registered`);
    }
    this.agents.set(profile.id, deepFreeze(structuredClone(profile)));
  }

  public agent(id: string): AgentProfile | undefined {
    return this.agents.get(id);
  }

  // try to assign a ticket to an eligible agent. returns the
  // updated ticket, or null when nobody matches the routing key or
  // every matching agent is at their cap (the ticket stays queued).
  public assignTicket(ticketId: string, now: string): Ticket | null {
    const t = this.support.getTicket(ticketId);
    if (!t) throw new RoutingError(`unknown ticket: ${ticketId}`);
    if (t.assigned_agent) throw new RoutingError(`ticket ${ticketId} is already assigned to ${t.assigned_agent}`);
    if (!OPEN_TICKET_STATES.has(t.state)) {
      throw new RoutingError(`ticket ${ticketId} is ${t.state}, not open for routing`);
    }
    const key: RoutingKey = {
      queue: t.queue,
      market: this.caseOf(t).market,
      language: this.caseOf(t).language,
    };
    const eligible = this.eligibleAgents(key);
    if (eligible.length === 0) return null;

    const cursorKey = `${key.queue}|${key.market}|${key.language}`;
    const cursor = this.cursors.get(cursorKey) ?? 0;
    const chosen = eligible[cursor % eligible.length];
    this.cursors.set(cursorKey, cursor + 1);
    return this.support.assignAgent(ticketId, chosen.id, now);
  }

  // routing a burst: drain the given queue key until caps stop it.
  // returns every ticket assigned this call, in priority-then-age
  // order (the router is fed by the caller's ordering; it assigns
  // what it is given).
  public assignAll(
    ticketIds: readonly string[],
    now: string,
  ): readonly Ticket[] {
    const assigned: Ticket[] = [];
    for (const id of ticketIds) {
      const t = this.support.getTicket(id);
      if (!t || t.assigned_agent || !OPEN_TICKET_STATES.has(t.state)) continue;
      const out = this.assignTicket(id, now);
      if (out) assigned.push(out);
    }
    return Object.freeze(assigned);
  }

  private eligibleAgents(key: RoutingKey): readonly AgentProfile[] {
    const out: AgentProfile[] = [];
    for (const agent of this.agents.values()) {
      const handlesKey = agent.handles.some(
        (h) => h.queue === key.queue && h.market === key.market && h.language === key.language,
      );
      if (!handlesKey) continue;
      const cap = agent.concurrency_cap ?? this.config.agent_concurrency[key.queue];
      const active = this.support
        .ticketsOfAgent(agent.id)
        .filter((t) => OPEN_TICKET_STATES.has(t.state)).length;
      if (active >= cap) continue; // at cap this tick: skipped, rotation continues
      out.push(agent);
    }
    return out;
  }

  private caseOf(t: Ticket) {
    const c = this.support.getCase(t.case_ref);
    if (!c) throw new RoutingError(`case ${t.case_ref} missing for ticket ${t.id}`);
    return c;
  }
}

// ordering helper for callers feeding the router: age-only priority
// (spec: priority is age-based; nothing else is a ranking input).
export function byPriority(
  support: SupportService,
  now: string,
): (a: string, b: string) => number {
  return (a, b) => support.priorityOf(a, now) - support.priorityOf(b, now);
}
