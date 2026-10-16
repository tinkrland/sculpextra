import type {
  AccountFamily,
  Case,
  DeflectionScreen,
  LookupRequest,
  RetellDbPort,
  Ticket,
} from "./types";
import type { ContactInput, HumanOutcome } from "./support";
import type { CoreConfig } from "./config";
import { DEFAULT_CONFIG } from "./config";
import { SupportService } from "./support";

// the phase 2 intake: every contact opens a case, then deflection is
// attempted in order (spec: intake) - retelldb lookup first, then the
// deflection screen with the suggested answers and deep links. the
// user either marks it resolved or clicks "still need a human"
// exactly once, and that click creates the ticket. straight-to-
// ticket mode (no port, deflection disabled, empty lookup, or lookup
// failure) tickets immediately instead of showing an empty screen.

export type DeflectionOutcome =
  | { kind: "rejected"; reason: string }
  | { kind: "merged"; case: Case; ticket: Ticket }
  | { kind: "ticketed"; case: Case; ticket: Ticket; rate_limited_chip: boolean }
  | { kind: "deflection"; case: Case; screen: DeflectionScreen; rate_limited_chip: boolean };

export class DeflectingSupportService {
  private readonly support: SupportService;
  private readonly retell: RetellDbPort | null;

  constructor(
    support?: SupportService,
    retell: RetellDbPort | null = null,
    private readonly config: CoreConfig = DEFAULT_CONFIG,
  ) {
    // one config drives both layers: the deflection knobs here and
    // the rate limits / windows of the ticketing core.
    this.support = support ?? new SupportService(config);
    this.retell = retell;
  }

  // expose read paths for callers/tests; the underlying service
  // remains the single system of record.
  public get inner(): SupportService {
    return this.support;
  }

  public receiveContact(input: ContactInput, now: string): DeflectionOutcome {
    const opened = this.support.openCase(input, now);
    if (opened.kind === "rejected") return opened;
    if (opened.kind === "merged") {
      return { kind: "merged", case: opened.case, ticket: opened.ticket };
    }
    const caseId = opened.case.id;

    // straight-to-ticket mode until deflection content exists:
    // disabled config or no port never shows a screen.
    if (!this.config.deflection.enabled || this.retell === null) {
      return this.ticketNow(caseId, now);
    }

    const topK = this.config.deflection.top_k;
    let lookup;
    try {
      lookup = this.retell.lookup({
        text: `${input.subject}

${input.body}`.trim(),
        market: input.market,
        language: input.language,
        audience_hint: input.account_family,
        top_k: topK,
      });
    } catch (error) {
      // lookup availability never blocks a human
      const message = error instanceof Error ? error.message : "lookup error";
      this.support.logLookupFailure(caseId, message, now);
      return this.ticketNow(caseId, now);
    }

    this.support.logLookup(caseId, lookup, now);
    if (lookup.answers.length === 0) {
      // no content to offer: no empty screen, no extra click
      return this.ticketNow(caseId, now);
    }

    const screen = this.support.offerDeflection(caseId, now);
    return {
      kind: "deflection",
      case: opened.case,
      screen,
      rate_limited_chip: opened.rate_limited_chip,
    };
  }

  // the user marked the offered answers as resolving the case.
  public markResolved(caseId: string, now: string): Case {
    return this.support.acceptDeflection(caseId, now);
  }

  // the single "still need a human" click: one click, no second
  // confirm step, the ticket exists right after it.
  public stillNeedHuman(caseId: string, now: string): HumanOutcome {
    return this.support.requestHuman(caseId, now);
  }

  private ticketNow(
    caseId: string,
    now: string,
  ): { kind: "ticketed"; case: Case; ticket: Ticket; rate_limited_chip: boolean } {
    const out = this.support.requestHuman(caseId, now);
    if (out.kind !== "ticketed") {
      throw new Error(`expected a new ticket for ${caseId}, got ${out.kind}`);
    }
    return out;
  }
}
