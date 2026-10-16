import type { AbuseSignal, ModerationPort } from "./types";
import type { SupportService } from "./support";

// the phase 4 abuse signal path. a report filed from a ticket routes
// to the moderation layer as a signal, never a verdict: support
// never enforces, so filing changes nothing about the ticket - no
// state move, no queue move, no priority effect. the report event
// links the moderation ref for later joining.

export class AbuseReportError extends Error {}

export class AbuseReporter {
  private counter = 0;

  constructor(
    private readonly support: SupportService,
    private readonly moderation: ModerationPort,
  ) {}

  // file a signal from a ticket. evidence refs must be present and
  // non-empty: a signal without evidence is noise, and moderation
  // needs to join back to the exact events.
  public file(
    ticketId: string,
    agentId: string,
    input: { category: string; evidence_refs: readonly string[] },
    now: string,
  ): { report_id: string; moderation_ref: string } {
    const t = this.support.getTicket(ticketId);
    if (!t) throw new AbuseReportError(`unknown ticket: ${ticketId}`);
    if (!input.category.trim()) throw new AbuseReportError("abuse report needs a category");
    if (input.evidence_refs.length === 0) {
      throw new AbuseReportError("abuse reports need evidence refs to join back to");
    }
    const c = this.support.getCase(t.case_ref);
    if (!c) throw new AbuseReportError(`case ${t.case_ref} missing for ticket ${t.id}`);

    this.counter += 1;
    const reportId = `abuse_${this.counter}`;
    const signal: AbuseSignal = {
      source_ticket: ticketId,
      account_family: c.account_family,
      account_ref: c.account_ref,
      category: input.category,
      evidence_refs: [...input.evidence_refs],
      reported_at: now,
    };
    const moderationRef = this.moderation.fileSignal(signal);
    this.support.logAbuseReportFiled(ticketId, agentId, {
      report_id: reportId,
      category: input.category,
      evidence_refs: signal.evidence_refs,
      moderation_ref: moderationRef,
    }, now);
    return { report_id: reportId, moderation_ref: moderationRef };
  }
}
