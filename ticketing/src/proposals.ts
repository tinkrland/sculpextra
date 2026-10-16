import type { MoneyProposal, PaymentsPort, ProposalResult, Ticket } from "./types";
import type { SupportService } from "./support";
import { deepFreeze } from "./events";

// the phase 4 proposal bridge. support proposes refunds and payout
// investigations; the payments system executes (or rejects) and the
// result posts back as a proposal_result ticket event. the workspace
// has no money-moving controls, and refunds stay per-order - never
// cart-wide - because proposals carry order refs by construction,
// validated as a subset of the ticket's orders.

export class ProposalError extends Error {}

const OPEN_STATES: ReadonlySet<Ticket["state"]> = new Set([
  "new",
  "triaged",
  "in_progress",
  "waiting_on_user",
]);

export class ProposalBridge {
  private counter = 0;
  private readonly proposals = new Map<string, MoneyProposal>();

  constructor(
    private readonly support: SupportService,
    private readonly payments: PaymentsPort,
  ) {}

  // propose a per-order refund. order refs are mandatory and must
  // belong to the ticket; amounts are positive integer cents.
  public proposeRefund(
    ticketId: string,
    agentId: string,
    input: { order_refs: readonly string[]; amount_cents: number; reason: string },
    now: string,
  ): MoneyProposal {
    const t = this.mustOpen(ticketId);
    if (!input.reason.trim()) throw new ProposalError("refund proposal needs a reason");
    if (input.order_refs.length === 0) {
      throw new ProposalError("refund proposals carry order refs by construction");
    }
    const ticketOrders = new Set(t.order_refs);
    for (const ref of input.order_refs) {
      if (!ticketOrders.has(ref)) {
        throw new ProposalError(`order ${ref} is not on ticket ${ticketId}: refunds stay per-order`);
      }
    }
    if (!Number.isInteger(input.amount_cents) || input.amount_cents <= 0) {
      throw new ProposalError("refund amount must be positive integer cents");
    }
    const proposal = this.store(ticketId, {
      kind: "refund",
      order_refs: [...input.order_refs],
      amount_cents: input.amount_cents,
      reason: input.reason,
    }, now);
    this.support.logProposalCreated(ticketId, agentId, {
      id: proposal.id,
      kind: proposal.kind,
      order_refs: proposal.order_refs,
      amount_cents: proposal.amount_cents,
      reason: proposal.reason,
    }, now);
    this.payments.submitRefund(proposal);
    return proposal;
  }

  // propose a payout investigation. payout issues live in the
  // creator_support queue; the proposal carries no amount.
  public proposePayoutInvestigation(
    ticketId: string,
    agentId: string,
    input: { reason: string },
    now: string,
  ): MoneyProposal {
    const t = this.mustOpen(ticketId);
    if (t.queue !== "creator_support") {
      throw new ProposalError(`payout investigations live in creator_support, not ${t.queue}`);
    }
    if (!input.reason.trim()) throw new ProposalError("payout investigation needs a reason");
    const proposal = this.store(ticketId, {
      kind: "payout_investigation",
      order_refs: [],
      amount_cents: 0,
      reason: input.reason,
    }, now);
    this.support.logProposalCreated(ticketId, agentId, {
      id: proposal.id,
      kind: proposal.kind,
      order_refs: proposal.order_refs,
      amount_cents: proposal.amount_cents,
      reason: proposal.reason,
    }, now);
    this.payments.submitPayoutInvestigation(proposal);
    return proposal;
  }

  // the payments system posts back: executed or rejected. the result
  // lands on the same ticket chain as the proposal.
  public recordProposalResult(proposalId: string, result: ProposalResult, now: string): MoneyProposal {
    const proposal = this.proposals.get(proposalId);
    if (!proposal) throw new ProposalError(`unknown proposal: ${proposalId}`);
    if (proposal.status !== "proposed") {
      throw new ProposalError(`proposal ${proposalId} already settled as ${proposal.status}`);
    }
    if (result.status === "executed" && proposal.kind === "refund" && !result.payment_ref) {
      throw new ProposalError("executed refunds carry a payment reference");
    }
    this.support.logProposalResult(proposal.ticket_ref, proposalId, {
      status: result.status,
      by: result.by,
      payment_ref: result.payment_ref,
      detail: result.detail,
    }, now);
    const settled = deepFreeze(structuredClone({ ...proposal, status: result.status }));
    this.proposals.set(proposalId, settled);
    return settled;
  }

  public proposal(id: string): MoneyProposal | undefined {
    return this.proposals.get(id);
  }

  public proposalsOf(ticketId: string): readonly MoneyProposal[] {
    return Object.freeze(
      [...this.proposals.values()].filter((p) => p.ticket_ref === ticketId),
    );
  }

  private store(
    ticketId: string,
    body: { kind: MoneyProposal["kind"]; order_refs: string[]; amount_cents: number; reason: string },
    now: string,
  ): MoneyProposal {
    this.counter += 1;
    const proposal: MoneyProposal = deepFreeze({
      id: `prop_${this.counter}`,
      ticket_ref: ticketId,
      kind: body.kind,
      order_refs: body.order_refs,
      amount_cents: body.amount_cents,
      reason: body.reason,
      status: "proposed",
      created_at: now,
    });
    this.proposals.set(proposal.id, proposal);
    return proposal;
  }

  private mustOpen(ticketId: string): Ticket {
    const t = this.support.getTicket(ticketId);
    if (!t) throw new ProposalError(`unknown ticket: ${ticketId}`);
    if (!OPEN_STATES.has(t.state)) {
      throw new ProposalError(`ticket ${ticketId} is ${t.state}: proposals need an open ticket`);
    }
    return t;
  }
}
