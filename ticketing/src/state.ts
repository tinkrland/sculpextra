import type { TicketState } from "./types";

// strict per the spec diagram:
// new -> triaged -> in_progress -> waiting_on_user -> resolved -> closed
// waiting_on_user loops back to in_progress when the user replies.
// resolved is only reachable from waiting_on_user: an agent answers
// before resolving. close is a human action, never automatic, and
// waiting_on_user tickets never auto-resolve. nothing here runs on a
// timer; time-based behavior lives with the caller.

const TRANSITIONS: Readonly<Record<TicketState, readonly TicketState[]>> = {
  new: ["triaged"],
  triaged: ["in_progress"],
  in_progress: ["waiting_on_user"],
  waiting_on_user: ["in_progress", "resolved"],
  resolved: ["closed"],
  closed: [],
};

export class IllegalTransitionError extends Error {}

export function canTransition(from: TicketState, to: TicketState): boolean {
  return (TRANSITIONS[from] as readonly string[]).includes(to);
}

export function assertTransition(from: TicketState, to: TicketState): void {
  if (!canTransition(from, to)) {
    throw new IllegalTransitionError(`illegal transition ${from} -> ${to}`);
  }
}

// reopen within 14 days of close (spec). inclusive boundary.
export const REOPEN_WINDOW_DAYS = 14;

export function daysBetween(from: string, to: string): number {
  const a = Date.parse(from);
  const b = Date.parse(to);
  if (Number.isNaN(a) || Number.isNaN(b)) {
    throw new Error("daysBetween needs two iso 8601 timestamps");
  }
  return (b - a) / 86_400_000;
}

export function canReopen(closedAt: string, now: string): boolean {
  return daysBetween(closedAt, now) <= REOPEN_WINDOW_DAYS;
}
