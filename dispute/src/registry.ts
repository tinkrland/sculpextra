import type { RegistryEntry } from "./types";
import { EventLog, deepFreeze } from "./events";

// the bad-faith claimant registry (§12): policy-gated, never
// automatic. entries are added by signed human action citing a
// policy paragraph; no event path in the claim lifecycle can
// create one (structural: only this module writes registry
// entries, and its only writers require a signature + citation).
// entries tighten per-day rate limits (config) and surface a
// reviewer chip; they never block filing outright and never touch
// fees, trust, or ranking.

export class RegistryError extends Error {}

export interface RegistryEvent {
  seq: number;
  type: "registry_entry_added" | "registry_entry_removed";
  entry_id: string;
  contact_hash: string;
  policy_citation: string;
  signed_by: string;
  created_at: string;
}

export class BadFaithRegistry {
  private counter = 0;
  private readonly entries = new Map<string, RegistryEntry>();
  private readonly byHash = new Map<string, RegistryEntry>();
  private readonly log = new EventLog<RegistryEvent>();

  public add(
    contactHash: string,
    policyCitation: string,
    signedBy: string,
    signature: string,
    now: string,
  ): RegistryEntry {
    if (!signature?.trim()) throw new RegistryError("a registry entry requires a human signature");
    if (!policyCitation?.trim()) throw new RegistryError("a registry entry must cite the policy paragraph");
    const existing = this.byHash.get(contactHash);
    if (existing && !this.entries.has(existing.id)) {
      // re-adding after removal is a new entry, the removal stays
    } else if (existing) {
      throw new RegistryError(`contact hash ${contactHash.slice(0, 8)} is already registered`);
    }
    this.counter += 1;
    const entry: RegistryEntry = deepFreeze({
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
  public remove(entryId: string, reviewerId: string, signature: string, now: string): RegistryEntry {
    if (!signature?.trim()) throw new RegistryError("a registry removal requires a human signature");
    const entry = this.entries.get(entryId);
    if (!entry) throw new RegistryError(`unknown registry entry: ${entryId}`);
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

  public lookup(contactHash: string): RegistryEntry | undefined {
    const e = this.byHash.get(contactHash);
    return e && this.entries.has(e.id) ? e : undefined;
  }

  public size(): number {
    return this.entries.size;
  }
}
