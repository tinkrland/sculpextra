import type { ClaimInput } from "./types";
import type { DisputeConfig } from "./config";
import type { DisputeService, FileOutcome } from "./claims";
import type { InquiryOutcome, InquiryService } from "./inquiry";

// the entry fork (§5.1): a question is not a claim. the public
// entry forks before any form field; nothing on the inquiry path
// can produce a claim record, a provisional measure, a decision,
// or a registry entry (structural: this facade simply never
// forwards inquiry traffic into the claim service).

export class EntryForkError extends Error {}

export class DisputeEntry {
  constructor(
    private readonly config: DisputeConfig,
    private readonly claims: DisputeService,
    private readonly inquiries: InquiryService,
  ) {}

  public askQuestion(
    input: { question_text: string; locale: string; market: string; contact?: string },
    now: string,
  ): InquiryOutcome {
    return this.inquiries.askQuestion(input, now);
  }

  public fileClaim(input: ClaimInput, now: string): FileOutcome {
    return this.claims.fileClaim(input, now);
  }

  // the educational screen lives before the form, never hides it
  public claimEntryScreen() {
    return this.claims.educationalScreen();
  }
}
