import type { Inquiry, PublicContentPort } from "./types";
import type { DisputeConfig } from "./config";
import { EventLog, Actor } from "./events";
import { deepFreeze } from "./events";

// the question fork (§5.1): a question is not a claim, the same way
// the ticketing spec keeps buyer-to-be questions out of the buyer
// issue queue. the inquiry path borrows the deflection machinery
// over public content; there is exactly one public-questions queue
// and it never produces claim records, provisional measures,
// decisions, or registry entries. contact is optional until a
// human reply is needed; no account is ever required.

export class InquiryError extends Error {}

const claimantActor = (ref: string): Actor => ({ kind: "claimant", ref });
const system: Actor = { kind: "system" };

export interface InquiryOutcome {
  inquiry: Inquiry;
  deflected: boolean;
}

export class InquiryService {
  private counter = 0;
  private readonly inquiries = new Map<string, Inquiry>();
  private readonly log: EventLog<import("./events").InquiryEvent>;

  constructor(
    private readonly config: DisputeConfig,
    private readonly content: PublicContentPort | null,
  ) {
    this.log = new EventLog();
  }

  // an asker lands on the fork and asks. the deflection machinery
  // searches the public content the platform already maintains;
  // a deflected asker never reaches the human queue.
  public askQuestion(
    input: { question_text: string; locale: string; market: string; contact?: string },
    now: string,
  ): InquiryOutcome {
    if (!input.question_text?.trim()) throw new InquiryError("a question needs text");
    this.counter += 1;
    const id = `inquiry_${this.counter}`;
    const inquiry: Inquiry = deepFreeze({
      id,
      question_text: input.question_text,
      locale: input.locale,
      market: input.market,
      contact: input.contact ?? null,
      state: "new",
      created_at: now,
    });
    this.inquiries.set(id, inquiry);
    this.log.append(id, (seq) => ({
      inquiry_ref: id,
      seq,
      type: "question_asked",
      actor: claimantActor(id),
      payload: { locale: input.locale, market: input.market, has_contact: Boolean(input.contact) },
      created_at: now,
    }));

    if (this.content) {
      const lookup = this.content.lookup(input.question_text);
      if (lookup.answers.length > 0) {
        // link-validation discipline: every canned answer references
        // public content by verified link
        const valid = lookup.answers.filter((a) =>
          this.config.content_link_hosts.some((h) => a.url.startsWith(`https://${h}/`)),
        );
        if (valid.length > 0) {
          this.log.append(id, (seq) => ({
            inquiry_ref: id,
            seq,
            type: "question_deflected",
            actor: system,
            payload: {
              answers: valid.map((a) => ({ doc_id: a.doc_id, url: a.url })),
              engine_path: lookup.engine_path,
            },
            created_at: now,
          }));
          return { inquiry: this.close(id, now), deflected: true };
        }
      }
    }
    // unresolved: the single public-questions queue (unanswered
    // inquiries a human answers through the provided channel)
    return { inquiry, deflected: false };
  }

  // a human answers through the contact channel the asker provided.
  // a question that is really a claim gets the claim form link in
  // the answer; nothing auto-files.
  public answerQuestion(
    inquiryId: string,
    humanReply: string,
    answererId: string,
    now: string,
    handoff?: { claim_form: true },
  ): Inquiry {
    const q = this.mustInquiry(inquiryId);
    if (q.state !== "new") throw new InquiryError(`inquiry ${inquiryId} is ${q.state}, not answerable`);
    if (!humanReply.trim()) throw new InquiryError("answer needs text");
    this.log.append(inquiryId, (seq) => ({
      inquiry_ref: inquiryId,
      seq,
      type: "question_answered",
      actor: { kind: "reviewer", id: answererId },
      payload: {
        reply: humanReply,
        // question -> claim direction of the fork legibility
        // measurement (§17): a referral is a reclassification signal
        referred_to_claim_form: Boolean(handoff?.claim_form),
      },
      created_at: now,
    }));
    return this.close(inquiryId, now);
  }

  public openQuestions(): readonly Inquiry[] {
    return Object.freeze(
      [...this.inquiries.values()].filter((q) => q.state === "new"),
    );
  }

  public getInquiry(id: string): Inquiry | undefined {
    return this.inquiries.get(id);
  }

  public eventsOf(id: string) {
    return this.log.list(id);
  }

  public ids(): readonly string[] {
    return Object.freeze([...this.inquiries.keys()]);
  }

  private close(id: string, now: string): Inquiry {
    const q = this.mustInquiry(id);
    this.log.append(id, (seq) => ({
      inquiry_ref: id,
      seq,
      type: "question_closed",
      actor: system,
      payload: {},
      created_at: now,
    }));
    const closed = deepFreeze(structuredClone({ ...q, state: "closed" as const }));
    this.inquiries.set(id, closed);
    return closed;
  }

  private mustInquiry(id: string): Inquiry {
    const q = this.inquiries.get(id);
    if (!q) throw new InquiryError(`unknown inquiry: ${id}`);
    return q;
  }
}
