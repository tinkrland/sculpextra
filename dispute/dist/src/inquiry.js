"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.InquiryService = exports.InquiryError = void 0;
const events_1 = require("./events");
const events_2 = require("./events");
// the question fork (§5.1): a question is not a claim, the same way
// the ticketing spec keeps buyer-to-be questions out of the buyer
// issue queue. the inquiry path borrows the deflection machinery
// over public content; there is exactly one public-questions queue
// and it never produces claim records, provisional measures,
// decisions, or registry entries. contact is optional until a
// human reply is needed; no account is ever required.
class InquiryError extends Error {
}
exports.InquiryError = InquiryError;
const claimantActor = (ref) => ({ kind: "claimant", ref });
const system = { kind: "system" };
class InquiryService {
    config;
    content;
    counter = 0;
    inquiries = new Map();
    log;
    constructor(config, content) {
        this.config = config;
        this.content = content;
        this.log = new events_1.EventLog();
    }
    // an asker lands on the fork and asks. the deflection machinery
    // searches the public content the platform already maintains;
    // a deflected asker never reaches the human queue.
    askQuestion(input, now) {
        if (!input.question_text?.trim())
            throw new InquiryError("a question needs text");
        this.counter += 1;
        const id = `inquiry_${this.counter}`;
        const inquiry = (0, events_2.deepFreeze)({
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
                const valid = lookup.answers.filter((a) => this.config.content_link_hosts.some((h) => a.url.startsWith(`https://${h}/`)));
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
    answerQuestion(inquiryId, humanReply, answererId, now, handoff) {
        const q = this.mustInquiry(inquiryId);
        if (q.state !== "new")
            throw new InquiryError(`inquiry ${inquiryId} is ${q.state}, not answerable`);
        if (!humanReply.trim())
            throw new InquiryError("answer needs text");
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
    openQuestions() {
        return Object.freeze([...this.inquiries.values()].filter((q) => q.state === "new"));
    }
    getInquiry(id) {
        return this.inquiries.get(id);
    }
    eventsOf(id) {
        return this.log.list(id);
    }
    ids() {
        return Object.freeze([...this.inquiries.keys()]);
    }
    close(id, now) {
        const q = this.mustInquiry(id);
        this.log.append(id, (seq) => ({
            inquiry_ref: id,
            seq,
            type: "question_closed",
            actor: system,
            payload: {},
            created_at: now,
        }));
        const closed = (0, events_2.deepFreeze)(structuredClone({ ...q, state: "closed" }));
        this.inquiries.set(id, closed);
        return closed;
    }
    mustInquiry(id) {
        const q = this.inquiries.get(id);
        if (!q)
            throw new InquiryError(`unknown inquiry: ${id}`);
        return q;
    }
}
exports.InquiryService = InquiryService;
