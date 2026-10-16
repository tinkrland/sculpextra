import type { ContactOutcome, ContactInput, OpenedCase, SupportService } from "./support";
import type { ContactReceipt } from "./types";
import { ReceiptBook } from "./receipts";
import { isTicketableKind, kindOf } from "./taxonomy";

// the intake facade: the fork before the queues (owner ruling
// 2026-10-16). kind is classified at intake; only support issues and
// questions ever reach the case/ticket machinery. bug reports,
// vulnerability disclosures, and feature requests fork to the
// receipt book - never a case, never a ticket, never a queue input.
// gates run identically for all kinds; kind never softens a gate.

export class IntakeError extends Error {}

export type IntakeOutcome =
  | ContactOutcome
  | { kind: "receipt"; receipt: ContactReceipt };

export class ContactIntake {
  constructor(
    private readonly support: SupportService,
    private readonly receipts: ReceiptBook,
  ) {}

  public receiveContact(input: ContactInput, now: string): IntakeOutcome {
    const kind = kindOf(input);
    if (isTicketableKind(kind)) {
      return this.support.receiveContact(input, now);
    }
    // non-ticket kinds carry their declared kind onto the receipt;
    // the receipt book fails loudly if anything else arrives here.
    return { kind: "receipt", receipt: this.receipts.file({ ...input, kind }, now) };
  }

  // the deflection path is for ticketable kinds only: a bug report
  // or a disclosure has no deflection screen - it has an ack and a
  // routing signal.
  public openCase(input: ContactInput, now: string): OpenedCase {
    if (!isTicketableKind(kindOf(input))) {
      throw new IntakeError(
        `contact kind "${kindOf(input)}" is not ticketable: receipts never open cases`,
      );
    }
    return this.support.openCase(input, now);
  }
}
