"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DisputeEntry = exports.EntryForkError = void 0;
// the entry fork (§5.1): a question is not a claim. the public
// entry forks before any form field; nothing on the inquiry path
// can produce a claim record, a provisional measure, a decision,
// or a registry entry (structural: this facade simply never
// forwards inquiry traffic into the claim service).
class EntryForkError extends Error {
}
exports.EntryForkError = EntryForkError;
class DisputeEntry {
    config;
    claims;
    inquiries;
    constructor(config, claims, inquiries) {
        this.config = config;
        this.claims = claims;
        this.inquiries = inquiries;
    }
    askQuestion(input, now) {
        return this.inquiries.askQuestion(input, now);
    }
    fileClaim(input, now) {
        return this.claims.fileClaim(input, now);
    }
    // the educational screen lives before the form, never hides it
    claimEntryScreen() {
        return this.claims.educationalScreen();
    }
}
exports.DisputeEntry = DisputeEntry;
