"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.BadFaithRegistry = exports.RegistryError = void 0;
const events_1 = require("./events");
// the bad-faith claimant registry (§12): policy-gated, never
// automatic. entries are added by signed human action citing a
// policy paragraph; no event path in the claim lifecycle can
// create one (structural: only this module writes registry
// entries, and its only writers require a signature + citation).
// entries tighten per-day rate limits (config) and surface a
// reviewer chip; they never block filing outright and never touch
// fees, trust, or ranking.
class RegistryError extends Error {
}
exports.RegistryError = RegistryError;
class BadFaithRegistry {
    counter = 0;
    entries = new Map();
    byHash = new Map();
    log = new events_1.EventLog();
    add(contactHash, policyCitation, signedBy, signature, now) {
        if (!signature?.trim())
            throw new RegistryError("a registry entry requires a human signature");
        if (!policyCitation?.trim())
            throw new RegistryError("a registry entry must cite the policy paragraph");
        const existing = this.byHash.get(contactHash);
        if (existing && !this.entries.has(existing.id)) {
            // re-adding after removal is a new entry, the removal stays
        }
        else if (existing) {
            throw new RegistryError(`contact hash ${contactHash.slice(0, 8)} is already registered`);
        }
        this.counter += 1;
        const entry = (0, events_1.deepFreeze)({
            id: `reg_${this.counter}`,
            contact_hash: contactHash,
            policy_citation: policyCitation,
            signed_by: signedBy,
            signature,
            added_at: now,
        });
        this.entries.set(entry.id, entry);
        this.byHash.set(contactHash, entry);
        this.log.append(entry.id, (seq) => ({
            seq,
            type: "registry_entry_added",
            entry_id: entry.id,
            contact_hash: contactHash,
            policy_citation: policyCitation,
            signed_by: signedBy,
            created_at: now,
        }));
        return entry;
    }
    // the contest path: removal is a first-class logged event
    remove(entryId, reviewerId, signature, now) {
        if (!signature?.trim())
            throw new RegistryError("a registry removal requires a human signature");
        const entry = this.entries.get(entryId);
        if (!entry)
            throw new RegistryError(`unknown registry entry: ${entryId}`);
        this.entries.delete(entryId);
        this.byHash.delete(entry.contact_hash);
        this.log.append(entryId, (seq) => ({
            seq,
            type: "registry_entry_removed",
            entry_id: entryId,
            contact_hash: entry.contact_hash,
            policy_citation: entry.policy_citation,
            signed_by: reviewerId,
            created_at: now,
        }));
        return entry;
    }
    lookup(contactHash) {
        const e = this.byHash.get(contactHash);
        return e && this.entries.has(e.id) ? e : undefined;
    }
    size() {
        return this.entries.size;
    }
}
exports.BadFaithRegistry = BadFaithRegistry;
